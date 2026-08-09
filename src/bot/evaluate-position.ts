import tastytradeApi from "~/core/tastytrade-client";
import { CurrentPosition } from "~/core/types";
import { buildGroupKey, type PositionGroupSide } from "./do-not-touch-groups";
import {
  buildExecutionStrategy,
  ExecutionTargets,
  ExecutionStrategy,
  PositionMetrics,
  StrategyAccountType,
} from "~/strategy/evaluate-trading-strategy";
import { getScaleOutConfig, type ScaleOutContext } from "~/strategy/scale-out";
import type { StopPersistenceContext } from "~/strategy/stop-persistence";
import { isScaled } from "./actions/scale-out-store";
import {
  getObservedStopCycles,
  recordStopTrigger,
} from "./actions/stop-persistence-store";

export interface PositionQuoteSnapshot {
  position: CurrentPosition;
  currentBidPrice: number;
  currentAskPrice: number;
  weightedAverageFill: number;
  quantityWeight: number;
  lastActionTime: Date;
}

export interface PositionGroupEvaluation {
  groupKey: string;
  underlyingSymbol: string;
  positions: CurrentPosition[];
  positionSnapshots: PositionQuoteSnapshot[];
  metrics: PositionMetrics;
  secretBuyWeight?: number | null;
  strategy: ExecutionStrategy;
  executionTargets?: ExecutionTargets;
  // Scale-out context used to build `strategy` this cycle. Passed to the close
  // dispatcher so the execution-time recovery re-check applies the same runner
  // logic (otherwise a stateless re-check would skip a runner's breakeven exit).
  scaleOutContext?: ScaleOutContext;
  currentReturn: number;
}

export function getUnderlyingSymbolForPosition(position: CurrentPosition): string {
  return (position["underlying-symbol"] as string | null | undefined)?.trim() || position.symbol;
}

export function getOptionSideForPosition(position: CurrentPosition): "call" | "put" | null {
  const trimmed = String(position.symbol ?? "").trim();
  const match = trimmed.match(/([CP])(\d+)$/i);
  if (!match) {
    return null;
  }

  return match[1].toUpperCase() === "P" ? "put" : "call";
}

export function getGroupSideForPositions(
  positions: CurrentPosition[],
): PositionGroupSide {
  return getOptionSideForPosition(positions[0]) ?? "none";
}

export function groupPositionsByUnderlying(
  positions: CurrentPosition[],
): Map<string, CurrentPosition[]> {
  const grouped = new Map<string, CurrentPosition[]>();

  for (const position of positions) {
    const underlyingSymbol = getUnderlyingSymbolForPosition(position);
    const side = getOptionSideForPosition(position) ?? "none";
    const groupKey = `${underlyingSymbol}::${side}`;
    const existing = grouped.get(groupKey);

    if (existing) {
      existing.push(position);
      continue;
    }

    grouped.set(groupKey, [position]);
  }

  return grouped;
}

function getPositionQuantityWeight(position: CurrentPosition): number {
  const quantity = Math.abs(Number(position.quantity) || 0);
  const multiplier = Math.abs(Number(position.multiplier) || 1);
  return quantity * multiplier;
}

async function createPositionQuoteSnapshot(
  position: CurrentPosition,
): Promise<PositionQuoteSnapshot> {
  const markPrice = Number(position["mark-price"]);
  const closePrice = Number(position["close-price"]);
  const averageOpenPrice = Number(position["average-open-price"]);
  const averageDailyClosePrice = Number(
    position["average-daily-market-close-price"],
  );
  const fallbackMarkPrice = Number.isFinite(markPrice) ? markPrice : undefined;
  const fallbackClosePrice = Number.isFinite(closePrice) ? closePrice : undefined;
  const fallbackAverageOpen = Number.isFinite(averageOpenPrice)
    ? averageOpenPrice
    : undefined;
  const fallbackAverageDailyClose = Number.isFinite(averageDailyClosePrice)
    ? averageDailyClosePrice
    : undefined;

  const quoteLookupSymbol =
    (position["streamer-symbol"] as string | undefined) ||
    (position["quote-symbol"] as string | undefined) ||
    position.symbol;

  const bidAsk = await tastytradeApi.johnsService.getBidAskForSymbol(
    quoteLookupSymbol,
    3000,
  );
  const currentBidPrice =
    bidAsk?.bid ?? (fallbackMarkPrice ?? fallbackClosePrice ?? 0);
  const currentAskPrice =
    bidAsk?.ask ??
    (fallbackMarkPrice ?? fallbackClosePrice ?? currentBidPrice);
  const weightedAverageFill =
    fallbackAverageOpen ??
    fallbackAverageDailyClose ??
    currentBidPrice;

  if (fallbackAverageOpen == null && fallbackAverageDailyClose == null) {
    // Falling back to the live bid pins currentReturn at ~0%, which silently
    // disables this group's take-profit and stop-loss (both keyed off return
    // vs fill). Surface it — a position with no known cost basis is not safe
    // to treat as break-even.
    console.warn(
      `[evaluate-position] ${position.symbol}: no average-open/close price — cost basis fell back to live bid ${currentBidPrice}; circuit breakers are effectively disabled for this group until a fill price is known.`,
    );
  }

  return {
    position,
    currentBidPrice,
    currentAskPrice,
    weightedAverageFill,
    quantityWeight: getPositionQuantityWeight(position),
    lastActionTime: position["updated-at"] ? new Date(String(position["updated-at"])) : new Date(),
  };
}

