import tastytradeApi from "~/core/tastytrade-client";
import { getAccountMarginOrCash, getDefaultAccountNumber } from "~/core/default-account";
import {
  evaluateOptionHealthForTargetDTE,
  getOptionHealthForSymbol,
  getTopOptionCandidateForSymbol,
  getMarginTargetCallDelta,
} from "./option-candidate";
import { getEffectiveBuyingPowerSummary } from "./effective-buying-power";
import {
  allocateContractsByWeight,
  AllocationRouteResult,
  buildRouteOrders,
  placeRouteOrders,
} from "./actions/manage-allocation";
import { getTimeOfDayExecutionTargets } from "~/strategy/evaluate-trading-strategy";

const EQUAL_ROUTE_TARGETS = {
  askWeight: 0.33,
  bidWeight: 0.33,
  midWeight: 0.33,
};

export type PurchaseSymbolRouteOrder = AllocationRouteResult;

export interface PurchaseSymbolResult {
  accountNumber: string;
  candidateDTE?: number;
  candidateSymbol?: string;
  effectiveBudget: number;
  maxDTE?: number;
  minDTE?: number;
  placedOrder: boolean;
  preferredDTE?: number;
  quoteSymbol?: string;
  requestedBudget: number;
  routeOrders: AllocationRouteResult[];
  side: "call" | "put";
  skippedReason?: string;
  symbol: string;
  totalEstimatedOrderValue: number;
  totalQuantity: number;
  usedDteFallback?: boolean;
}

