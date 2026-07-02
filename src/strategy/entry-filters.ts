function readEnv(key: string, fallback: number, validate: (n: number) => boolean = () => true): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && validate(parsed) ? parsed : fallback;
}

export function getMarginTargetCallDelta(): number {
  return readEnv("BOT_MARGIN_TARGET_CALL_DELTA", 0.35, n => n > 0 && n < 1);
}

export function getMinIvRankPct(): number {
  return readEnv("BOT_MIN_IV_RANK_PCT", 20, n => n >= 0);
}

export function getMaxOptionSpreadPct(): number {
  return readEnv("BOT_MAX_OPTION_SPREAD_PCT", 0.3, n => n > 0);
}
