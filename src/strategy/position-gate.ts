import { SecretSourcePosition } from "~/bot/secret/types";
import {
  getCashAccountSeedEndMinute,
  getSecretAutoSeedWindowStartMinute,
} from "./seeding-windows";

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
}

function readEnvPct(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBooleanFlag(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1;
  return ["true", "1", "yes"].includes(String(raw ?? "").trim().toLowerCase());
}

// BOT_CROSS_ACCOUNT_YES_DOWN_PCT is the late-day (lenient) threshold for the cross-account YES signal.
// At window start (9:30am): requires 2x that dip (strict).
// At window end (1pm): requires exactly the configured dip.
function getCrossAccountYesDownPct(currentTime: Date): number {
  const base = readEnvPct("BOT_CROSS_ACCOUNT_YES_DOWN_PCT", 10);
  const minuteOfDay = currentTime.getHours() * 60 + currentTime.getMinutes();
  const startMinute = getSecretAutoSeedWindowStartMinute();
  const endMinute = getCashAccountSeedEndMinute();
  const duration = endMinute - startMinute;
  const t = duration > 0
    ? Math.max(0, Math.min(1, (minuteOfDay - startMinute) / duration))
    : 1;
  // t=0 (9:30am): 2× base (strict). t=1 (1pm): 1× base (lenient).
  return base * (2 - t);
}

// Max percentOfBalance required at end-of-day (1pm) for strong YES.
// At window start (9:30am) the threshold is max/2.
function getStrongStockYesMaxPct(): number {
  return readEnvPct("BOT_GATE_STRONG_STOCK_YES_MAX_PCT", 30);
}

// daytradeScore magnitude for strong YES.
// At window start (9:30am): score must be < -max (strict).
// At window end (1pm): score must be < -max/2 (relaxed).
function getStrongDaytradeScoreMax(): number {
  return readEnvPct("BOT_GATE_STRONG_DAYTRADE_SCORE_MAX", 100);
}

// Additional maxTargetPct added per "good" boolean signal (isAboveMinSinFloor etc.)
function getBooleanBoostPct(): number {
  return readEnvPct("BOT_GATE_BOOLEAN_BOOST_PCT", 0.03);
}

export function getSingleYesMaxTargetPct(): number {
  return readEnvPct("BOT_GATE_SINGLE_YES_MAX_TARGET_PCT", 0.15);
}

export function getBothYesMaxTargetPct(): number {
  return readEnvPct("BOT_GATE_BOTH_YES_MAX_TARGET_PCT", 0.25);
}

export function getStrongYesMaxTargetPct(): number {
  return readEnvPct("BOT_GATE_STRONG_YES_MAX_TARGET_PCT", 0.35);
}

export function getMarginTargetMultiplier(): number {
  return readEnvPct("BOT_MARGIN_MAX_TARGET_MULTIPLIER", 1.33);
}

export function getCrossAccountThresholdMultiplier(): number {
  return readEnvPct("BOT_MARGIN_CROSS_ACCOUNT_THRESHOLD_MULTIPLIER", 2);
}

// percentOfBalance: max/2 at window start → max at window end (gets stricter late)
// daytradeScore:   -max at window start → -max/2 at window end (relaxes late)
function getStrongStockYesThresholds(currentTime: Date): {
  pct: number;
  daytradeScore: number;
} {
  const minuteOfDay = currentTime.getHours() * 60 + currentTime.getMinutes();
  const startMinute = getSecretAutoSeedWindowStartMinute();
  const endMinute = getCashAccountSeedEndMinute();
  const duration = endMinute - startMinute;

  const t = duration > 0
    ? Math.max(0, Math.min(1, (minuteOfDay - startMinute) / duration))
    : 1;

  const maxPct = getStrongStockYesMaxPct();
  const maxScore = getStrongDaytradeScoreMax();

  // pct: starts at max/2, rises to max
  const pct = (maxPct / 2) * (1 + t);

  // daytradeScore: starts at -max (strict), relaxes to -max/2
  const daytradeScore = -(maxScore / 2) * (2 - t);

  return { pct, daytradeScore };
}

// daytradeScore: 1 pt per 100 below -50, capped at 3.
// -50 to -150 → 1, -150 to -250 → 2, -250+ → 3
function getDaytradeScorePoints(position: SecretSourcePosition | undefined): number {
  const raw = position?.daytradeScore;
  if (raw == null) return 0;
  const score = Number(raw);
  if (!Number.isFinite(score) || score > -50) return 0;
  return Math.min(3, Math.floor((Math.abs(score) - 50) / 100) + 1);
}

// Returns 0–10: 5 state booleans (1pt each) + willBuy (2pts) + daytradeScore points (0–3).
// Max conviction = all booleans + willBuy + daytradeScore ≤ -250.
export function countGoodBooleans(position: SecretSourcePosition | undefined): number {
  if (!position) return 0;
  let count = 0;
  if (toBooleanFlag(position.isAboveMinSinFloor)) count++;
  if (toBooleanFlag(position.aboveMinSis)) count++;
  if (toBooleanFlag(position.isAboveStabMin)) count++;
  if (toBooleanFlag(position.isClearedToBuy)) count++;
  if (toBooleanFlag(position.currentlyAboveMinBuyWeight)) count++;
  if (toBooleanFlag(position.willBuy)) count += 2;
  count += getDaytradeScorePoints(position);
  return count;
}

// For the margin seed decision only: isClearedToBuy OR currentlyAboveMinBuyWeight counts as one slot.
// This gives 5 effective slots; threshold is 4/5.
function countMergedBooleansForMarginSeed(position: SecretSourcePosition | undefined): number {
  if (!position) return 0;
  let count = 0;
  if (toBooleanFlag(position.isAboveMinSinFloor)) count++;
  if (toBooleanFlag(position.aboveMinSis)) count++;
  if (toBooleanFlag(position.isAboveStabMin)) count++;
  if (toBooleanFlag(position.isClearedToBuy) || toBooleanFlag(position.currentlyAboveMinBuyWeight)) count++;
  if (toBooleanFlag(position.willBuy)) count++;
  return count;
}

// Seed margin when 4 of the 5 effective slots are good (isClearedToBuy||currentlyAboveMinBuyWeight = 1 slot)
export function shouldSeedMarginFromBooleans(
  position: SecretSourcePosition | undefined,
): boolean {
  return countMergedBooleansForMarginSeed(position) >= 4;
}

// Per-action buy exposure surplus added on top of the account-type base for both accounts.
// Score is 0–10 (willBuy=2pts, daytradeScore up to 3pts).
export function getBooleanSurplusPct(goodBooleanScore: number): number {
  if (goodBooleanScore >= 8) return 0.30;
  if (goodBooleanScore >= 7) return 0.25;
  if (goodBooleanScore >= 6) return 0.20;
  if (goodBooleanScore >= 5) return 0.15;
  if (goodBooleanScore >= 4) return 0.10;
  if (goodBooleanScore >= 3) return 0.05;
  return 0;
}

function isQualityToBuy(position: SecretSourcePosition | undefined): boolean {
  return position != null && toBooleanFlag(position.qualityToBuy);
}

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
  const allBooleansGood = goodBooleanScore === 10;

  // basic: just qualityToBuy
  const basicStockYes = qualityToBuy;

  // strong: qualityToBuy + pct or daytradeScore crosses time-scaled threshold
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
  }

  // Each good boolean adds a fixed boost on top of the signal tier
  maxTargetPct = Math.min(maxTargetPct + goodBooleanScore * getBooleanBoostPct(), 1.0);

  return {
    signals,
    maxTargetPct,
    strongStockYesPctThreshold: thresholds.pct,
    strongStockYesScoreThreshold: thresholds.daytradeScore,
  };
}

export function getMarginPositionMaxTargetPct(cashMaxTargetPct: number): number {
  return cashMaxTargetPct * getMarginTargetMultiplier();
}
