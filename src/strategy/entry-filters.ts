const DEFAULT_MAX_OPTION_SPREAD_PCT = 0.3;
const DEFAULT_MIN_IV_RANK_PCT = 20;
const DEFAULT_MARGIN_TARGET_CALL_DELTA = 0.35;

export function getMarginTargetCallDelta(): number {
  const raw = process.env.BOT_MARGIN_TARGET_CALL_DELTA;
  if (!raw) return DEFAULT_MARGIN_TARGET_CALL_DELTA;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1
    ? parsed
    : DEFAULT_MARGIN_TARGET_CALL_DELTA;
}

export function getMinIvRankPct(): number {
  const raw = process.env.BOT_MIN_IV_RANK_PCT;
  if (!raw) return DEFAULT_MIN_IV_RANK_PCT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_IV_RANK_PCT;
}

export function getMaxOptionSpreadPct(): number {
  const raw = process.env.BOT_MAX_OPTION_SPREAD_PCT;
  if (!raw) return DEFAULT_MAX_OPTION_SPREAD_PCT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_OPTION_SPREAD_PCT;
}
