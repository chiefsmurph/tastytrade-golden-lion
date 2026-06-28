import {
  getConservativeSpendableFunds,
  getAccountBalanceNumber,
  getEffectiveTotalCapital,
  getSpendableFundsForAccountType,
} from "~/core/account-balance";
import { getAccountMarginOrCash } from "~/core/default-account";
import tastytradeApi from "~/core/tastytrade-client";
import { getPositionEvaluations } from "../get-position-evaluations";
import { PositionGroupEvaluation } from "../evaluate-position";
import {
  evaluateOptionHealthForTargetDTE,
  getOptionHealthForSymbol,
  getTopOptionCandidateForSymbol,
  getMarginTargetCallDelta,
} from "../get-option-candidates-for-symbol";
import {
  getGroupMarketValue,
  inferOptionSide,
  normalizeInstrumentType,
  OrderPayload,
  roundOrderPrice,
} from "./order-utils";
import { ExecutionTargets } from "../evaluate-trading-strategy";
import { GLOBAL_MAX_BUY_EXPOSURE_PCT } from "../risk-limits";
import type { TastytradePlacedOrderResponse } from "~/core/types";

const DEFAULT_CONTRACT_MULTIPLIER = 100;

export type AllocationRoute = "bid" | "mid" | "ask";

export interface AllocationRouteResult {
  estimatedOrderValue: number;
  limitPrice: number;
  orderResponse?: TastytradePlacedOrderResponse;
  placedOrder: boolean;
  quantity: number;
  route: AllocationRoute;
  skippedReason?: string;
  weight: number;
}

export interface AllocationExecutionResult {
  accountNumber: string;
  action: "MANAGE_ALLOCATION";
  candidateSymbol?: string;
  candidateDTE?: number;
  estimatedOrderValue?: number;
  maxDTE?: number;
  minDTE?: number;
  orderResponses?: TastytradePlacedOrderResponse[];
  placedOrder: boolean;
  preferredDTE?: number;
  quantity?: number;
  routeOrders: AllocationRouteResult[];
  skippedReason?: string;
  underlyingSymbol: string;
  usedDteFallback?: boolean;
}

export interface AllocationBudget {
  buyingPowerRemaining: number;
  portfolioExposure: number;
  totalCapital: number;
}

interface ManageAllocationOptions {
  dryRun?: boolean;
}

function getCandidateSide(evaluation: PositionGroupEvaluation): "call" | "put" {
  const inferredSides = evaluation.positions
    .map((position) => inferOptionSide(position.symbol))
    .filter((side): side is "call" | "put" => side != null);

  return inferredSides[0] ?? "call";
}

function getMidpointPrice(bid: number, ask: number): number {
  if (bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }

  return ask || bid;
}

export function buildRouteOrders(
  bid: number,
  ask: number,
  targets: Pick<ExecutionTargets, "bidWeight" | "midWeight" | "askWeight">,
): AllocationRouteResult[] {
  const midpoint = getMidpointPrice(bid, ask);

  return [
    {
      estimatedOrderValue: 0,
      limitPrice: bid > 0 ? bid : midpoint,
      placedOrder: false,
      quantity: 0,
      route: "bid" as const,
      weight: targets.bidWeight,
    },
    {
      estimatedOrderValue: 0,
      limitPrice: midpoint,
      placedOrder: false,
      quantity: 0,
      route: "mid" as const,
      weight: targets.midWeight,
    },
    {
      estimatedOrderValue: 0,
      limitPrice: ask > 0 ? ask : midpoint,
      placedOrder: false,
      quantity: 0,
      route: "ask" as const,
      weight: targets.askWeight,
    },
  ].filter((routeOrder) => routeOrder.weight > 0 && routeOrder.limitPrice > 0);
}

