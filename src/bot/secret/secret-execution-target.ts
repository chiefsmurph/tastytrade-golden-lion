import { ExecutionTargets } from "~/strategy/evaluate-trading-strategy";
import {
  toSecretExecutionTargets,
  getBuyWeightsFromPositions,
  getBuyWeightForSymbol,
  normalizeTicker,
} from "~/strategy/signal-interpreter";
import {
  getCachedSecretSourcePositions,
  getSecretPositionsSourceKey,
  startSecretSocketConnection,
} from "./secret-socket-state";

export async function getSecretExecutionTargetForRun(options: {
  baseTargets: ExecutionTargets;
  symbols: string[];
}): Promise<ExecutionTargets | null> {
  if (!getSecretPositionsSourceKey()) return null;

  startSecretSocketConnection();

  const cachedSourcePositions = getCachedSecretSourcePositions();
  const buyWeights = getBuyWeightsFromPositions(cachedSourcePositions, options.symbols);
  if (buyWeights.length === 0) return null;

  const averageBuyWeight =
    buyWeights.reduce((sum, value) => sum + value, 0) / buyWeights.length;

  return toSecretExecutionTargets(averageBuyWeight, options.baseTargets);
}

export function getSecretBuyWeightForSymbol(symbol: string): number | null {
  if (!getSecretPositionsSourceKey()) return null;

  startSecretSocketConnection();
  return getBuyWeightForSymbol(getCachedSecretSourcePositions(), symbol);
}

export interface SecretPositionSignals {
  rawBuyWeight: number | null;
  daytradeScore: number | null;
  returnPerc: number | null;
  superRecScore: number | null;
}

export function getSecretPositionSignalsForSymbol(symbol: string): SecretPositionSignals | null {
  if (!getSecretPositionsSourceKey()) return null;

  startSecretSocketConnection();

  const match = getCachedSecretSourcePositions().find((position) => {
    const ticker = typeof position.ticker === "string" ? position.ticker : "";
    return normalizeTicker(ticker) === normalizeTicker(symbol);
  });

  if (!match) return null;

  const rawBuyWeight = Number(match.buyWeight);
  const daytradeScore = Number(match.daytradeScore);
  const returnPerc = Number(match.returnPerc);
  const superRecScore = Number(match.superRecScore);

  return {
    rawBuyWeight: Number.isFinite(rawBuyWeight) ? rawBuyWeight : null,
    daytradeScore: Number.isFinite(daytradeScore) ? daytradeScore : null,
    returnPerc: Number.isFinite(returnPerc) ? returnPerc : null,
    superRecScore: Number.isFinite(superRecScore) ? superRecScore : null,
  };
}

export function getSecretExecutionTargetForSymbol(options: {
  baseTargets: ExecutionTargets;
  symbol: string;
}): ExecutionTargets | null {
  if (!getSecretPositionsSourceKey()) return null;

  startSecretSocketConnection();

  const buyWeight = getBuyWeightForSymbol(
    getCachedSecretSourcePositions(),
    options.symbol,
  );
  if (buyWeight === null) return null;

  return toSecretExecutionTargets(buyWeight, options.baseTargets);
}
