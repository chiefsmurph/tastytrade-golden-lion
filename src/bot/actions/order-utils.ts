import { CurrentPosition } from "~/core/types";
import type {
  OrderRequest,
  TastytradeInstrumentType,
  TastytradeOrderAction,
} from "~/core/types";
import { PositionQuoteSnapshot } from "../evaluate-position";
import { ExecutionTargets } from "~/strategy/evaluate-trading-strategy";

export interface OrderLeg {
  action: TastytradeOrderAction;
  symbol: string;
  quantity: number;
  "instrument-type": TastytradeInstrumentType;
}

export type OrderPayload = OrderRequest;

export function getPositionQuantity(position: CurrentPosition): number {
  return Math.abs(Number(position.quantity) || 0);
}

export function isShortPosition(position: CurrentPosition): boolean {
  const quantityDirection = String(position["quantity-direction"] ?? "").toLowerCase();
  if (quantityDirection === "short") {
    return true;
  }
  if (quantityDirection === "long") {
    return false;
  }

  return String(position["cost-effect"] ?? "").toLowerCase() === "credit";
}

export function getClosingAction(position: CurrentPosition): TastytradeOrderAction {
  return isShortPosition(position) ? "Buy to Close" : "Sell to Close";
}

export function normalizeInstrumentType(
  instrumentType: string,
): TastytradeInstrumentType {
  switch (instrumentType.trim().toLowerCase()) {
    case "equity":
      return "Equity";
    case "option":
    case "equity option":
      return "Equity Option";
    case "future":
      return "Future";
    case "future option":
      return "Future Option";
    case "cryptocurrency":
    case "crypto":
      return "Cryptocurrency";
    default:
      return instrumentType as TastytradeInstrumentType;
  }
}

export function getWeightedOrderPrice(
  bid: number,
  ask: number,
  targets: Pick<ExecutionTargets, "bidWeight" | "midWeight" | "askWeight">,
): number {
  const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : ask || bid;
  const totalWeight = targets.bidWeight + targets.midWeight + targets.askWeight;

  if (totalWeight <= 0) {
    return midpoint;
  }

  return (
    bid * targets.bidWeight +
    midpoint * targets.midWeight +
    ask * targets.askWeight
  ) / totalWeight;
}

export function roundOrderPrice(price: number): string {
  return (Math.round(price * 100) / 100).toFixed(2);
}

export function buildClosingOrderPayload(
  snapshot: PositionQuoteSnapshot,
  targets: Pick<ExecutionTargets, "bidWeight" | "midWeight" | "askWeight">,
): OrderPayload | null {
  const quantity = getPositionQuantity(snapshot.position);
  if (quantity <= 0) {
    return null;
  }

  const price = getWeightedOrderPrice(
    snapshot.currentBidPrice,
    snapshot.currentAskPrice,
    targets,
  );

  if (!(price > 0)) {
    return null;
  }

  const action = getClosingAction(snapshot.position);

  return {
    source: "tastytrade-golden-lion",
    "time-in-force": "Day",
    "order-type": "Limit",
    price: roundOrderPrice(price),
    "price-effect": action.startsWith("Buy") ? "Debit" : "Credit",
    "advanced-instructions": {
      "strict-position-effect-validation": true,
    },
    legs: [
      {
        action,
        symbol: snapshot.position.symbol,
        quantity,
        "instrument-type": normalizeInstrumentType(
          String(snapshot.position["instrument-type"] ?? ""),
        ),
      },
    ],
  };
}

export function getGroupMarketValue(positionSnapshots: PositionQuoteSnapshot[]): number {
  return positionSnapshots.reduce(
    (sum, snapshot) => sum + snapshot.currentBidPrice * snapshot.quantityWeight,
    0,
  );
}

export function inferOptionSide(symbol: string): "call" | "put" | null {
  const trimmed = symbol.trim();
  const match = trimmed.match(/([CP])(\d+)$/i);
  if (!match) {
    return null;
  }

  return match[1].toUpperCase() === "P" ? "put" : "call";
}

type GetOrderFn = (
  accountNumber: string,
  orderId: number,
) => Promise<{ status?: string } | null | undefined>;

const LIVE_ORDER_STATUSES = ["Pending", "Open", "Pending Cancel"];

// Polls a single order by id (not the full order list) until it fills or the
// timeout lapses. A missing order (404) counts as NOT filled — the previous
// copies of this loop treated a vanished order as filled, silently mislabeling
// cancelled/expired/rejected orders and feeding phantom fills to the chase loops.
export async function waitForOrderFillById(
  accountNumber: string,
  orderId: string,
  timeoutMs: number,
  options: { pollIntervalMs?: number; getOrder?: GetOrderFn } = {},
): Promise<boolean> {
  const numericOrderId = Number(orderId);
  if (!Number.isFinite(numericOrderId)) {
    return false;
  }

  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const getOrder: GetOrderFn =
    options.getOrder ??
    (async (resolvedAccountNumber, resolvedOrderId) => {
      const { default: tastytradeApi } = await import("~/core/tastytrade-client");
      return tastytradeApi.orderService.getOrder(resolvedAccountNumber, resolvedOrderId);
    });

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const order = await getOrder(accountNumber, numericOrderId);
      const status = order?.status;

      if (status === "Filled" || status === "Partially Filled") {
        return true;
      }

      if (!status || !LIVE_ORDER_STATUSES.includes(status)) {
        return false;
      }
    } catch (error) {
      const httpStatus = (error as { response?: { status?: number } })?.response?.status;
      if (httpStatus === 404) {
        return false;
      }
      // Transient failure — keep polling until the timeout.
    }

    await new Promise((res) => setTimeout(res, pollIntervalMs));
  }

  return false;
}