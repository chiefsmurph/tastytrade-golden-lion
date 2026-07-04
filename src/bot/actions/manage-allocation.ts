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
  TopOptionCandidateForSymbolResult,
} from "~/strategy/option-candidate";
import { getMaxOptionSpreadPctForTime } from "~/strategy/entry-filters";
import {
  getGroupMarketValue,
  getMidpointPrice,
  inferOptionSide,
  normalizeInstrumentType,
  OrderPayload,
  roundOrderPrice,
  waitForOrderFillById,
} from "./order-utils";
import { ExecutionTargets } from "~/strategy/evaluate-trading-strategy";
import { getMaxBuyExposurePctForAccountType } from "~/strategy/risk-limits";
import type { TastytradePlacedOrderResponse } from "~/core/types";


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
  usedHeldContractFallback?: boolean;
}

export interface AllocationBudget {
  buyingPowerRemaining: number;
  portfolioExposure: number;
  totalCapital: number;
}

interface ManageAllocationOptions {
  dryRun?: boolean;
  accountMarginOrCash?: "margin" | "cash";
}

function getCandidateSide(evaluation: PositionGroupEvaluation): "call" | "put" {
  const inferredSides = evaluation.positions
    .map((position) => inferOptionSide(position.symbol))
    .filter((side): side is "call" | "put" => side != null);

  return inferredSides[0] ?? "call";
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
    contractCost: routeOrder.limitPrice * 100,
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
const ASK_ROUTE_TICK_INTERVAL_MS = 15_000; // ask route chases on a faster clock
const MID_ROUTE_MAX_TICKS = 3; // mid route concedes at most this many ticks

export interface RouteChasePlan {
  ceilingPrice: number;
  maxTicks: number;
  startPrice: number;
  tickIntervalMs: number;
}

// Route semantics (redesigned 2026-07-03 — IMPROVEMENTS.v4 strategy #9): the
// route name describes how much of the spread the order concedes and how
// fast, not just a starting price. Previously every route chased to the full
// ask, and the ask route paid the whole spread instantly.
//   bid — rest at the bid, never chase (a genuinely patient order).
//   mid — start at mid, concede at most MID_ROUTE_MAX_TICKS ticks.
//   ask — start at MID and chase to the full ask on the fast clock:
//         immediacy with a real attempt at spread capture. When the spread is
//         within two min-ticks there is nothing to capture — go straight to
//         the ask.
export function getRouteChasePlan(
  route: AllocationRoute,
  bid: number,
  ask: number,
): RouteChasePlan {
  const midpoint = getMidpointPrice(bid, ask);
  const ceilingPrice = ask > 0 ? ask : midpoint;
  const minTick = midpoint < 3 ? 0.05 : 0.1;

  if (route === "bid") {
    const restPrice = bid > 0 ? bid : midpoint;
    return {
      ceilingPrice: restPrice,
      maxTicks: 0,
      startPrice: restPrice,
      tickIntervalMs: TICK_UP_INTERVAL_MS,
    };
  }

  if (route === "mid") {
    return {
      ceilingPrice,
      maxTicks: MID_ROUTE_MAX_TICKS,
      startPrice: midpoint,
      tickIntervalMs: TICK_UP_INTERVAL_MS,
    };
  }

  const spreadIsTight = ceilingPrice - midpoint <= 2 * minTick;
  return spreadIsTight
    ? {
        ceilingPrice,
        maxTicks: 0,
        startPrice: ceilingPrice,
        tickIntervalMs: ASK_ROUTE_TICK_INTERVAL_MS,
      }
    : {
        ceilingPrice,
        maxTicks: MAX_TICK_UPS,
        startPrice: midpoint,
        tickIntervalMs: ASK_ROUTE_TICK_INTERVAL_MS,
      };
}

// Cap a single allocation buy relative to the group's current market value,
// so adds scale with the position rather than the account: a $87 position
// with a 2.5x multiple can add at most ~$217 in one action, while a $1,000
// position can add $2,500. Keeps the first adds small without limiting later
// dip-averaging. Off unless set.
export function getMaxAllocationBuyPositionMultiple(): number {
  const raw = process.env.STRATEGY_MAX_ALLOCATION_BUY_POSITION_MULTIPLE;
  if (!raw) {
    return Infinity;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Infinity;
  }

  return parsed;
}

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

async function cancelOrderById(
  accountNumber: string,
  orderId: string,
  cancelFn?: (accountNumber: string, orderId: number) => Promise<unknown>,
): Promise<boolean> {
  try {
    const numericOrderId = Number(orderId);
    if (!Number.isFinite(numericOrderId)) {
      return false;
    }
    if (cancelFn) {
      await cancelFn(accountNumber, numericOrderId);
    } else {
      await tastytradeApi.orderService.cancelOrder(accountNumber, numericOrderId);
    }
    return true;
  } catch (err) {
    return false;
  }
}

export interface PlaceRouteOrdersDependencies {
  createOrder?: (accountNumber: string, order: OrderPayload) => Promise<TastytradePlacedOrderResponse>;
  cancelOrder?: (accountNumber: string, orderId: number) => Promise<unknown>;
  waitForFill?: (accountNumber: string, orderId: string, timeoutMs: number) => Promise<boolean>;
}

export async function placeRouteOrders(
  accountNumber: string,
  candidateSymbol: string,
  routeOrders: AllocationRouteResult[],
  bidPrice: number = 0,
  askPrice: number = 0,
  deps: PlaceRouteOrdersDependencies = {},
): Promise<AllocationRouteResult[]> {
  const effectiveCreateOrder = deps.createOrder ??
    ((acct: string, order: OrderPayload) => tastytradeApi.orderService.createOrder(acct, order) as Promise<TastytradePlacedOrderResponse>);
  const effectiveWaitForFill = deps.waitForFill ?? waitForOrderFillById;

  const placedOrders: AllocationRouteResult[] = [];

  for (const routeOrder of routeOrders) {
    if (routeOrder.quantity <= 0) {
      placedOrders.push({
        ...routeOrder,
        skippedReason: "allocated quantity rounded to zero",
      });
      continue;
    }

    const effectiveBid = bidPrice > 0 ? bidPrice : routeOrder.limitPrice;
    const effectiveAsk = askPrice > 0 ? askPrice : routeOrder.limitPrice;
    const plan = getRouteChasePlan(routeOrder.route, effectiveBid, effectiveAsk);
    const midPrice = getMidpointPrice(effectiveBid, effectiveAsk);

    let currentPrice = plan.startPrice;
    let orderId: string | undefined;
    let lastOrderResponse: TastytradePlacedOrderResponse | undefined;
    let tickCount = 0;

    while (tickCount <= plan.maxTicks) {
      const order: OrderPayload = {
        source: "tastytrade-golden-lion",
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

      const orderResponse = await effectiveCreateOrder(accountNumber, order);

      lastOrderResponse = orderResponse;
      orderId = orderResponse?.order?.id;

      if (!TICK_UP_CHASE_ENABLED || tickCount >= plan.maxTicks) {
        // Route rests here (bid, or chase exhausted) — leave the order working;
        // the next cycle's cancelAllLiveOrders sweep owns cleanup.
        break;
      }

      const isFilled = orderId ? await effectiveWaitForFill(
        accountNumber,
        orderId,
        plan.tickIntervalMs,
      ) : false;

      if (isFilled) {
        break;
      }

      const tickSize = calculateDynamicTickSize(midPrice, plan.ceilingPrice);
      const nextPrice = Math.min(plan.ceilingPrice, currentPrice + tickSize);

      if (nextPrice - currentPrice < 1e-9) {
        // At the ceiling — re-placing an identical price is pure request waste.
        break;
      }

      if (orderId) {
        const cancelled = await cancelOrderById(accountNumber, orderId, deps.cancelOrder);
        if (!cancelled) {
          // Can't confirm cancellation — stop chasing to avoid duplicate live orders
          break;
        }
      }

      currentPrice = nextPrice;
      tickCount += 1;
    }

    placedOrders.push({
      ...routeOrder,
      orderResponse: lastOrderResponse,
      placedOrder: true,
    });
  }

  return placedOrders;
}

// OCC option symbol: 6-char padded root, YYMMDD expiration, C/P, strike ×1000
const OCC_OPTION_SYMBOL_PATTERN = /^.{6}(\d{6})[CP]\d{8}$/;

function getOccExpirationDate(symbol: string): Date | null {
  const match = OCC_OPTION_SYMBOL_PATTERN.exec(symbol);
  if (!match) return null;
  const yymmdd = match[1];
  return new Date(
    2000 + Number(yymmdd.slice(0, 2)),
    Number(yymmdd.slice(2, 4)) - 1,
    Number(yymmdd.slice(4, 6)),
  );
}

// When the chain search finds nothing buyable for a group we already hold,
// fall back to adding to the held contract instead of skipping the group —
// gated by the same time-aware entry spread limit and a DTE floor so the
// fallback can't average into an expiring contract.
export function getHeldContractFallbackCandidate(
  evaluation: PositionGroupEvaluation,
  accountMarginOrCash: "margin" | "cash" | "unknown",
  currentTime = new Date(),
): TopOptionCandidateForSymbolResult {
  const snapshot = [...evaluation.positionSnapshots]
    .filter((positionSnapshot) =>
      Boolean(getOccExpirationDate(String(positionSnapshot.position.symbol ?? ""))),
    )
    .sort((a, b) => b.quantityWeight - a.quantityWeight)[0];

  if (!snapshot) {
    return { skippedReason: "no held option contract to fall back to" };
  }

  const symbol = String(snapshot.position.symbol);
  const expiration = getOccExpirationDate(symbol) as Date;
  const dte = Math.max(
    0,
    Math.ceil((expiration.getTime() - currentTime.getTime()) / 86_400_000),
  );
  const minHeldDte = accountMarginOrCash === "margin" ? 0 : 1;

  if (dte < minHeldDte) {
    return {
      dte,
      skippedReason: `held contract too close to expiry (${dte} DTE < ${minHeldDte})`,
    };
  }

  const bid = snapshot.currentBidPrice;
  const ask = snapshot.currentAskPrice;

  if (!(bid > 0) || !(ask > 0)) {
    return { dte, skippedReason: "held contract quote unavailable" };
  }

  const spreadPct = (ask - bid) / ((ask + bid) / 2);
  const maxAllowedSpreadPct = getMaxOptionSpreadPctForTime(currentTime);

  if (spreadPct > maxAllowedSpreadPct) {
    return {
      dte,
      spreadPct,
      skippedReason: `held contract spread ${(spreadPct * 100).toFixed(2)}% exceeds ${(maxAllowedSpreadPct * 100).toFixed(2)}% max`,
    };
  }

  return {
    askPrice: ask,
    bidPrice: bid,
    dte,
    maxAllowedSpreadPct,
    meetsSpreadRequirement: true,
    quoteSymbol:
      (snapshot.position["streamer-symbol"] as string | undefined) ||
      (snapshot.position["quote-symbol"] as string | undefined) ||
      symbol,
    spreadPct,
    symbol,
  };
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

  // The dip boost multiplies after the normalization/gate clamp so it survives
  // both — a boost baked into targetAccountExposure gets rescaled away when
  // group targets are normalized to the account schedule (see ExecutionTargets).
  const effectiveTargetAccountExposure =
    (targets.maxTargetAccountExposure != null
      ? Math.min(targets.targetAccountExposure, targets.maxTargetAccountExposure)
      : targets.targetAccountExposure) *
    (1 + (targets.dipTargetBoostPct ?? 0));
  const targetExposure = budget.totalCapital * effectiveTargetAccountExposure;
  const exposureHeadroom = targetExposure - budget.portfolioExposure;
  const baseBuyExposurePct = getMaxBuyExposurePctForAccountType(options.accountMarginOrCash ?? "cash");
  const maxBuyAmountPerAction =
    budget.totalCapital * (baseBuyExposurePct + (targets.booleanSurplusPct ?? 0));
  const normalizedGroupsRemaining = Math.max(1, groupsRemainingForAllocation);
  const perGroupExposureHeadroom = exposureHeadroom / normalizedGroupsRemaining;
  const perGroupMaxBuyAmount = maxBuyAmountPerAction / normalizedGroupsRemaining;

  if (effectiveTargetAccountExposure <= 0) {
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
  let candidate = await getTopOptionCandidateForSymbol(
    evaluation.underlyingSymbol,
    optionSide,
    targets.targetDTE,
    accountMarginOrCash === "margin"
      ? { strikeTarget: "otm", targetDelta: getMarginTargetCallDelta() }
      : undefined,
  );
  let usedHeldContractFallback = false;

  // Fallback only — the chain pick stays authoritative. IV-gate skips are an
  // intentional entry filter, so they do not fall back.
  if (!candidate?.symbol && !candidate?.skippedByIvGate) {
    const heldFallback = getHeldContractFallbackCandidate(
      evaluation,
      accountMarginOrCash,
    );

    console.log(
      JSON.stringify({
        scope: "manage-allocation-held-contract-fallback",
        underlyingSymbol: evaluation.underlyingSymbol,
        targetDTE: targets.targetDTE,
        chainSkippedReason: candidate?.skippedReason ?? "no candidate",
        fallbackSymbol: heldFallback.symbol ?? null,
        fallbackDTE: heldFallback.dte ?? null,
        fallbackSkippedReason: heldFallback.skippedReason ?? null,
      }),
    );

    if (heldFallback.symbol) {
      candidate = heldFallback;
      usedHeldContractFallback = true;
    }
  }

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
      // Liquidity distribution collection (IMPROVEMENTS.v4 strategy #4 step 1)
      dayVolume: candidate?.dayVolume ?? null,
      openInterest: candidate?.openInterest ?? null,
      bidSize: candidate?.bidSize ?? null,
      askSize: candidate?.askSize ?? null,
      spreadPct: candidate?.spreadPct ?? null,
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
  let bid = bidAsk?.bid ?? 0;
  let ask = bidAsk?.ask ?? bid;
  const buyPositionMultiple = getMaxAllocationBuyPositionMultiple();
  const positionValueBuyCap = Number.isFinite(buyPositionMultiple)
    ? getGroupMarketValue(evaluation.positionSnapshots) * buyPositionMultiple
    : Infinity;
  const availableCapital = Math.min(
    Math.max(0, perGroupExposureHeadroom),
    Math.max(0, perGroupMaxBuyAmount),
    budget.buyingPowerRemaining,
    positionValueBuyCap,
  );
  let routeOrders = allocateContractsByWeight(
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

  let totalQuantity = routeOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.quantity,
    0,
  );

  // The chain pick can be unaffordable under the per-action budget while the
  // contract we already hold is not (e.g. cash's 5% cap vs a fresh ITM pick).
  // Retry sizing with the held contract before giving up on the add.
  if (totalQuantity < 1 && !usedHeldContractFallback) {
    const heldFallback = getHeldContractFallbackCandidate(
      evaluation,
      accountMarginOrCash,
    );

    if (heldFallback.symbol && heldFallback.symbol !== candidate.symbol) {
      const heldBidAsk = await tastytradeApi.johnsService.getBidAskForSymbol(
        heldFallback.quoteSymbol ?? heldFallback.streamerSymbol ?? heldFallback.symbol,
        3000,
      );
      const heldBid = heldBidAsk?.bid ?? heldFallback.bidPrice ?? 0;
      const heldAsk = heldBidAsk?.ask ?? heldFallback.askPrice ?? heldBid;
      const heldRouteOrders = allocateContractsByWeight(
        buildRouteOrders(heldBid, heldAsk, targets),
        availableCapital,
      );
      const heldQuantity = heldRouteOrders.reduce(
        (sum, routeOrder) => sum + routeOrder.quantity,
        0,
      );

      console.log(
        JSON.stringify({
          scope: "manage-allocation-held-contract-fallback",
          underlyingSymbol: evaluation.underlyingSymbol,
          reason: "chain candidate unaffordable for per-action budget",
          chainCandidate: candidate.symbol,
          heldContract: heldFallback.symbol,
          availableCapital,
          heldQuantity,
        }),
      );

      if (heldQuantity >= 1) {
        candidate = heldFallback;
        bid = heldBid;
        ask = heldAsk;
        routeOrders = heldRouteOrders;
        totalQuantity = heldQuantity;
        usedHeldContractFallback = true;
      }
    }
  }

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
      usedHeldContractFallback: usedHeldContractFallback || undefined,
    };
  }

  const candidateSymbol = candidate.symbol;
  if (!candidateSymbol) {
    // Unreachable: both the chain guard above and the held fallback branch
    // require a symbol — this exists to keep the narrowing after reassignment.
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      placedOrder: false,
      routeOrders: [],
      skippedReason: "no option candidate found",
      underlyingSymbol: evaluation.underlyingSymbol,
    };
  }

  const placedRouteOrders = await placeRouteOrders(
    accountNumber,
    candidateSymbol,
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
    usedHeldContractFallback: usedHeldContractFallback || undefined,
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
  options?: { bypassCashAccountCap?: boolean },
): Promise<AllocationBudget> {
  const [accountBalance, evaluations] = await Promise.all([
    tastytradeApi.balancesAndPositionsService.getAccountBalanceValues(
      accountNumber,
    ),
    getPositionEvaluations(accountNumber),
  ]);
  const accountMarginOrCash = await getAccountMarginOrCash(accountNumber);

  const buyingPower =
    options?.bypassCashAccountCap && accountMarginOrCash === "cash"
      ? getConservativeSpendableFunds(accountBalance)
      : getSpendableFundsForAccountType(accountBalance, accountMarginOrCash);

  return buildInitialBudget(
    buyingPower,
    getEffectiveTotalCapital(accountBalance),
    evaluations,
  );
}