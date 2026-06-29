import { SecretSourcePosition } from "./secret/types";
import {
  getCashAccountSeedEndMinute,
  getSecretAutoSeedWindowStartMinute,
} from "./seeding-windows";

export interface CashPositionSignals {
  marginYes: boolean;
  basicStockYes: boolean;
  strongStockYes: boolean;
}

export interface CashPositionGateResult {
  signals: CashPositionSignals;
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

function getMarginYesDownPct(): number {
  return readEnvPct("BOT_CASH_MARGIN_YES_DOWN_PCT", 10);
}

// Max percentOfBalance required at end-of-day for strong YES.
// At window start (9:30am) the threshold is max/2.
function getStrongStockYesMaxPct(): number {
  return readEnvPct("BOT_CASH_STRONG_STOCK_YES_MAX_PCT", 30);
}

// daytradeScore magnitude required at end-of-day: score must be < -max.
// At window start the threshold is -(max/2).
function getStrongDaytradeScoreMax(): number {
  return readEnvPct("BOT_CASH_STRONG_DAYTRADE_SCORE_MAX", 100);
}

export function getSingleYesMaxTargetPct(): number {
  return readEnvPct("BOT_CASH_SINGLE_YES_MAX_TARGET_PCT", 0.15);
}

export function getBothYesMaxTargetPct(): number {
  return readEnvPct("BOT_CASH_BOTH_YES_MAX_TARGET_PCT", 0.25);
}

export function getStrongYesMaxTargetPct(): number {
  return readEnvPct("BOT_CASH_STRONG_YES_MAX_TARGET_PCT", 0.35);
}

export function getMarginTargetMultiplier(): number {
  return readEnvPct("BOT_MARGIN_MAX_TARGET_MULTIPLIER", 1.33);
}

// Both thresholds scale linearly from max/2 at window start (9:30am) to max at window end (1pm).
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

  // At t=0: max/2. At t=1: max.
  const pct = (maxPct / 2) * (1 + t);
  const daytradeScore = -(maxScore / 2) * (1 + t);

  return { pct, daytradeScore };
}

function isBuyEligible(position: SecretSourcePosition | undefined): boolean {
  if (!position) return false;
  const raw = position.buyEligible;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1;
  const normalized = String(raw ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

export function computeCashPositionGate(options: {
  marginAskReturnFraction: number | null;
  secretPosition: SecretSourcePosition | undefined;
  currentTime: Date;
}): CashPositionGateResult {
  const marginYesThreshold = getMarginYesDownPct() / 100;
  const marginYes =
    options.marginAskReturnFraction !== null &&
    options.marginAskReturnFraction < -marginYesThreshold;

  const buyEligible = isBuyEligible(options.secretPosition);
  const percentOfBalance = Number(options.secretPosition?.percentOfBalance ?? 0);
  const rawDaytradeScore = options.secretPosition?.daytradeScore;
  const daytradeScore =
    rawDaytradeScore != null && Number.isFinite(Number(rawDaytradeScore))
      ? Number(rawDaytradeScore)
      : null;

  const thresholds = getStrongStockYesThresholds(options.currentTime);

  // basic: just buyEligible
  const basicStockYes = buyEligible;

  // strong: buyEligible + either percentOfBalance or daytradeScore crosses time-scaled threshold
  const strongStockYes =
    buyEligible &&
    (percentOfBalance > thresholds.pct ||
      (daytradeScore !== null && daytradeScore < thresholds.daytradeScore));

  const signals: CashPositionSignals = { marginYes, basicStockYes, strongStockYes };

  let maxTargetPct = 0;
  if (marginYes && strongStockYes) {
    maxTargetPct = getStrongYesMaxTargetPct();
  } else if (marginYes && basicStockYes) {
    maxTargetPct = getBothYesMaxTargetPct();
  } else if (strongStockYes) {
    maxTargetPct = getSingleYesMaxTargetPct();
  } else if (marginYes) {
    maxTargetPct = getSingleYesMaxTargetPct();
  }

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
