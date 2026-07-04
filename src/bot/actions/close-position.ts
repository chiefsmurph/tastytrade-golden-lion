import tastytradeApi from "~/core/tastytrade-client";
import type { TastytradePlacedOrderResponse } from "~/core/types";
import { PositionGroupEvaluation } from "../evaluate-position";
import {
  StrategyAccountType,
  evaluateTradingStrategy,
  getDynamicTakeProfitTarget,
} from "~/strategy/evaluate-trading-strategy";
import {
  EOD_ARMED_MINUTE,
  EOD_FORCED_CLOSE_MINUTE,
  getMorningSpreadThresholdPct,
} from "~/strategy/spread-thresholds";
import { buildClosingOrderPayload, getMidpointPrice, waitForOrderFillById } from "./order-utils";

const CLOSE_TICK_CHASE_ENABLED = true;
const CLOSE_TICK_INTERVAL_MS = 30_000;
// Hard-risk closes (EOD liquidation, stop-loss) chase every 10s instead of 30s
// so a full 10-move chase completes in ~100s, not ~5 minutes — a chase that
// starts at 12:58 must finish before the 1:00 PM PT options close.
const URGENT_CLOSE_TICK_INTERVAL_MS = 10_000;
const MAX_CLOSE_TICK_MOVES = 10;

export interface ClosePositionResult {
  accountNumber: string;
  action: "CLOSE_POSITION";
  orderResponse?: TastytradePlacedOrderResponse;
  placedOrder: boolean;
  skippedReason?: string;
  symbol: string;
  underlyingSymbol: string;
}

export interface ClosePositionDependencies {
  createOrder?: typeof tastytradeApi.orderService.createOrder;
  cancelOrder?: typeof tastytradeApi.orderService.cancelOrder;
  checkOrderFilled?: (
    accountNumber: string,
    orderId: string,
    timeoutMs: number,
  ) => Promise<boolean>;
  tickChaseEnabled?: boolean;
  tickIntervalMs?: number;
  maxTickMoves?: number;
  // Hard-risk close (EOD liquidation, stop-loss): chase on the urgent tick
  // interval and cross all the way to the edge price on the final tick move.
  isUrgentClose?: boolean;
  urgentTickIntervalMs?: number;
  // Partial close: stop after closing this many total contracts across all snapshots
  maxQuantityToClose?: number;
  // Account type for the execution-time strategy re-check — cutoff minutes and
  // the EOD liquidation rule differ by account type.
  accountType?: StrategyAccountType;
}

function getMinTickSize(referencePrice: number): number {
  return referencePrice < 3 ? 0.05 : 0.1;
}

function getEdgePrice(
  action: string,
  bid: number,
  ask: number,
  midpoint: number,
): number {
  if (action.startsWith("Buy")) {
    return ask > 0 ? ask : midpoint;
  }

  return bid > 0 ? bid : midpoint;
}

function getCloseTickSize(
  action: string,
  midpoint: number,
  edgePrice: number,
  maxTickMoves: number,
): number {
  const safeMoveCount = Math.max(1, maxTickMoves);
  const minTickSize = getMinTickSize(midpoint);

  if (action.startsWith("Buy")) {
    if (edgePrice <= midpoint || !Number.isFinite(edgePrice)) {
      return minTickSize;
    }

    return Math.max((edgePrice - midpoint) / safeMoveCount, minTickSize);
  }

  if (edgePrice >= midpoint || !Number.isFinite(edgePrice)) {
    return minTickSize;
  }

  return Math.max((midpoint - edgePrice) / safeMoveCount, minTickSize);
}

function moveClosePriceTowardEdge(
  action: string,
  currentPrice: number,
  edgePrice: number,
  tickSize: number,
): number {
  if (action.startsWith("Buy")) {
    return Math.min(edgePrice, currentPrice + tickSize);
  }

  return Math.max(edgePrice, currentPrice - tickSize);
}

function pricesAreEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

// Returns whether the cancellation was confirmed. Callers must stop chasing on
// false — an unconfirmed cancel followed by a fresh sell can double-sell the
// position (the buy side has had this guard since v1; this mirrors it).
async function cancelOrderById(
  accountNumber: string,
  orderId: string,
  cancelOrder: typeof tastytradeApi.orderService.cancelOrder,
): Promise<boolean> {
  const numericOrderId = Number(orderId);
  if (!Number.isFinite(numericOrderId)) {
    return false;
  }

  try {
    await cancelOrder(accountNumber, numericOrderId);
    return true;
  } catch {
    return false;
  }
}

function getTimeInMinutes(currentTime: Date): number {
  return currentTime.getHours() * 60 + currentTime.getMinutes();
}

function getSpreadPct(bidPrice: number, askPrice: number): number {
  const midpoint = bidPrice > 0 && askPrice > 0 ? (bidPrice + askPrice) / 2 : 0;

  if (!(midpoint > 0)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, askPrice - bidPrice) / midpoint;
}

