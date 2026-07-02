import tastytradeApi from "~/core/tastytrade-client";
import type { TastytradePlacedOrderResponse } from "~/core/types";
import { PositionGroupEvaluation } from "../evaluate-position";
import { ExecutionTargets, getDynamicTakeProfitTarget } from "~/strategy/evaluate-trading-strategy";
import { buildClosingOrderPayload } from "./order-utils";

const CLOSE_TICK_CHASE_ENABLED = true;
const CLOSE_TICK_INTERVAL_MS = 30_000;
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
  // Partial close: stop after closing this many total contracts across all snapshots
  maxQuantityToClose?: number;
}

function getMidpointPrice(bid: number, ask: number): number {
  if (bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }

  return ask || bid;
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

async function waitForOrderFill(
  accountNumber: string,
  orderId: string,
  timeoutMs: number,
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const orders = await tastytradeApi.orderService.getOrders(accountNumber);
      const order = orders.find((currentOrder) => currentOrder.id === orderId);

      if (!order) {
        return true;
      }

      if (order.status === "Filled" || order.status === "Partially Filled") {
        return true;
      }

      if (!order.status || !["Pending", "Open", "Pending Cancel"].includes(order.status)) {
        return false;
      }
    } catch {
      // If we fail to inspect status, keep waiting until timeout.
    }

    await new Promise((res) => setTimeout(res, 1000));
  }

  return false;
}

async function cancelOrderById(
  accountNumber: string,
  orderId: string,
  cancelOrder: typeof tastytradeApi.orderService.cancelOrder,
): Promise<void> {
  const numericOrderId = Number(orderId);
  if (!Number.isFinite(numericOrderId)) {
    return;
  }

  try {
    await cancelOrder(accountNumber, numericOrderId);
  } catch {
    // Best effort cancellation before placing next chase attempt.
  }
}

const MORNING_CLOSE_SPREAD_THRESHOLDS = [
  { minute: 6 * 60 + 30, maxSpreadPct: 0.05 },
  { minute: 6 * 60 + 45, maxSpreadPct: 0.10 },
  { minute: 7 * 60 + 0, maxSpreadPct: 0.15 },
  { minute: 7 * 60 + 15, maxSpreadPct: 0.20 },
  { minute: 7 * 60 + 30, maxSpreadPct: 0.25 },
  { minute: 8 * 60 + 0, maxSpreadPct: 0.30 },
];

function getTimeInMinutes(currentTime: Date): number {
  return currentTime.getHours() * 60 + currentTime.getMinutes();
}

function getMorningCloseSpreadThresholdPct(currentTime: Date): number {
  const currentMinute = getTimeInMinutes(currentTime);
  let threshold = MORNING_CLOSE_SPREAD_THRESHOLDS[0]?.maxSpreadPct ?? 0;

  for (const spreadThreshold of MORNING_CLOSE_SPREAD_THRESHOLDS) {
    if (currentMinute < spreadThreshold.minute) {
      break;
    }

    threshold = spreadThreshold.maxSpreadPct;
  }

  return threshold;
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
  const maxAllowedSpreadPct = getMorningCloseSpreadThresholdPct(currentTime);

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
  targets: ExecutionTargets,
  dependencies: ClosePositionDependencies = {},
) {
  const results: ClosePositionResult[] = [];
  const createOrder =
    dependencies.createOrder ??
    tastytradeApi.orderService.createOrder.bind(tastytradeApi.orderService);
  const cancelOrder =
    dependencies.cancelOrder ??
    tastytradeApi.orderService.cancelOrder.bind(tastytradeApi.orderService);
  const checkOrderFilled = dependencies.checkOrderFilled ?? waitForOrderFill;
  const tickChaseEnabled =
    dependencies.tickChaseEnabled ?? CLOSE_TICK_CHASE_ENABLED;
  const tickIntervalMs =
    dependencies.tickIntervalMs ?? CLOSE_TICK_INTERVAL_MS;
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

    let baseOrder = buildClosingOrderPayload(snapshot, targets);
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
        await cancelOrderById(accountNumber, activeOrderId, cancelOrder);
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

      currentPrice = moveClosePriceTowardEdge(
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
