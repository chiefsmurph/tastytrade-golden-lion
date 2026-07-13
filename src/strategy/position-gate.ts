import { SecretSourcePosition } from "~/strategy/secret/types";
import {
  getCashAccountSeedEndMinute,
  getSecretAutoSeedWindowStartMinute,
} from "./seeding-windows";
import { readEnvPct, toBooleanFlag } from "~/core/env-utils";

export interface PositionGateSignals {
  crossAccountYes: boolean;
  basicStockYes: boolean;
  strongStockYes: boolean;
  goodBooleanScore: number;
  allBooleansGood: boolean;
}

export interface PositionGateResult {
  signals: PositionGateSignals;
  maxTargetPct: number;
  strongStockYesPctThreshold: number;
  strongStockYesScoreThreshold: number;
  basicStockYesPctThreshold: number;
  basicStockYesScoreThreshold: number;
}

// STRATEGY_CROSS_ACCOUNT_YES_DOWN_PCT is the late-day (lenient) threshold for the cross-account YES signal.
// At the seed-window start (SECRET_AUTO_SEED_START_TIME, default 6:30am): requires 2× that dip (strict).
// At window end (1pm): requires exactly the configured dip.
function getCrossAccountYesDownPct(currentTime: Date): number {
  const base = readEnvPct("STRATEGY_CROSS_ACCOUNT_YES_DOWN_PCT", 10);
  const minuteOfDay = currentTime.getHours() * 60 + currentTime.getMinutes();
  const startMinute = getSecretAutoSeedWindowStartMinute();
  const endMinute = getCashAccountSeedEndMinute();
  const duration = endMinute - startMinute;
  const t = duration > 0
    ? Math.max(0, Math.min(1, (minuteOfDay - startMinute) / duration))
    : 1;
  // t=0 (window start): 2× base (strict). t=1 (1pm): 1× base (lenient).
  return base * (2 - t);
}

// Reads the preferred env name, falling back to a legacy name so an
// un-migrated .env doesn't silently revert to defaults.
function readEnvPctWithLegacy(key: string, legacyKey: string, fallback: number): number {
  if (process.env[key]?.trim()) return readEnvPct(key, fallback);
  return readEnvPct(legacyKey, fallback);
}

// The four stock-yes thresholds form two basic/strong pairs. Both legs are
// time-scaled from half the base at window start to the full base at 1pm
// (percentOfBalance and daytradeScore magnitude build through the session),
// and each basic bar must sit below its strong counterpart.

// percentOfBalance above this qualifies as a basic stock YES on its own.
function getBasicPercentOfBalanceThreshold(): number {
  return readEnvPct("STRATEGY_GATE_BASIC_PERCENT_OF_BALANCE_THRESHOLD", 25);
}

// percentOfBalance above this qualifies (with isQualityToBuy) as a strong stock YES.
function getStrongPercentOfBalanceThreshold(): number {
  return readEnvPctWithLegacy(
    "STRATEGY_GATE_STRONG_PERCENT_OF_BALANCE_THRESHOLD",
    "STRATEGY_GATE_STRONG_STOCK_YES_MAX_PCT",
    30,
  );
}

// daytradeScore below this (more negative) qualifies as a basic stock YES on its own.
function getBasicDaytradeScoreThreshold(): number {
  return readEnvPct("STRATEGY_GATE_BASIC_DAYTRADE_SCORE_THRESHOLD", -40);
}

// daytradeScore below this (more negative) qualifies (with isQualityToBuy) as a
// strong stock YES. Legacy name expressed this as a positive magnitude, so the
// value is normalized to negative either way.
function getStrongDaytradeScoreThreshold(): number {
  return -Math.abs(
    readEnvPctWithLegacy(
      "STRATEGY_GATE_STRONG_DAYTRADE_SCORE_THRESHOLD",
      "STRATEGY_GATE_STRONG_DAYTRADE_SCORE_MAX",
      -100,
    ),
  );
}

// Additional maxTargetPct added per "good" boolean signal (isAboveMinSin etc.)
function getBooleanBoostPct(): number {
  return readEnvPct("STRATEGY_GATE_BOOLEAN_BOOST_PCT", 0.03);
}

export function getSingleYesMaxTargetPct(): number {
  return readEnvPct("STRATEGY_GATE_SINGLE_YES_MAX_TARGET_PCT", 0.15);
}

export function getBasicYesMaxTargetPct(): number {
  return readEnvPct("STRATEGY_GATE_BASIC_YES_MAX_TARGET_PCT", 0.10);
}

export function getBothYesMaxTargetPct(): number {
  return readEnvPct("STRATEGY_GATE_BOTH_YES_MAX_TARGET_PCT", 0.25);
}

export function getStrongYesMaxTargetPct(): number {
  return readEnvPct("STRATEGY_GATE_STRONG_YES_MAX_TARGET_PCT", 0.35);
}