export function allocateContractsByWeight(
  routeOrders: AllocationRouteResult[],
  availableCapital: number,
): AllocationRouteResult[] {
  const totalWeight = routeOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.weight,
    0,
  );

  if (totalWeight <= 0 || availableCapital <= 0) {
    return routeOrders;
  }

  const targets = routeOrders.map((routeOrder) => ({
    contractCost: routeOrder.limitPrice * DEFAULT_CONTRACT_MULTIPLIER,
    routeOrder,
    targetSpend: availableCapital * (routeOrder.weight / totalWeight),
  }));

  for (const target of targets) {
    if (target.contractCost <= 0) {
      continue;
    }

    target.routeOrder.quantity = Math.floor(
      target.targetSpend / target.contractCost,
    );
    target.routeOrder.estimatedOrderValue =
      target.routeOrder.quantity * target.contractCost;
  }

  let remainingCapital =
    availableCapital -
    targets.reduce(
      (sum, target) => sum + target.routeOrder.estimatedOrderValue,
      0,
    );

  let iterationCount = 0;
  while (remainingCapital > 0 && iterationCount < 100) {
    iterationCount += 1;

    const affordableTargets = targets.filter(
      (target) => target.contractCost > 0 && target.contractCost <= remainingCapital,
    );
    if (affordableTargets.length === 0) {
      break;
    }

    affordableTargets.sort((left, right) => {
      const leftShortfall = left.targetSpend - left.routeOrder.estimatedOrderValue;
      const rightShortfall =
        right.targetSpend - right.routeOrder.estimatedOrderValue;

      if (rightShortfall !== leftShortfall) {
        return rightShortfall - leftShortfall;
      }

      return left.contractCost - right.contractCost;
    });

    const nextTarget = affordableTargets[0];
    nextTarget.routeOrder.quantity += 1;
    nextTarget.routeOrder.estimatedOrderValue += nextTarget.contractCost;
    remainingCapital -= nextTarget.contractCost;
  }

  return routeOrders;
}

const TICK_UP_CHASE_ENABLED = true;
const TICK_UP_INTERVAL_MS = 30_000; // 30 seconds
const MAX_TICK_UPS = 10; // Maximum number of ticks

function calculateDynamicTickSize(midPrice: number, askPrice: number): number {
  // If we don't have a valid ask, fall back to SEC minimum tick rules
  if (askPrice <= midPrice || !Number.isFinite(askPrice)) {
    return midPrice < 3.0 ? 0.05 : 0.10;
  }

  // Calculate the spread gap between mid and ask
  const spreadGap = askPrice - midPrice;

  // Divide the spread into equal increments up to MAX_TICK_UPS
  // This allows aggressive chasing on wide spreads and conservative on tight spreads
  const tickSize = spreadGap / MAX_TICK_UPS;

  // But also respect SEC minimums: don't go below them
  const minTickSize = midPrice < 3.0 ? 0.05 : 0.10;
  
  return Math.max(tickSize, minTickSize);
}

async function waitForOrderFill(
  accountNumber: string,
  orderId: string,
  timeoutMs: number,
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const orders = await tastytradeApi.orderService.getOrders(accountNumber);
      const order = orders.find((o) => o.id === orderId);
      
      if (!order) {
        // Order not found, might have been filled or cancelled
        return true;
      }
      
      if (order.status === "Filled" || order.status === "Partially Filled") {
        return true;
      }
      
      if (!order.status || !["Pending", "Open", "Pending Cancel"].includes(order.status)) {
        return false;
      }
    } catch (err) {
      // If we can't check status, assume it's still pending
    }
    
    await new Promise((res) => setTimeout(res, 1000));
  }
  
  return false;
}

async function cancelOrderById(
  accountNumber: string,
  orderId: string,
): Promise<boolean> {
  try {
    const numericOrderId = Number(orderId);
    if (!Number.isFinite(numericOrderId)) {
      return false;
    }
    await tastytradeApi.orderService.cancelOrder(accountNumber, numericOrderId);
    return true;
  } catch (err) {
    return false;
  }
}

