export const BOT_ORDER_SOURCE = "tastytrade-playground";
export const MARGIN_SEED_FROM_CASH_ORDER_SOURCE =
  "tastytrade-playground-margin-seed-from-cash";
export const SECRET_AUTO_SEED_ORDER_SOURCE = "tastytrade-playground-secret-auto-seed";

export function isMarginSeedFromCashOrderSource(
  source: string | null | undefined,
): boolean {
  return String(source ?? "").trim() === MARGIN_SEED_FROM_CASH_ORDER_SOURCE;
}

export function isSecretAutoSeedOrderSource(source: string | null | undefined): boolean {
  return String(source ?? "").trim() === SECRET_AUTO_SEED_ORDER_SOURCE;
}