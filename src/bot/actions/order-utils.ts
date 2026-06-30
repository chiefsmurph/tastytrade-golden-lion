import { CurrentPosition } from "~/core/types";
import type {
  OrderRequest,
  TastytradeInstrumentType,
  TastytradeOrderAction,
} from "~/core/types";
import { PositionQuoteSnapshot } from "../evaluate-position";
import { ExecutionTargets } from "../evaluate-trading-strategy";

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