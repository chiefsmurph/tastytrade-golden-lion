import { TastytradeOrder } from "~/core/types";
import { inferOptionSide } from "./actions/order-utils";
import type { PositionGroupEvaluation } from "./evaluate-position";

export type PositionGroupSide = "call" | "put" | "none" | "stock";

const DO_NOT_TOUCH_GROUPS_ENV = "BOT_DO_NOT_TOUCH_GROUPS";

function normalizeGroupKey(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * A configured entry protects a live group when it is:
 *   - the exact key                — `ORN::NONE`
 *   - the bare underlying (no `::`) — `ORN` protects EVERY side of ORN
 *   - the stock/none alias         — the underlying equity leg has no C/P suffix so it groups
 *     as `::none`; we treat `::stock` and `::none` as the same leg so either token protects it.
 * All comparisons are normalized (trim + uppercase), so case doesn't matter.
 */
// The equity leg has no C/P suffix so it groups as `::none`; `::stock` is an alias for that same
// leg, so a configured token of either side protects it.
const STOCK_NONE_ALIAS: Record<string, string | undefined> = { NONE: "STOCK", STOCK: "NONE" };

function matchesDoNotTouch(rawGroupKey: string, doNotTouchGroupKeys: Set<string>): boolean {
  const key = normalizeGroupKey(rawGroupKey);
  const sep = key.indexOf("::");
  const underlying = sep === -1 ? key : key.slice(0, sep);
  const side = sep === -1 ? "" : key.slice(sep + 2);
  const aliasSide = STOCK_NONE_ALIAS[side];
  const candidates = [key, underlying]; // exact key, or bare underlying (protects every side)
  if (aliasSide) candidates.push(`${underlying}::${aliasSide}`);
  return candidates.some((candidate) => Boolean(candidate) && doNotTouchGroupKeys.has(candidate));
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
  return matchesDoNotTouch(evaluation.groupKey, doNotTouchGroupKeys);
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
  return groupKey != null && matchesDoNotTouch(groupKey, doNotTouchGroupKeys);
}