export async function purchaseSymbol(
  symbol: string,
  requestedBudget: number,
  side: "call" | "put" = "call",
  accountNumber?: string,
): Promise<PurchaseSymbolResult> {
  const resolvedAccountNumber = accountNumber ?? (await getDefaultAccountNumber());
  const normalizedSymbol = symbol.toUpperCase();
  const accountType = await getAccountMarginOrCash(resolvedAccountNumber);
  const executionTargets = getTimeOfDayExecutionTargets(new Date(), accountType);

  if (!(requestedBudget > 0)) {
    throw new Error("requestedBudget must be greater than 0");
  }

  const healthResult = await getOptionHealthForSymbol(
    normalizedSymbol,
    side,
  );
  const healthGate = evaluateOptionHealthForTargetDTE(
    healthResult.summary,
    executionTargets.targetDTE,
  );

  if (!healthGate.passed) {
    return {
      accountNumber: resolvedAccountNumber,
      effectiveBudget: 0,
      placedOrder: false,
      requestedBudget,
      routeOrders: [],
      side,
      skippedReason: `option health gate failed for target DTE ${executionTargets.targetDTE}; missing healthy checkpoints: ${healthGate.missingRequiredTargets.join(", ")}`,
      symbol: normalizedSymbol,
      totalEstimatedOrderValue: 0,
      totalQuantity: 0,
    };
  }

  const candidate = await getTopOptionCandidateForSymbol(
    normalizedSymbol,
    side,
    undefined,
    accountType === "margin"
      ? { strikeTarget: "otm", targetDelta: getMarginTargetCallDelta() }
      : undefined,
  );
  const candidateSymbol =
    candidate?.symbol ?? (side === "put" ? candidate?.put : candidate?.call);
  const quoteSymbol =
    candidate?.streamerSymbol ??
    (side === "put"
      ? candidate?.["put-streamer-symbol"]
      : candidate?.["call-streamer-symbol"]) ??
    candidateSymbol;

  if (!candidateSymbol || !quoteSymbol) {
    return {
      accountNumber: resolvedAccountNumber,
      candidateDTE: candidate?.dte,
      candidateSymbol,
      effectiveBudget: 0,
      maxDTE: candidate?.maxDTE,
      minDTE: candidate?.minDTE,
      placedOrder: false,
      preferredDTE: candidate?.preferredDTE,
      quoteSymbol,
      requestedBudget,
      routeOrders: [],
      side,
      skippedReason: "no option candidate found",
      symbol: normalizedSymbol,
      totalEstimatedOrderValue: 0,
      totalQuantity: 0,
      usedDteFallback: candidate?.usedDteFallback,
    };
  }

  const bidAsk = await tastytradeApi.johnsService.getBidAskForSymbol(
    quoteSymbol,
    3000,
  );
  const bid = bidAsk?.bid ?? 0;
  const ask = bidAsk?.ask ?? bid;

  if (!(bid > 0 || ask > 0)) {
    return {
      accountNumber: resolvedAccountNumber,
      candidateDTE: candidate?.dte,
      candidateSymbol,
      effectiveBudget: 0,
      maxDTE: candidate?.maxDTE,
      minDTE: candidate?.minDTE,
      placedOrder: false,
      preferredDTE: candidate?.preferredDTE,
      quoteSymbol,
      requestedBudget,
      routeOrders: [],
      side,
      skippedReason: "candidate quote unavailable",
      symbol: normalizedSymbol,
      totalEstimatedOrderValue: 0,
      totalQuantity: 0,
      usedDteFallback: candidate?.usedDteFallback,
    };
  }

  const buyingPowerSummary = await getEffectiveBuyingPowerSummary(
    resolvedAccountNumber,
  );
  const effectiveBudget = Math.min(
    requestedBudget,
    buyingPowerSummary.effectiveBuyingPower,
  );

  if (effectiveBudget <= 0) {
    return {
      accountNumber: resolvedAccountNumber,
      candidateDTE: candidate?.dte,
      candidateSymbol,
      effectiveBudget,
      maxDTE: candidate?.maxDTE,
      minDTE: candidate?.minDTE,
      placedOrder: false,
      preferredDTE: candidate?.preferredDTE,
      quoteSymbol,
      requestedBudget,
      routeOrders: [],
      side,
      skippedReason:
        "insufficient effective buying power for current time-of-day exposure target",
      symbol: normalizedSymbol,
      totalEstimatedOrderValue: 0,
      totalQuantity: 0,
      usedDteFallback: candidate?.usedDteFallback,
    };
  }

  const plannedRouteOrders = allocateContractsByWeight(
    buildRouteOrders(bid, ask, EQUAL_ROUTE_TARGETS),
    effectiveBudget,
  );
  const totalPlannedQuantity = plannedRouteOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.quantity,
    0,
  );

  if (totalPlannedQuantity < 1) {
    return {
      accountNumber: resolvedAccountNumber,
      candidateDTE: candidate?.dte,
      candidateSymbol,
      effectiveBudget,
      maxDTE: candidate?.maxDTE,
      minDTE: candidate?.minDTE,
      placedOrder: false,
      preferredDTE: candidate?.preferredDTE,
      quoteSymbol,
      requestedBudget,
      routeOrders: plannedRouteOrders,
      side,
      skippedReason: "insufficient budget for one contract",
      symbol: normalizedSymbol,
      totalEstimatedOrderValue: 0,
      totalQuantity: 0,
      usedDteFallback: candidate?.usedDteFallback,
    };
  }

  const placedRouteOrders = await placeRouteOrders(
    resolvedAccountNumber,
    candidateSymbol,
    plannedRouteOrders,
  );
  const totalEstimatedOrderValue = placedRouteOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.estimatedOrderValue,
    0,
  );
  const totalQuantity = placedRouteOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.quantity,
    0,
  );

  return {
    accountNumber: resolvedAccountNumber,
    candidateDTE: candidate?.dte,
    candidateSymbol,
    effectiveBudget,
    maxDTE: candidate?.maxDTE,
    minDTE: candidate?.minDTE,
    placedOrder: placedRouteOrders.some((routeOrder) => routeOrder.placedOrder),
    preferredDTE: candidate?.preferredDTE,
    quoteSymbol,
    requestedBudget,
    routeOrders: placedRouteOrders,
    side,
    symbol: normalizedSymbol,
    totalEstimatedOrderValue,
    totalQuantity,
    usedDteFallback: candidate?.usedDteFallback,
  };
}

export default purchaseSymbol;
