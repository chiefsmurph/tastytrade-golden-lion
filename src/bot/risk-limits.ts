const DEFAULT_GLOBAL_MAX_BUY_EXPOSURE_PCT = 0.16;

function parseGlobalMaxBuyExposurePct(): number {
  const raw = process.env.BOT_GLOBAL_MAX_BUY_EXPOSURE_PCT;
  if (!raw) return DEFAULT_GLOBAL_MAX_BUY_EXPOSURE_PCT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GLOBAL_MAX_BUY_EXPOSURE_PCT;
}

export const GLOBAL_MAX_BUY_EXPOSURE_PCT = parseGlobalMaxBuyExposurePct();
