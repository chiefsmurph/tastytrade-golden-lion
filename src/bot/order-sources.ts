export const BOT_ORDER_SOURCE = "tastytrade-golden-lion";
export const MARGIN_SEED_FROM_CASH_ORDER_SOURCE =
  "tastytrade-golden-lion-margin-seed-from-cash";
export const CASH_SEED_FROM_MARGIN_ORDER_SOURCE =
  "tastytrade-golden-lion-cash-seed-from-margin";
export const SECRET_AUTO_SEED_ORDER_SOURCE = "tastytrade-golden-lion-secret-auto-seed";
export const OVERNIGHT_REDUCTION_ORDER_SOURCE =
  "tastytrade-golden-lion-overnight-reduction";
// Spray-buy slices carry this source so the per-cycle cancel sweep leaves resting
// limit slices in place across cycles (a spray spans several ~4min cycles). The
// spray executor owns their lifecycle: it fills, expires (Day TIF), or aborts them.
export const SPRAY_BUY_ORDER_SOURCE = "tastytrade-golden-lion-spray-buy";

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