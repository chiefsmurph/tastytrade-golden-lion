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

// daytradeScore: 1 pt per 100 below -50, capped at DAYTRADE_SCORE_MAX_PTS.
// -50 to -150 → 1, -150+ → 2
function getDaytradeScorePoints(position: SecretSourcePosition | undefined): number {
  const raw = position?.daytradeScore;
  if (raw == null) return 0;
  const score = Number(raw);
  if (!Number.isFinite(score) || score > -50) return 0;
  return Math.min(DAYTRADE_SCORE_MAX_PTS, Math.floor((Math.abs(score) - 50) / 100) + 1);
}

// The thesis scale — the "100%": every flag below (1pt each) + daytradeScore
// (0–DAYTRADE_SCORE_MAX_PTS) → 0–THESIS_MAX. willBuy is deliberately NOT part
// of this scale. Adding/removing a feed flag here self-updates THESIS_MAX and
// every denominator/cap derived from it.
const THESIS_FLAGS = [
  "isQualityToBuy",
  "isAboveMinSis",
  "isAboveMinSin",
  "isAboveMinStab",
  "isInBssRange",
  "isAboveMinPsWordPerc",
  "isClearedToBuy",
  "isAboveMinBuyWeight",
] as const satisfies ReadonlyArray<keyof SecretSourcePosition>;

const DAYTRADE_SCORE_MAX_PTS = 2;
export const THESIS_MAX = THESIS_FLAGS.length + DAYTRADE_SCORE_MAX_PTS; // self-updating

function countThesisBooleanScore(
  position: SecretSourcePosition | undefined,
  mergeCleared = false, // true: isClearedToBuy || isAboveMinBuyWeight = 1 slot
): number {
  if (!position) return 0;
  let count = 0;
  for (const flag of THESIS_FLAGS) {
    if (flag === "isAboveMinBuyWeight" && mergeCleared) continue;
    if (flag === "isClearedToBuy" && mergeCleared) {
      if (toBooleanFlag(position.isClearedToBuy) || toBooleanFlag(position.isAboveMinBuyWeight)) count++;
      continue;
    }
    if (toBooleanFlag(position[flag])) count++;
  }
  return count + getDaytradeScorePoints(position);
}

// willBuy is icing on the cake: +2 on top of the thesis scale, able to push a score
// past "full" but never required to reach it — every threshold downstream is reachable
// by thesis alone. Skipped when isBuyEligible is explicitly false, since buy-intent is
// meaningless while the source account is liquidating (EOD/open windows).
// Total range 0–(THESIS_MAX + 2).
export function countGoodBooleans(position: SecretSourcePosition | undefined): number {
  if (!position) return 0;
  const buyEligibleExplicitlyFalse =
    position.isBuyEligible !== undefined && !toBooleanFlag(position.isBuyEligible);
  const willBuyIcing =
    !buyEligibleExplicitlyFalse && toBooleanFlag(position.willBuy) ? 2 : 0;
  return countThesisBooleanScore(position) + willBuyIcing;
}

// Margin seed: 4 points on the merged thesis scale (isClearedToBuy ||
// isAboveMinBuyWeight collapse to one slot → THESIS_MAX − 1 effective points,
// daytradeScore included).
export function shouldSeedMarginFromBooleans(
  position: SecretSourcePosition | undefined,
): boolean {
  return countThesisBooleanScore(position, true) >= 4;
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
  // Every THESIS_FLAG true — the boolean set, not the scale total (daytrade
  // points are a separate, non-boolean contribution).
  const allBooleansGood = THESIS_FLAGS.every((flag) =>
    toBooleanFlag(options.secretPosition?.[flag]),
  );

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