export async function placeRouteOrders(
  accountNumber: string,
  candidateSymbol: string,
  routeOrders: AllocationRouteResult[],
  bidPrice: number = 0,
  askPrice: number = 0,
): Promise<AllocationRouteResult[]> {
  const placedOrders: AllocationRouteResult[] = [];

  for (const routeOrder of routeOrders) {
    if (routeOrder.quantity <= 0) {
      placedOrders.push({
        ...routeOrder,
        skippedReason: "allocated quantity rounded to zero",
      });
      continue;
    }

    // Determine mid and ask for spread-based tick calculation
    const midPrice = (bidPrice + askPrice) / 2 || routeOrder.limitPrice;
    const askCeiling = askPrice || routeOrder.limitPrice;

    let currentPrice = routeOrder.limitPrice;
    let orderId: string | undefined;
    let lastOrderResponse: TastytradePlacedOrderResponse | undefined;
    let tickCount = 0;

    while (tickCount <= MAX_TICK_UPS) {
      const order: OrderPayload = {
        source: "tastytrade-playground",
        "time-in-force": "Day",
        "order-type": "Limit",
        price: roundOrderPrice(currentPrice),
        "price-effect": "Debit",
        legs: [
          {
            action: "Buy to Open",
            symbol: candidateSymbol,
            quantity: routeOrder.quantity,
            "instrument-type": normalizeInstrumentType("Equity Option"),
          },
        ],
      };

      // If we have an existing order, cancel it first
      if (orderId && TICK_UP_CHASE_ENABLED && tickCount > 0) {
        const cancelled = await cancelOrderById(accountNumber, orderId);
        if (!cancelled) {
          // Can't confirm cancellation — stop chasing to avoid duplicate live orders
          break;
        }
      }

      // Place new order
      const orderResponse = await tastytradeApi.orderService.createOrder(
        accountNumber,
        order,
      );
      
      lastOrderResponse = orderResponse;
      orderId = orderResponse?.order?.id;

      if (!TICK_UP_CHASE_ENABLED || tickCount >= MAX_TICK_UPS) {
        // Not using tick-up chase, or reached max ticks
        break;
      }

      // Wait for 30 seconds to see if order fills
      const isFilled = orderId ? await waitForOrderFill(
        accountNumber,
        orderId,
        TICK_UP_INTERVAL_MS,
      ) : false;

      if (isFilled) {
        // Order filled, no need to tick up
        break;
      }

      // Order not filled, calculate dynamic tick based on spread
      const tickSize = calculateDynamicTickSize(midPrice, askCeiling);
      currentPrice = currentPrice + tickSize;
      tickCount += 1;

      // Don't exceed the ask ceiling
      if (currentPrice > askCeiling) {
        currentPrice = askCeiling;
      }
    }

    placedOrders.push({
      ...routeOrder,
      orderResponse: lastOrderResponse,
      placedOrder: true,
    });
  }

  return placedOrders;
}

