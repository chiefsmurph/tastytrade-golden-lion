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