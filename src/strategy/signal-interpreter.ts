import type { SecretSourcePosition } from "~/strategy/secret/types";
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

// Returns a raw buy-weight boost (0-400 scale) based on the aggressiveness
// level signalled by the feed's validated thesis rollup (buyFraction).
// Level 1 (aggressive): +100. Level 2 (very aggressive): +200.
//
// Thresholds come from a measured forward-return backtest (2026-07-19,
// n=2242 fills, intraday horizon): buyFraction > 1.0 (full thesis + willBuy
// icing) was the best bucket at +0.91% avg / 68% win; buyFraction = 1.0 (4/4
// thesis alone) +0.72% / 66%. The previous inputs — daytradeScore ≤ −100/−200,
// returnPerc < −2/−5%, superRecScore > 80 — were unvalidated dip-polarity
// defaults; the same backtest showed the daytradeScore legs boosted the
// -70..-150 death valley (win 16-29%), so all three are dropped.
export function computeAggressivenessBoost(position: SecretSourcePosition): number {
  let level = 0;

  const buyFraction = Number(position.buyFraction);
  if (Number.isFinite(buyFraction)) {
    if (buyFraction > 1.0) level = 2;
    else if (buyFraction >= 1.0) level = 1;
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
