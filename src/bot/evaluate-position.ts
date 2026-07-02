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
  const strategy = buildExecutionStrategy(metrics, accountType);
  const currentReturn =
    metrics.weightedAverageFill > 0
      ? (metrics.currentBidPrice - metrics.weightedAverageFill) /
        metrics.weightedAverageFill
      : 0;

  return {
    groupKey: buildGroupKey(
      getUnderlyingSymbolForPosition(positions[0]),
      getGroupSideForPositions(positions),
    ),
    underlyingSymbol: getUnderlyingSymbolForPosition(positions[0]),
    positions,
    positionSnapshots,
    metrics,
    strategy,
    currentReturn,
  };
}

export async function evaluateCurrentPosition(currentPosition: CurrentPosition) {
  const evaluation = await evaluatePositionGroup([currentPosition]);
  return evaluation?.strategy ?? null;
}