function buildAggregateMetrics(
  positionSnapshots: PositionQuoteSnapshot[],
  currentTime: Date,
): PositionMetrics {
  const totalQuantityWeight = positionSnapshots.reduce(
    (sum, snapshot) => sum + snapshot.quantityWeight,
    0,
  );

  if (totalQuantityWeight <= 0) {
    return {
      currentBidPrice: 0,
      currentAskPrice: 0,
      weightedAverageFill: 0,
      currentTime,
      lastActionTime: currentTime,
    };
  }

  const totalBidValue = positionSnapshots.reduce(
    (sum, snapshot) => sum + snapshot.currentBidPrice * snapshot.quantityWeight,
    0,
  );
  const totalAskValue = positionSnapshots.reduce(
    (sum, snapshot) => sum + snapshot.currentAskPrice * snapshot.quantityWeight,
    0,
  );
  const totalCostBasis = positionSnapshots.reduce(
    (sum, snapshot) =>
      sum + snapshot.weightedAverageFill * snapshot.quantityWeight,
    0,
  );
  const lastActionTime = positionSnapshots.reduce(
    (latest, snapshot) =>
      snapshot.lastActionTime.getTime() > latest.getTime()
        ? snapshot.lastActionTime
        : latest,
    positionSnapshots[0].lastActionTime,
  );

  return {
    currentBidPrice: totalBidValue / totalQuantityWeight,
    currentAskPrice: totalAskValue / totalQuantityWeight,
    weightedAverageFill: totalCostBasis / totalQuantityWeight,
    currentTime,
    lastActionTime,
  };
}

export async function evaluatePositionGroup(
  positions: CurrentPosition[],
  currentTime = new Date(),
  accountType: StrategyAccountType = "unknown",
): Promise<PositionGroupEvaluation | null> {
  if (positions.length === 0) {
    return null;
  }

  const positionSnapshots = await Promise.all(
    positions.map((position) => createPositionQuoteSnapshot(position)),
  );
  const metrics = buildAggregateMetrics(positionSnapshots, currentTime);
  const groupKey = buildGroupKey(
    getUnderlyingSymbolForPosition(positions[0]),
    getGroupSideForPositions(positions),
  );
  // Partial take-profit runner state. Only touch the store when scale-out is
  // enabled for this account type (cash-only in v1) — otherwise this stays a
  // no-op and the strategy behaves exactly as before.
  const scaleConfig = getScaleOutConfig(accountType);
  const alreadyScaled = scaleConfig.enabled
    ? await isScaled(accountType, groupKey, metrics.weightedAverageFill)
    : false;
  const scaleOutContext: ScaleOutContext = { ...scaleConfig, alreadyScaled };

  // Stop-loss persistence. The streak is stored per ACCOUNT + group key: cash and
  // margin regularly hold the same underlying, and a symbol-only key would let one
  // book's quote noise arm the other book's stop. An "unknown" account type has no
  // book to key against, so it runs with the gate inert (today's behaviour) rather
  // than sharing a bucket — same rule the scale-out store follows.
  //
  // The streak is stamped with the CYCLE clock, not Date.now(): every caller of
  // getPositionEvaluations passes the cycle's timestamp, and keying off it is what
  // makes "the immediately preceding cycle" mean the same thing to the store as it
  // does to the engine. It is also what lets the store tell a repeat evaluation of
  // THIS cycle apart from a genuinely new one — which it must, because this
  // function runs 5-6 times per cycle and the count below is inclusive of the
  // current cycle rather than a "prior" that the caller then increments.
  const cycleMs = currentTime.getTime();
  const stopPersistence: StopPersistenceContext | undefined =
    accountType === "unknown"
      ? undefined
      : {
          observedConsecutiveCycles: await getObservedStopCycles(
            accountType,
            groupKey,
            metrics.weightedAverageFill,
            cycleMs,
          ),
        };

  const strategy = buildExecutionStrategy(
    metrics,
    accountType,
    scaleOutContext,
    stopPersistence,
  );

  if (stopPersistence) {
    // Advance the streak while the trigger keeps holding, drop it the moment it
    // stops — including when the group recovers, is closed, or is re-entered (the
    // store's staleness + cost-basis guards catch the cases this call cannot see).
    await recordStopTrigger(
      accountType,
      groupKey,
      strategy.stopTriggerHeld === true,
      metrics.weightedAverageFill,
      cycleMs,
    );
  }

  const currentReturn =
    metrics.weightedAverageFill > 0
      ? (metrics.currentBidPrice - metrics.weightedAverageFill) /
        metrics.weightedAverageFill
      : 0;

  return {
    groupKey,
    underlyingSymbol: getUnderlyingSymbolForPosition(positions[0]),
    positions,
    positionSnapshots,
    metrics,
    strategy,
    scaleOutContext,
    currentReturn,
  };
}

export async function evaluateCurrentPosition(currentPosition: CurrentPosition) {
  const evaluation = await evaluatePositionGroup([currentPosition]);
  return evaluation?.strategy ?? null;
}