export function shouldSkipClosePositionForMorningSpread(
  evaluation: PositionGroupEvaluation,
): { skippedReason?: string; shouldSkip: boolean } {
  const currentTime = evaluation.metrics.currentTime;

  // EOD closes must execute regardless of spread — a skipped liquidation
  // leaves margin exposure held overnight.
  if (getTimeInMinutes(currentTime) >= EOD_ARMED_MINUTE) {
    return { shouldSkip: false };
  }

  const bidReturnPct =
    evaluation.metrics.weightedAverageFill > 0
      ? (evaluation.metrics.currentBidPrice - evaluation.metrics.weightedAverageFill) /
        evaluation.metrics.weightedAverageFill
      : 0;
  const highBidReturnPct = getDynamicTakeProfitTarget(currentTime);

  if (bidReturnPct >= highBidReturnPct) {
    return { shouldSkip: false };
  }

  const spreadPct = getSpreadPct(
    evaluation.metrics.currentBidPrice,
    evaluation.metrics.currentAskPrice,
  );
  const maxAllowedSpreadPct = getMorningSpreadThresholdPct(currentTime);

  if (spreadPct > maxAllowedSpreadPct) {
    return {
      shouldSkip: true,
      skippedReason: `Morning spread gate active (${(spreadPct * 100).toFixed(2)}% spread > ${(maxAllowedSpreadPct * 100).toFixed(2)}% max at ${currentTime.getHours().toString().padStart(2, "0")}:${currentTime.getMinutes().toString().padStart(2, "0")})`,
    };
  }

  return { shouldSkip: false };
}

