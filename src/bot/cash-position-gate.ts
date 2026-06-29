import { SecretSourcePosition } from "./secret/types";

export interface CashPositionSignals {
  marginYes: boolean;
  basicStockYes: boolean;
  strongStockYes: boolean;
}

export interface CashPositionGateResult {
  signals: CashPositionSignals;
  maxTargetPct: number;
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

function getBasicStockYesMinPctOfBalance(): number {
  return readEnvPct("BOT_CASH_BASIC_STOCK_YES_MIN_PCT_OF_BALANCE", 10);
}

function getStrongStockYesMinPctOfBalance(): number {
  return readEnvPct("BOT_CASH_STRONG_STOCK_YES_MIN_PCT_OF_BALANCE", 30);
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
}): CashPositionGateResult {
  const marginYesThreshold = getMarginYesDownPct() / 100;
  const marginYes =
    options.marginAskReturnFraction !== null &&
    options.marginAskReturnFraction < -marginYesThreshold;

  const buyEligible = isBuyEligible(options.secretPosition);
  const percentOfBalance = Number(options.secretPosition?.percentOfBalance ?? 0);
  const basicStockYes = buyEligible && percentOfBalance > getBasicStockYesMinPctOfBalance();
  const strongStockYes = buyEligible && percentOfBalance > getStrongStockYesMinPctOfBalance();

  const signals: CashPositionSignals = { marginYes, basicStockYes, strongStockYes };

  let maxTargetPct = 0;
  if (marginYes && strongStockYes) {
    maxTargetPct = getStrongYesMaxTargetPct();
  } else if (marginYes && basicStockYes) {
    maxTargetPct = getBothYesMaxTargetPct();
  } else if (marginYes || strongStockYes) {
    maxTargetPct = getSingleYesMaxTargetPct();
  } else if (basicStockYes) {
    maxTargetPct = getSingleYesMaxTargetPct();
  }

  return { signals, maxTargetPct };
}

export function getMarginPositionMaxTargetPct(cashMaxTargetPct: number): number {
  return cashMaxTargetPct * getMarginTargetMultiplier();
}
