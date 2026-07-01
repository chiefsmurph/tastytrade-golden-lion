export const BOT_ORDER_SOURCE = "tastytrade-golden-lion";
export const MARGIN_SEED_FROM_CASH_ORDER_SOURCE =
  "tastytrade-golden-lion-margin-seed-from-cash";
export const CASH_SEED_FROM_MARGIN_ORDER_SOURCE =
  "tastytrade-golden-lion-cash-seed-from-margin";
export const SECRET_AUTO_SEED_ORDER_SOURCE = "tastytrade-golden-lion-secret-auto-seed";

export function isMarginSeedFromCashOrderSource(
  source: string | null | undefined,
): boolean {
  return String(source ?? "").trim() === MARGIN_SEED_FROM_CASH_ORDER_SOURCE;
}

export function isSecretAutoSeedOrderSource(source: string | null | undefined): boolean {
  return String(source ?? "").trim() === SECRET_AUTO_SEED_ORDER_SOURCE;
}