export async function manageAllocationForGroup(
  accountNumber: string,
  evaluation: PositionGroupEvaluation,
  budget: AllocationBudget,
  groupsRemainingForAllocation = 1,
  options: ManageAllocationOptions = {},
): Promise<AllocationExecutionResult> {
  const targets = evaluation.executionTargets;

  if (!targets) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      placedOrder: false,
      routeOrders: [],
      skippedReason: "execution targets missing",
      underlyingSymbol: evaluation.underlyingSymbol,
    };
  }

  const targetExposure = budget.totalCapital * targets.targetAccountExposure;
  const exposureHeadroom = targetExposure - budget.portfolioExposure;
  const maxBuyAmountPerAction =
    budget.totalCapital * GLOBAL_MAX_BUY_EXPOSURE_PCT;
  const normalizedGroupsRemaining = Math.max(1, groupsRemainingForAllocation);
  const perGroupExposureHeadroom = exposureHeadroom / normalizedGroupsRemaining;
  const perGroupMaxBuyAmount = maxBuyAmountPerAction / normalizedGroupsRemaining;

  if (targets.targetAccountExposure <= 0) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      placedOrder: false,
      routeOrders: [],
      skippedReason: "target exposure is zero",
      underlyingSymbol: evaluation.underlyingSymbol,
    };
  }

  if (exposureHeadroom <= 0 || budget.buyingPowerRemaining <= 0) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      placedOrder: false,
      routeOrders: [],
      skippedReason: "no remaining exposure or buying power",
      underlyingSymbol: evaluation.underlyingSymbol,
    };
  }

  const optionSide = getCandidateSide(evaluation);
  const healthResult = await getOptionHealthForSymbol(
    evaluation.underlyingSymbol,
    optionSide,
  );
  const healthGate = evaluateOptionHealthForTargetDTE(
    healthResult.summary,
    targets.targetDTE,
  );

  console.log(
    JSON.stringify({
      scope: "manage-allocation-health-gate",
      underlyingSymbol: evaluation.underlyingSymbol,
      requestedSide: optionSide,
      targetDTE: targets.targetDTE,
      requiredHealthyTargets: healthGate.requiredHealthyTargets,
      missingRequiredTargets: healthGate.missingRequiredTargets,
      passed: healthGate.passed,
      healthSummary: healthResult.summary,
    }),
  );

  if (!healthGate.passed) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      placedOrder: false,
      routeOrders: [],
      skippedReason: `option health gate failed for target DTE ${targets.targetDTE}; missing healthy checkpoints: ${healthGate.missingRequiredTargets.join(", ")}`,
      underlyingSymbol: evaluation.underlyingSymbol,
    };
  }

  const accountMarginOrCash = await getAccountMarginOrCash(accountNumber);
  const candidate = await getTopOptionCandidateForSymbol(
    evaluation.underlyingSymbol,
    optionSide,
    targets.targetDTE,
    accountMarginOrCash === "margin"
      ? { strikeTarget: "otm", targetDelta: getMarginTargetCallDelta() }
      : undefined,
  );

  console.log(
    JSON.stringify({
      scope: "manage-allocation-candidate",
      underlyingSymbol: evaluation.underlyingSymbol,
      requestedSide: optionSide,
      targetDTE: targets.targetDTE,
      candidateDTE: candidate?.dte,
      minDTE: candidate?.minDTE,
      maxDTE: candidate?.maxDTE,
      preferredDTE: candidate?.preferredDTE,
      usedDteFallback: candidate?.usedDteFallback ?? false,
      symbol: candidate?.symbol ?? null,
    }),
  );

  if (!candidate?.symbol) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      candidateDTE: candidate?.dte,
      maxDTE: candidate?.maxDTE,
      minDTE: candidate?.minDTE,
      placedOrder: false,
      preferredDTE: candidate?.preferredDTE,
      routeOrders: [],
      skippedReason: "no option candidate found",
      underlyingSymbol: evaluation.underlyingSymbol,
      usedDteFallback: candidate?.usedDteFallback,
    };
  }

  const bidAsk = await tastytradeApi.johnsService.getBidAskForSymbol(
    candidate.quoteSymbol ?? candidate.streamerSymbol ?? candidate.symbol,
    3000,
  );
  const bid = bidAsk?.bid ?? 0;
  const ask = bidAsk?.ask ?? bid;
  const availableCapital = Math.min(
    Math.max(0, perGroupExposureHeadroom),
    Math.max(0, perGroupMaxBuyAmount),
    budget.buyingPowerRemaining,
  );
  const routeOrders = allocateContractsByWeight(
    buildRouteOrders(bid, ask, targets),
    availableCapital,
  );

  if (routeOrders.length === 0) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      candidateDTE: candidate.dte,
      maxDTE: candidate.maxDTE,
      minDTE: candidate.minDTE,
      placedOrder: false,
      preferredDTE: candidate.preferredDTE,
      routeOrders: [],
      skippedReason: "candidate quote unavailable",
      underlyingSymbol: evaluation.underlyingSymbol,
      usedDteFallback: candidate.usedDteFallback,
    };
  }

  const totalQuantity = routeOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.quantity,
    0,
  );

  if (totalQuantity < 1) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      candidateSymbol: candidate.symbol,
      candidateDTE: candidate.dte,
      maxDTE: candidate.maxDTE,
      minDTE: candidate.minDTE,
      placedOrder: false,
      preferredDTE: candidate.preferredDTE,
      routeOrders,
      skippedReason: "insufficient budget for one contract",
      underlyingSymbol: evaluation.underlyingSymbol,
      usedDteFallback: candidate.usedDteFallback,
    };
  }

  if (options.dryRun) {
    const estimatedOrderValue = routeOrders.reduce(
      (sum, routeOrder) => sum + routeOrder.estimatedOrderValue,
      0,
    );

    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      candidateSymbol: candidate.symbol,
      candidateDTE: candidate.dte,
      estimatedOrderValue,
      maxDTE: candidate.maxDTE,
      minDTE: candidate.minDTE,
      placedOrder: false,
      preferredDTE: candidate.preferredDTE,
      quantity: totalQuantity,
      routeOrders,
      skippedReason: "dry-run plan",
      underlyingSymbol: evaluation.underlyingSymbol,
      usedDteFallback: candidate.usedDteFallback,
    };
  }

  const placedRouteOrders = await placeRouteOrders(
    accountNumber,
    candidate.symbol,
    routeOrders,
    bid,
    ask,
  );
  const estimatedOrderValue = placedRouteOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.estimatedOrderValue,
    0,
  );
  const quantity = placedRouteOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.quantity,
    0,
  );

  return {
    accountNumber,
    action: "MANAGE_ALLOCATION",
    candidateSymbol: candidate.symbol,
    candidateDTE: candidate.dte,
    estimatedOrderValue,
    maxDTE: candidate.maxDTE,
    minDTE: candidate.minDTE,
    orderResponses: placedRouteOrders
      .map((routeOrder) => routeOrder.orderResponse)
      .filter(
        (orderResponse): orderResponse is TastytradePlacedOrderResponse =>
          orderResponse != null,
      ),
    placedOrder: placedRouteOrders.some((routeOrder) => routeOrder.placedOrder),
    preferredDTE: candidate.preferredDTE,
    quantity,
    routeOrders: placedRouteOrders,
    underlyingSymbol: evaluation.underlyingSymbol,
    usedDteFallback: candidate.usedDteFallback,
  };
}

