export const BOT_ORDER_SOURCE = "tastytrade-silver-lynx";
export const MARGIN_SEED_FROM_CASH_ORDER_SOURCE =
  "tastytrade-silver-lynx-margin-seed-from-cash";
export const CASH_SEED_FROM_MARGIN_ORDER_SOURCE =
  "tastytrade-silver-lynx-cash-seed-from-margin";
export const SECRET_AUTO_SEED_ORDER_SOURCE = "tastytrade-silver-lynx-secret-auto-seed";
export const OVERNIGHT_REDUCTION_ORDER_SOURCE =
  "tastytrade-silver-lynx-overnight-reduction";
// Spray-buy slices carry this source so the per-cycle cancel sweep leaves resting
// limit slices in place across cycles (a spray spans several ~4min cycles). The
// spray executor owns their lifecycle: it fills, expires (Day TIF), or aborts them.
export const SPRAY_BUY_ORDER_SOURCE = "tastytrade-silver-lynx-spray-buy";

/**
 * OWNER-DIRECTED: placed BY this process but expressing the OWNER's conviction,
 * not a strategy decision (e.g. the planned inbound-SMS "text a ticker to buy it"
 * path). It is deliberately NOT a managed source: the owner owns the exit, so
 * `position-provenance.ts` classifies it do-not-touch exactly like a hand-placed
 * order, which also keeps it out of the 12:50 margin EOD sweep that would
 * otherwise flatten a conviction trade the same day it was opened.
 *
 * No producer yet — wiring the SMS path means passing this as `orderSource`.
 */
export const OWNER_DIRECTED_ORDER_SOURCE = "tastytrade-silver-lynx-owner-directed";

export function isOwnerDirectedOrderSource(source: string | null | undefined): boolean {
  return String(source ?? "").trim() === OWNER_DIRECTED_ORDER_SOURCE;
}

// Every source this bot has ever stamped on an order begins with one of these.
// The golden-lion entry is NOT dead code: commit efda628 (2026-07-27) renamed the
// brand, and orders placed before that date still carry the old prefix in the
// broker's order history. Attribution that only knows the current name silently
// reclassifies every pre-rename bot order as owner-placed.
const BOT_ORDER_SOURCE_PREFIXES = [
  "tastytrade-silver-lynx",
  "tastytrade-golden-lion",
] as const;

/**
 * Did THIS bot place the order? Prefix match, because each subsystem appends its
 * own suffix (`-overnight-reduction`, `-spray-buy`, …) and new ones get added
 * without this predicate knowing about them.
 *
 * An owner-placed order (dashboard, mobile app) carries neither prefix, which is
 * the only way to tell a bot-caused fill from a hand-placed one after the fact.
 */
export function isBotOrderSource(source: string | null | undefined): boolean {
  const normalized = String(source ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return BOT_ORDER_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isMarginSeedFromCashOrderSource(
  source: string | null | undefined,
): boolean {
  return String(source ?? "").trim() === MARGIN_SEED_FROM_CASH_ORDER_SOURCE;
}

export function isSecretAutoSeedOrderSource(source: string | null | undefined): boolean {
  return String(source ?? "").trim() === SECRET_AUTO_SEED_ORDER_SOURCE;
}

export function isOvernightReductionOrderSource(
  source: string | null | undefined,
): boolean {
  return String(source ?? "").trim() === OVERNIGHT_REDUCTION_ORDER_SOURCE;
}

export function isSprayBuyOrderSource(source: string | null | undefined): boolean {
  return String(source ?? "").trim() === SPRAY_BUY_ORDER_SOURCE;
}