export function getMarginTargetMultiplier(): number {
  return readEnvPct("STRATEGY_MARGIN_MAX_TARGET_MULTIPLIER", 1.33);
}

export function getCrossAccountThresholdMultiplier(): number {
  return readEnvPct("STRATEGY_MARGIN_CROSS_ACCOUNT_THRESHOLD_MULTIPLIER", 2);
}

// 0 at the gate window start → 1 at window end (1pm).
function getGateWindowProgress(currentTime: Date): number {
  const minuteOfDay = currentTime.getHours() * 60 + currentTime.getMinutes();
  const startMinute = getSecretAutoSeedWindowStartMinute();
  const endMinute = getCashAccountSeedEndMinute();
  const duration = endMinute - startMinute;

  return duration > 0
    ? Math.max(0, Math.min(1, (minuteOfDay - startMinute) / duration))
    : 1;
}

// percentOfBalance: base/2 at window start → base at window end
// daytradeScore:   -base/2 at window start → -base at window end
function getStrongStockYesThresholds(currentTime: Date): {
  pct: number;
  daytradeScore: number;
} {
  const t = getGateWindowProgress(currentTime);
  const basePct = getStrongPercentOfBalanceThreshold();
  const baseScoreMagnitude = Math.abs(getStrongDaytradeScoreThreshold());

  const pct = (basePct / 2) * (1 + t);
  const daytradeScore = -(baseScoreMagnitude / 2) * (1 + t);

  return { pct, daytradeScore };
}

// Basic thresholds scale over the same window with the same shapes as the
// strong ones — both legs tighten through the day for the same reason:
// percentOfBalance base/2 → base, daytradeScore -base/2 → -base.
function getBasicStockYesThresholds(currentTime: Date): {
  pct: number;
  daytradeScore: number;
} {
  const t = getGateWindowProgress(currentTime);
  const basePct = getBasicPercentOfBalanceThreshold();
  const baseScoreMagnitude = Math.abs(getBasicDaytradeScoreThreshold());

  return {
    pct: (basePct / 2) * (1 + t),
    daytradeScore: -(baseScoreMagnitude / 2) * (1 + t),
  };
}

// The thesis scale is the feed's manually-curated thesis: manualThesisMax is
// always 10, so scores run 0–10 with the willBuy icing (+2) on top. Every
// downstream bar (dip boost ≥4, seed multiplier 3/5/7, deep-loss ≥6, boost
// ×0.03/pt, surplus cap at full) and log denominator is tuned to this scale.
// The pre-2026-07-13 legacy per-flag counting (THESIS_FLAGS) is gone — the
// feed sends its rollup on every position.
export const THESIS_MAX = 10;

// The feed's consolidated thesis rollup: 0→1.0 spans its thesis flags, and only
// willBuy pushes it above 1.0 (to 1.25) — the icing signal.
const BUY_FRACTION_ICING_MAX = 1.25;

function getFeedBuyFraction(position: SecretSourcePosition | undefined): number | null {
  const raw = Number(position?.buyFraction);
  if (!Number.isFinite(raw) || raw < 0) return null;
  return Math.min(raw, BUY_FRACTION_ICING_MAX);
}

// The feed's manually-curated thesis — the preferred score source (richer
// granularity than the 4-flag buyFraction). manualThesisMax is always 10 =
// THESIS_MAX, so this is the raw count; the ratio form guards against the
// feed ever changing its max.
function getManualThesisScore(position: SecretSourcePosition): number | null {
  // NaN (missing/garbage fields), Infinity (max 0), and negatives all fail the
  // finite-and-non-negative check in one expression.
  const fractionOfMax = Number(position.manualThesisCount) / Number(position.manualThesisMax);
  if (!Number.isFinite(fractionOfMax) || fractionOfMax < 0) {
    return null;
  }
  return Math.round(Math.min(fractionOfMax, 1) * THESIS_MAX);
}

// The gate score, 0–THESIS_MAX(+2). Sources in preference order:
//   1. Manual thesis (manualThesisCount/manualThesisMax) — the richer,
//      manually-curated 0–10 score.
//   2. buyFraction alone — the coarse 4-flag rollup, spread across the scale.
// willBuy icing (+2) comes from buyFraction > 1 on both paths — the feed only
// pushes past 1.0 when willBuy is true, and it computes willBuy false during
// its own liquidation windows (isBuyEligible), so buy-intent noise is already
// handled upstream. No rollup at all = no thesis = 0: unknown scores nothing.
export function countGoodBooleans(position: SecretSourcePosition | undefined): number {
  if (!position) return 0;

  const feedFraction = getFeedBuyFraction(position);
  const feedIcing = feedFraction !== null && feedFraction > 1 ? 2 : 0;

  const manualThesisScore = getManualThesisScore(position);
  if (manualThesisScore !== null) {
    return manualThesisScore + feedIcing;
  }

  if (feedFraction !== null) {
    return Math.round(Math.min(feedFraction, 1) * THESIS_MAX) + feedIcing;
  }

  return 0;
}

