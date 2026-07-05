import { TastytradeOrder } from "~/core/types";
import { inferOptionSide } from "./actions/order-utils";
import type { PositionGroupEvaluation } from "./evaluate-position";

export type PositionGroupSide = "call" | "put" | "none";

const DO_NOT_TOUCH_GROUPS_ENV = "BOT_DO_NOT_TOUCH_GROUPS";

function normalizeGroupKey(value: string): string {
  return value.trim().toUpperCase();
}

export function getDoNotTouchGroupKeys(): Set<string> {
  const raw = process.env[DO_NOT_TOUCH_GROUPS_ENV]?.trim();
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map((part) => normalizeGroupKey(part))
      .filter((part) => part.length > 0),
  );
}

export function buildGroupKey(
  underlyingSymbol: string,
  side: PositionGroupSide,
): string {
  return `${underlyingSymbol.trim().toUpperCase()}::${side}`;
}

export function getGroupSideFromOptionSymbol(symbol: string): PositionGroupSide {
  return inferOptionSide(symbol) ?? "none";
}

export function isEvaluationDoNotTouch(
  evaluation: Pick<PositionGroupEvaluation, "groupKey">,
  doNotTouchGroupKeys: Set<string>,
): boolean {
  return doNotTouchGroupKeys.has(normalizeGroupKey(evaluation.groupKey));
}

export function getOrderGroupKey(order: TastytradeOrder): string | null {
  const underlyingSymbol = String(order["underlying-symbol"] ?? "").trim();
  if (!underlyingSymbol) {
    return null;
  }

  const firstLegSymbol = String(order.legs?.[0]?.symbol ?? "").trim();
  const side = getGroupSideFromOptionSymbol(firstLegSymbol);
  return buildGroupKey(underlyingSymbol, side);
}

export function isOrderDoNotTouch(
  order: TastytradeOrder,
  doNotTouchGroupKeys: Set<string>,
): boolean {
  const groupKey = getOrderGroupKey(order);
  return groupKey != null && doNotTouchGroupKeys.has(normalizeGroupKey(groupKey));
}