export function getUpdatedBudgetAfterAllocation(
  budget: AllocationBudget,
  evaluation: PositionGroupEvaluation,
  executionResult: AllocationExecutionResult,
): AllocationBudget {
  if (!executionResult.placedOrder || !executionResult.estimatedOrderValue) {
    return budget;
  }

  return {
    buyingPowerRemaining: Math.max(
      0,
      budget.buyingPowerRemaining - executionResult.estimatedOrderValue,
    ),
    portfolioExposure:
      budget.portfolioExposure + executionResult.estimatedOrderValue,
    totalCapital: budget.totalCapital,
  };
}

export function buildInitialBudget(
  buyingPower: number,
  totalCapital: number,
  evaluations: PositionGroupEvaluation[],
): AllocationBudget {
  return {
    buyingPowerRemaining: buyingPower,
    portfolioExposure: evaluations.reduce(
      (sum, evaluation) => sum + getGroupMarketValue(evaluation.positionSnapshots),
      0,
    ),
    totalCapital,
  };
}

export async function getCurrentAllocationBudget(
  accountNumber: string,
): Promise<AllocationBudget> {
  const [accountBalance, evaluations] = await Promise.all([
    tastytradeApi.balancesAndPositionsService.getAccountBalanceValues(
      accountNumber,
    ),
    getPositionEvaluations(accountNumber),
  ]);
  const accountMarginOrCash = await getAccountMarginOrCash(accountNumber);

  return buildInitialBudget(
    getSpendableFundsForAccountType(accountBalance, accountMarginOrCash),
    getEffectiveTotalCapital(accountBalance),
    evaluations,
  );
}