// Margin seed — the highest-conviction action, so the bar is "everything
// passing": thesisCount >= thesisMax (thesisMax is in the payload for exactly
// this; today that's 4/4, and the bar tracks the feed if it grows its flag
// set). Missing/invalid rollup = no seed — unknown thesis is not conviction.
export function shouldSeedMarginFromBooleans(
  position: SecretSourcePosition | undefined,
): boolean {
  // NaN (missing fields) and Infinity (max 0) both fail the finite check.
  const ratio = Number(position?.thesisCount) / Number(position?.thesisMax);
  return Number.isFinite(ratio) && ratio >= 1;
}

// Per-action buy exposure surplus added on top of the account-type base for both
// accounts. Linear instead of a step ladder — one formula, no stale tiers; caps
// at 0.30 once the thesis scale is full (willBuy icing can't push it further).
export function getBooleanSurplusPct(goodBooleanScore: number): number {
  return Math.round(Math.min(goodBooleanScore / THESIS_MAX, 1) * 0.30 * 100) / 100;
}

function isQualityToBuy(position: SecretSourcePosition | undefined): boolean {
  return position != null && toBooleanFlag(position.isQualityToBuy);
}

// fallow-ignore-next-line complexity
export function computePositionGate(options: {
  crossAccountAskReturnFraction: number | null;
  secretPosition: SecretSourcePosition | undefined;
  currentTime: Date;
  crossAccountThresholdMultiplier?: number;
}): PositionGateResult {
  const multiplier = options.crossAccountThresholdMultiplier ?? 1;
  const crossAccountYesThreshold = (getCrossAccountYesDownPct(options.currentTime) / 100) * multiplier;
  const crossAccountYes =
    options.crossAccountAskReturnFraction !== null &&
    options.crossAccountAskReturnFraction < -crossAccountYesThreshold;

  const qualityToBuy = isQualityToBuy(options.secretPosition);
  const percentOfBalance = Number(options.secretPosition?.percentOfBalance ?? 0);
  const rawDaytradeScore = options.secretPosition?.daytradeScore;
  const daytradeScore =
    rawDaytradeScore != null && Number.isFinite(Number(rawDaytradeScore))
      ? Number(rawDaytradeScore)
      : null;

  const thresholds = getStrongStockYesThresholds(options.currentTime);

  const goodBooleanScore = countGoodBooleans(options.secretPosition);
  // Full thesis = buyFraction >= 1.0 (only willBuy can push past it). No
  // rollup = false.
  const gateFeedFraction = getFeedBuyFraction(options.secretPosition);
  const allBooleansGood = gateFeedFraction !== null && gateFeedFraction >= 1.0;

  // basic: isQualityToBuy, a bullish daytradeScore below the basic threshold,
  // or percentOfBalance above the basic threshold (both time-scaled)
  const basicThresholds = getBasicStockYesThresholds(options.currentTime);
  const basicStockYes =
    qualityToBuy ||
    (daytradeScore !== null && daytradeScore < basicThresholds.daytradeScore) ||
    percentOfBalance > basicThresholds.pct;

  // strong: isQualityToBuy + pct or daytradeScore crosses time-scaled threshold
  const strongStockYes =
    qualityToBuy &&
    (percentOfBalance > thresholds.pct ||
      (daytradeScore !== null && daytradeScore < thresholds.daytradeScore));

  const signals: PositionGateSignals = {
    crossAccountYes,
    basicStockYes,
    strongStockYes,
    goodBooleanScore,
    allBooleansGood,
  };

  let maxTargetPct = 0;
  if (crossAccountYes && strongStockYes) {
    maxTargetPct = getStrongYesMaxTargetPct();
  } else if (crossAccountYes && basicStockYes) {
    maxTargetPct = getBothYesMaxTargetPct();
  } else if (strongStockYes) {
    maxTargetPct = getSingleYesMaxTargetPct();
  } else if (crossAccountYes) {
    maxTargetPct = getSingleYesMaxTargetPct();
  } else if (basicStockYes) {
    maxTargetPct = getBasicYesMaxTargetPct();
  }

  // Each good boolean adds a fixed boost on top of the signal tier
  maxTargetPct = Math.min(maxTargetPct + goodBooleanScore * getBooleanBoostPct(), 1.0);

  return {
    signals,
    maxTargetPct,
    strongStockYesPctThreshold: thresholds.pct,
    strongStockYesScoreThreshold: thresholds.daytradeScore,
    basicStockYesPctThreshold: basicThresholds.pct,
    basicStockYesScoreThreshold: basicThresholds.daytradeScore,
  };
}