export async function closePosition(
  accountNumber: string,
  evaluation: PositionGroupEvaluation,
  dependencies: ClosePositionDependencies = {},
) {
  const results: ClosePositionResult[] = [];
  const createOrder =
    dependencies.createOrder ??
    tastytradeApi.orderService.createOrder.bind(tastytradeApi.orderService);
  const cancelOrder =
    dependencies.cancelOrder ??
    tastytradeApi.orderService.cancelOrder.bind(tastytradeApi.orderService);
  const checkOrderFilled = dependencies.checkOrderFilled ?? waitForOrderFillById;
  const tickChaseEnabled =
    dependencies.tickChaseEnabled ?? CLOSE_TICK_CHASE_ENABLED;
  const isUrgentClose = dependencies.isUrgentClose ?? false;
  const tickIntervalMs = isUrgentClose
    ? dependencies.urgentTickIntervalMs ?? URGENT_CLOSE_TICK_INTERVAL_MS
    : dependencies.tickIntervalMs ?? CLOSE_TICK_INTERVAL_MS;
  const maxTickMoves = Math.max(
    0,
    dependencies.maxTickMoves ?? MAX_CLOSE_TICK_MOVES,
  );
  let remainingToClose = dependencies.maxQuantityToClose ?? Infinity;

  const morningSpreadGate = shouldSkipClosePositionForMorningSpread(evaluation);
  if (morningSpreadGate.shouldSkip) {
    return evaluation.positionSnapshots.map((snapshot) => ({
      accountNumber,
      action: "CLOSE_POSITION" as const,
      placedOrder: false,
      skippedReason: morningSpreadGate.skippedReason,
      symbol: snapshot.position.symbol,
      underlyingSymbol: evaluation.underlyingSymbol,
    }));
  }

  for (const snapshot of evaluation.positionSnapshots) {
    if (remainingToClose <= 0) break;

    const snapshotQty = Math.abs(Number(snapshot.position.quantity) || 0);
    const qtyToClose = Math.min(snapshotQty, remainingToClose);

    let baseOrder = buildClosingOrderPayload(snapshot);
    if (qtyToClose < snapshotQty && baseOrder) {
      baseOrder = {
        ...baseOrder,
        legs: baseOrder.legs.map((leg) => ({ ...leg, quantity: qtyToClose })),
      };
    }
    if (!baseOrder) {
      results.push({
        accountNumber,
        action: "CLOSE_POSITION",
        placedOrder: false,
        skippedReason: "missing price or quantity",
        symbol: snapshot.position.symbol,
        underlyingSymbol: evaluation.underlyingSymbol,
      });
      continue;
    }

    const orderAction = baseOrder.legs[0]?.action ?? "";
    const midpointPrice = getMidpointPrice(
      snapshot.currentBidPrice,
      snapshot.currentAskPrice,
    );

    if (!(midpointPrice > 0)) {
      results.push({
        accountNumber,
        action: "CLOSE_POSITION",
        placedOrder: false,
        skippedReason: "missing midpoint price",
        symbol: snapshot.position.symbol,
        underlyingSymbol: evaluation.underlyingSymbol,
      });
      continue;
    }

    // The CLOSE_POSITION decision was made at cycle start with prices that can
    // be minutes stale by the time this order goes out. Re-run the strategy
    // against the prices this order is actually priced from — a position that
    // recovered past its stop (or corrected back below its profit target)
    // must not be sold on the stale trigger. EOD forced liquidation always
    // bypasses this re-check: its trigger is the clock, not the price. The
    // strategy.action gate exempts overnight partial reductions, which are
    // exposure-driven closes, not stop/target closes.
    const isEodForcedClose =
      getTimeInMinutes(evaluation.metrics.currentTime) >= EOD_FORCED_CLOSE_MINUTE;
    if (evaluation.strategy.action === "CLOSE_POSITION" && !isEodForcedClose) {
      const freshStrategy = evaluateTradingStrategy(
        {
          currentBidPrice: snapshot.currentBidPrice,
          currentAskPrice: snapshot.currentAskPrice,
          weightedAverageFill: snapshot.weightedAverageFill,
          currentTime: new Date(),
          lastActionTime: evaluation.metrics.lastActionTime,
        },
        dependencies.accountType ?? "unknown",
      );

      if (freshStrategy.action === "MANAGE_ALLOCATION") {
        console.warn(
          `[close-position] ${snapshot.position.symbol}: strategy flipped to MANAGE_ALLOCATION at execution time — original close reason "${evaluation.strategy.reason}" no longer holds at bid ${snapshot.currentBidPrice} (${freshStrategy.reason}). Skipping close.`,
        );
        results.push({
          accountNumber,
          action: "CLOSE_POSITION",
          placedOrder: false,
          skippedReason:
            "strategy flipped to MANAGE_ALLOCATION at execution time (recovered from stop/target)",
          symbol: snapshot.position.symbol,
          underlyingSymbol: evaluation.underlyingSymbol,
        });
        continue;
      }
    }

    const edgePrice = getEdgePrice(
      orderAction,
      snapshot.currentBidPrice,
      snapshot.currentAskPrice,
      midpointPrice,
    );
    const tickSize = getCloseTickSize(
      orderAction,
      midpointPrice,
      edgePrice,
      maxTickMoves,
    );

    let currentPrice = midpointPrice;
    let tickMoveCount = 0;
    let activeOrderId: string | undefined;
    let lastOrderResponse: TastytradePlacedOrderResponse | undefined;

    while (tickMoveCount <= maxTickMoves) {
      if (activeOrderId && tickChaseEnabled && tickMoveCount > 0) {
        const cancelled = await cancelOrderById(accountNumber, activeOrderId, cancelOrder);
        if (!cancelled) {
          // Can't confirm the previous sell died — placing another would risk
          // a double-sell. Leave the existing order working; the next cycle's
          // cancelAllLiveOrders sweep owns cleanup.
          break;
        }
      }

      const order = {
        ...baseOrder,
        price: (Math.round(currentPrice * 100) / 100).toFixed(2),
      };
      const orderResponse = await createOrder(accountNumber, order);
      lastOrderResponse = orderResponse;
      activeOrderId = orderResponse?.order?.id;

      if (!tickChaseEnabled || tickMoveCount >= maxTickMoves) {
        break;
      }

      if (pricesAreEqual(currentPrice, edgePrice)) {
        break;
      }

      const isFilled = activeOrderId
        ? await checkOrderFilled(accountNumber, activeOrderId, tickIntervalMs)
        : false;

      if (isFilled) {
        break;
      }

      // Urgent closes must fill: the final move crosses straight to the edge
      // (the bid for a sell) instead of stepping one tick at a time.
      const isFinalTickMove = tickMoveCount + 1 >= maxTickMoves;
      currentPrice = isUrgentClose && isFinalTickMove
        ? edgePrice
        : moveClosePriceTowardEdge(
            orderAction,
            currentPrice,
            edgePrice,
            tickSize,
          );
      tickMoveCount += 1;
    }

    // Fetch final order state to capture fills for JSONL — createOrder response
    // typically doesn't include fills, but a subsequent getOrder does.
    if (activeOrderId) {
      try {
        const numericId = Number(activeOrderId);
        if (Number.isFinite(numericId)) {
          const finalOrder = await tastytradeApi.orderService.getOrder(
            accountNumber,
            numericId,
          );
          if (lastOrderResponse) {
            lastOrderResponse = { ...lastOrderResponse, order: finalOrder };
          }
        }
      } catch {
        // use lastOrderResponse as-is
      }
    }

    remainingToClose -= qtyToClose;
    results.push({
      accountNumber,
      action: "CLOSE_POSITION",
      orderResponse: lastOrderResponse,
      placedOrder: true,
      symbol: snapshot.position.symbol,
      underlyingSymbol: evaluation.underlyingSymbol,
    });
  }

  return results;
}

export default closePosition;
