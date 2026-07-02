import type { SecretSourcePosition } from "~/bot/secret/types";
import { ExecutionTargets } from "./evaluate-trading-strategy";

function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

export function normalizeBuyWeight(buyWeight: number): number {
  // Incoming scale is typically around 50..400.
  return clamp(buyWeight / 400, 0, 1);
}

// Returns a raw buy-weight boost (0-400 scale) based on the max aggressiveness
// level signalled by daytradeScore, returnPerc, and superRecScore.
// Level 1 (aggressive): +100. Level 2 (very aggressive): +200.
export function computeAggressivenessBoost(position: SecretSourcePosition): number {
  let level = 0;

  const daytradeScore = Number(position.daytradeScore);
  if (Number.isFinite(daytradeScore)) {
    if (daytradeScore <= -200) level = Math.max(level, 2);
    else if (daytradeScore <= -100) level = Math.max(level, 1);
  }

  const returnPerc = Number(position.returnPerc);
  if (Number.isFinite(returnPerc)) {
    if (returnPerc < -5) level = Math.max(level, 2);
    else if (returnPerc < -2) level = Math.max(level, 1);
  }

  const superRecScore = Number(position.superRecScore);
  if (Number.isFinite(superRecScore) && superRecScore > 80) {
    level = Math.max(level, 1);
  }

  return level * 100;
}

export function toSecretExecutionTargets(
  buyWeight: number,
  baseTargets: ExecutionTargets,
): ExecutionTargets {
  const normalizedBuyWeight = normalizeBuyWeight(buyWeight);

  const targetAccountExposure = roundToTwoDecimals(
    clamp(0.4 + normalizedBuyWeight * 0.55, 0, 1),
  );
  const askWeight = roundToTwoDecimals(clamp(0.2 + normalizedBuyWeight * 0.6, 0, 0.95));
  const midWeight = roundToTwoDecimals(clamp(0.55 - normalizedBuyWeight * 0.2, 0.05, 0.7));
  const bidWeight = roundToTwoDecimals(clamp(1 - askWeight - midWeight, 0, 0.75));
  const normalizedMid = roundToTwoDecimals(clamp(1 - askWeight - bidWeight, 0, 1));

  return {
    targetDTE: baseTargets.targetDTE,
    targetAccountExposure,
    askWeight,
    bidWeight,
    midWeight: normalizedMid,
  };
}

export function getBuyWeightsFromPositions(
  sourcePositions: SecretSourcePosition[],
  symbols: string[],
): number[] {
  const normalizedSymbols = new Set(symbols.map(normalizeTicker));

  return sourcePositions
    .filter((position): position is SecretSourcePosition => {
      const ticker = typeof position.ticker === "string" ? position.ticker : "";
      const buyWeight = Number(position.buyWeight);
      return (
        normalizedSymbols.has(normalizeTicker(ticker)) &&
        Number.isFinite(buyWeight)
      );
    })
    .map((position) => Number(position.buyWeight) + computeAggressivenessBoost(position));
}

export function getBuyWeightForSymbol(
  sourcePositions: SecretSourcePosition[],
  symbol: string,
): number | null {
  const normalizedSymbol = normalizeTicker(symbol);
  const match = sourcePositions.find((position) => {
    const ticker = typeof position.ticker === "string" ? position.ticker : "";
    return normalizeTicker(ticker) === normalizedSymbol;
  });

  if (!match) return null;

  const buyWeight = Number(match.buyWeight);
  if (!Number.isFinite(buyWeight)) return null;
  return buyWeight + computeAggressivenessBoost(match);
}
