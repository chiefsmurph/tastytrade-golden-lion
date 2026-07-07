export const BOT_ORDER_SOURCE = "tastytrade-golden-lion";
export const MARGIN_SEED_FROM_CASH_ORDER_SOURCE =
  "tastytrade-golden-lion-margin-seed-from-cash";
export const CASH_SEED_FROM_MARGIN_ORDER_SOURCE =
  "tastytrade-golden-lion-cash-seed-from-margin";
export const SECRET_AUTO_SEED_ORDER_SOURCE = "tastytrade-golden-lion-secret-auto-seed";
export const OVERNIGHT_REDUCTION_ORDER_SOURCE =
  "tastytrade-golden-lion-overnight-reduction";

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