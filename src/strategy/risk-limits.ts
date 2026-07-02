const DEFAULT_MARGIN_MAX_BUY_EXPOSURE_PCT = 0.12;
const DEFAULT_CASH_MAX_BUY_EXPOSURE_PCT = 0.05;

function parseEnvFraction(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getMarginMaxBuyExposurePct(): number {
  return parseEnvFraction("BOT_MARGIN_MAX_BUY_EXPOSURE_PCT", DEFAULT_MARGIN_MAX_BUY_EXPOSURE_PCT);
}

export function getCashMaxBuyExposurePct(): number {
  return parseEnvFraction("BOT_CASH_MAX_BUY_EXPOSURE_PCT", DEFAULT_CASH_MAX_BUY_EXPOSURE_PCT);
}

export function getMaxBuyExposurePctForAccountType(
  accountType: "margin" | "cash",
): number {
  return accountType === "margin" ? getMarginMaxBuyExposurePct() : getCashMaxBuyExposurePct();
}
