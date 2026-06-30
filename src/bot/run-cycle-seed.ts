import { getAccountMarginOrCash, getCashAccountNumber, isReadOnlyAccount } from "~/core/default-account";
import { getGroupSideForPositions, type PositionGroupEvaluation } from "./evaluate-position";
import { getPositionEvaluations } from "./get-position-evaluations";
import { RunSeedOrder } from "./run-history";
import seedSymbol, { SeedSymbolResult } from "./seed-symbol";
import { MARGIN_SEED_FROM_CASH_ORDER_SOURCE } from "./order-sources";
import { isWithinCashAccountSeedFromMarginWindow, getCashAccountSeedEndMinute } from "./seeding-windows";
import type { SecretSourcePosition } from "./secret/types";
import { countGoodBooleans, getBooleanSurplusPct, shouldSeedMarginFromBooleans } from "./cash-position-gate";
import { recordPositionOpened, getRegistryEntry } from "./position-registry";
import { getUnderlyingIvMetrics } from "~/core/market-metrics";

export type MarginSeedResult = RunSeedOrder;

interface MarginSeedConfig {
  minDownPct: number;
  maxDownPct: number;
}

// Feature is opt-in: disabled if BOT_MARGIN_SEED_FROM_CASH_MIN_DOWN_PCT is unset.
// BOT_MARGIN_SEED_FROM_CASH_MAX_DOWN_PCT caps how deep a loss will still trigger
// a seed — beyond this the position is too close to the bid stop-loss floor.
// Defaults to 18 if unset.
function getMarginSeedConfig(): MarginSeedConfig | null {
  const rawMin = process.env.BOT_MARGIN_SEED_FROM_CASH_MIN_DOWN_PCT?.trim();
  if (!rawMin) return null;
  const minDownPct = Number(rawMin);
  if (!Number.isFinite(minDownPct) || minDownPct <= 0) return null;

  const rawMax = process.env.BOT_MARGIN_SEED_FROM_CASH_MAX_DOWN_PCT?.trim();
  const parsedMax = rawMax ? Number(rawMax) : NaN;
  const maxDownPct = Number.isFinite(parsedMax) && parsedMax > minDownPct ? parsedMax : 18;

  if (minDownPct >= maxDownPct) return null;
  return { minDownPct, maxDownPct };
}

function getAskReturnPct(evaluation: PositionGroupEvaluation): number | null {
  const fill = evaluation.metrics.weightedAverageFill;
  if (!(fill > 0)) return null;
  return ((evaluation.metrics.currentAskPrice - fill) / fill) * 100;
}

// Time-of-day multiplier: early morning = 1.5 (conservative, bigger loss needed).
// Scales linearly down to 0.7 at the cash seed window end (~1 PM).
// Both min and max thresholds are multiplied, so the window shifts down as the day progresses.
function getTimeOfDaySeedMultiplier(currentTime: Date): number {
  const OPEN_MINUTE = 6 * 60 + 30; // 6:30 AM
  const endMinute = getCashAccountSeedEndMinute();
  const minuteOfDay = currentTime.getHours() * 60 + currentTime.getMinutes();
  const span = endMinute - OPEN_MINUTE;
  const t = span > 0 ? Math.max(0, Math.min(1, (minuteOfDay - OPEN_MINUTE) / span)) : 1;
  // t=0 (open): 1.5 (conservative). t=1 (close): 0.7 (aggressive).
  return 1.5 - 0.8 * t;
}

// Age multiplier: new position (day 0) = 1.5 (conservative, give it time).
// Scales linearly down to 0.7 at 7+ days (aggressive, thesis is confirmed persistent).
function getPositionAgeSeedMultiplier(positionAgeDays: number | null): number {
  if (positionAgeDays === null) return 1.0; // unknown age → neutral
  const t = Math.max(0, Math.min(1, positionAgeDays / 7));
  // t=0 (day 0): 1.5. t=1 (day 7+): 0.7.
  return 1.5 - 0.8 * t;
}

// Boolean multiplier: good signals lower thresholds so seeding fires on smaller losses.
// No data and weak/bad scores are neutral (1.0) — only positive signals help, never penalize.
// Score 0–10: <3=neutral (1.0×), 3-4=slight boost (0.95×), 5-7=good (0.85×), 8+=great (0.7×).
function getBooleanSeedMultiplier(goodBooleanScore: number | null): number {
  if (goodBooleanScore === null) return 1.0;
  if (goodBooleanScore >= 8) return 0.7;
  if (goodBooleanScore >= 5) return 0.85;
  if (goodBooleanScore >= 3) return 0.95;
  return 1.0;
}

// Returns position age in days using the registry (primary) or Tastytrade API date (fallback).
async function getPositionAgeDays(
  cashAccountNumber: string,
  symbol: string,
  currentTime: Date,
  evaluation: PositionGroupEvaluation,
): Promise<number | null> {
  const entry = await getRegistryEntry(cashAccountNumber, symbol);
  if (entry?.openedAt) {
    return (currentTime.getTime() - new Date(entry.openedAt).getTime()) / 86_400_000;
  }

  const createdAt = evaluation.positions[0]?.["created-at"];
  if (createdAt) {
    return (currentTime.getTime() - new Date(createdAt).getTime()) / 86_400_000;
  }

  return null;
}

// Returns the effective thresholds after applying time-of-day, position-age, and boolean scaling.
// maxDownPct is capped at the configured max — scaling can only lower it, never raise it.
// When combined multiplier is high enough that minDownPct exceeds maxDownPct, no seed fires —
// this is intentional (e.g., bad signals + new position early in day = don't seed).
function getScaledThresholds(
  config: MarginSeedConfig,
  timeFactor: number,
  ageFactor: number,
  booleanFactor: number,
): MarginSeedConfig {
  const combined = timeFactor * ageFactor * booleanFactor;
  return {
    minDownPct: Math.max(config.minDownPct * combined, 1),
    maxDownPct: Math.min(config.maxDownPct * combined, config.maxDownPct),
  };
}

interface SeedDecision {
  shouldSeed: boolean;
  ivRank: number | null;
  reason: string;
}

// Two zones split at the midpoint of [minDownPct, maxDownPct]:
//   Early zone  (loss < mid): seed if booleans ≥ 4/5  OR  IV rank ≥ 50
//   Deep zone   (loss ≥ mid): seed if booleans ≥ 7/10 OR  IV rank ≥ 70
// Boolean score takes precedence to avoid an extra API call when data is present.
// When neither source is available, don't seed — unknown thesis = no action.
async function getSeedDecision(
  symbol: string,
  lossDepth: number,
  goodBooleanScore: number | null,
  secretPosition: SecretSourcePosition | undefined,
  thresholds: MarginSeedConfig,
): Promise<SeedDecision> {
  const midDownPct = (thresholds.minDownPct + thresholds.maxDownPct) / 2;
  const isDeepLoss = lossDepth >= midDownPct;

  if (goodBooleanScore !== null) {
    if (isDeepLoss) {
      const passes = goodBooleanScore >= 7;
      return {
        shouldSeed: passes,
        ivRank: null,
        reason: passes
          ? `boolean ${goodBooleanScore}/10 passes deep-loss threshold (7)`
          : `boolean ${goodBooleanScore}/10 below deep-loss threshold (7)`,
      };
    } else {
      const passes = shouldSeedMarginFromBooleans(secretPosition);
      return {
        shouldSeed: passes,
        ivRank: null,
        reason: passes
          ? `boolean ${goodBooleanScore}/10 passes early-loss threshold (4/5 signals)`
          : `boolean ${goodBooleanScore}/10 below early-loss threshold (4/5 signals)`,
      };
    }
  }

  // No secret data — fall back to IV rank as thesis proxy
  const ivMetrics = await getUnderlyingIvMetrics(symbol);
  const ivRank = ivMetrics?.ivRank ?? null;

  if (ivRank === null) {
    return { shouldSeed: false, ivRank: null, reason: "no boolean data and IV rank unavailable" };
  }

  const requiredIvRank = isDeepLoss ? 70 : 50;
  const passes = ivRank >= requiredIvRank;
  return {
    shouldSeed: passes,
    ivRank,
    reason: passes
      ? `IV rank ${ivRank.toFixed(0)} passes ${isDeepLoss ? "deep" : "early"}-loss threshold (${requiredIvRank})`
      : `IV rank ${ivRank.toFixed(0)} below ${isDeepLoss ? "deep" : "early"}-loss threshold (${requiredIvRank})`,
  };
}

function mapMarginSeedOrderForRunHistory(
  sourceAccountNumber: string,
  askReturnPctSource: number,
  result: SeedSymbolResult,
  goodBooleanScore: number | null,
  booleanSurplusPct: number | null,
  ivRank: number | null,
  decisionReason: string,
): MarginSeedResult {
  return {
    accountNumber: result.accountNumber,
    askReturnPctSource,
    booleanSurplusPct,
    candidateSymbol: result.candidateSymbol ?? null,
    estimatedOrderCost: result.estimatedOrderCost ?? null,
    goodBooleanScore,
    ivRank,
    limitPrice: result.limitPrice ?? null,
    placedOrder: result.placedOrder,
    scope: "run-cycle-margin-from-cash",
    side: result.side,
    skippedReason: result.skippedReason ?? null,
    sourceAccountNumber,
    symbol: result.symbol,
    triggerReason: `cash down ${Math.abs(askReturnPctSource).toFixed(1)}% ask — ${decisionReason}`,
  };
}

export async function maybeSeedMarginAccountFromCashAccount(
  accountNumber: string,
  currentTime: Date,
  excludedUnderlyingSymbols: ReadonlySet<string> = new Set(),
  secretPositions: readonly SecretSourcePosition[] = [],
): Promise<MarginSeedResult[]> {
  if (isReadOnlyAccount(accountNumber)) {
    return [];
  }

  const accountMarginOrCash = await getAccountMarginOrCash(accountNumber);
  if (accountMarginOrCash !== "margin") {
    return [];
  }

  if (!isWithinCashAccountSeedFromMarginWindow(currentTime)) {
    return [];
  }

  const config = getMarginSeedConfig();
  if (config === null) {
    return [];
  }

  const cashAccountNumber = await getCashAccountNumber();
  if (cashAccountNumber === accountNumber) {
    return [];
  }

  const timeFactor = getTimeOfDaySeedMultiplier(currentTime);
  const cashEvaluations = await getPositionEvaluations(cashAccountNumber);
  const localExcluded = new Set(
    Array.from(excludedUnderlyingSymbols, (s) => String(s).toUpperCase()),
  );

  const results: MarginSeedResult[] = [];

  for (const evaluation of cashEvaluations) {
    if (evaluation.strategy.action !== "MANAGE_ALLOCATION") continue;

    const side = getGroupSideForPositions(evaluation.positions);
    if (side !== "call" && side !== "put") continue;

    const symbol = String(evaluation.underlyingSymbol ?? "").toUpperCase();
    if (!symbol || localExcluded.has(symbol)) continue;

    const askReturnPct = getAskReturnPct(evaluation);
    if (askReturnPct === null) continue;

    // Boolean lookup happens before threshold scaling — score influences the window itself.
    const secretPosition = secretPositions.find(
      (p) => String(p.ticker ?? "").trim().toUpperCase() === symbol,
    );
    const goodBooleanScore = secretPosition != null ? countGoodBooleans(secretPosition) : null;
    const booleanSurplusPct = goodBooleanScore != null ? getBooleanSurplusPct(goodBooleanScore) : null;

    const positionAgeDays = await getPositionAgeDays(cashAccountNumber, symbol, currentTime, evaluation);
    const ageFactor = getPositionAgeSeedMultiplier(positionAgeDays);
    const booleanFactor = getBooleanSeedMultiplier(goodBooleanScore);
    const thresholds = getScaledThresholds(config, timeFactor, ageFactor, booleanFactor);

    const lossDepth = -askReturnPct;
    if (lossDepth < thresholds.minDownPct || lossDepth > thresholds.maxDownPct) continue;

    const decision = await getSeedDecision(
      symbol,
      lossDepth,
      goodBooleanScore,
      secretPosition,
      thresholds,
    );

    if (!decision.shouldSeed) {
      console.log(JSON.stringify({
        scope: "run-cycle-margin-from-cash",
        symbol,
        side,
        accountNumber,
        askReturnPct,
        lossDepth,
        positionAgeDays,
        timeFactor: +timeFactor.toFixed(3),
        ageFactor: +ageFactor.toFixed(3),
        booleanFactor: +booleanFactor.toFixed(3),
        thresholds,
        goodBooleanScore,
        ivRank: decision.ivRank,
        gated: true,
        gateReason: decision.reason,
      }));
      continue;
    }

    const cashFill = evaluation.metrics.weightedAverageFill;
    const result = await seedSymbol(evaluation.underlyingSymbol, side, accountNumber, {
      orderSource: MARGIN_SEED_FROM_CASH_ORDER_SOURCE,
      maxLimitPrice: cashFill > 0 ? cashFill : undefined,
    });

    if (result.placedOrder) {
      await recordPositionOpened(accountNumber, symbol, side);
    }

    const seedOrder = mapMarginSeedOrderForRunHistory(
      cashAccountNumber,
      askReturnPct,
      result,
      goodBooleanScore,
      booleanSurplusPct,
      decision.ivRank,
      decision.reason,
    );

    console.log(JSON.stringify({
      scope: "run-cycle-margin-from-cash",
      symbol,
      side,
      accountNumber,
      askReturnPct,
      lossDepth,
      positionAgeDays,
      timeFactor: +timeFactor.toFixed(3),
      ageFactor: +ageFactor.toFixed(3),
      thresholds,
      goodBooleanScore,
      booleanSurplusPct,
      ivRank: decision.ivRank,
      decisionReason: decision.reason,
      placedOrder: result.placedOrder,
      skippedReason: result.skippedReason ?? null,
      candidateSymbol: result.candidateSymbol ?? null,
      limitPrice: result.limitPrice ?? null,
      estimatedOrderCost: result.estimatedOrderCost ?? null,
    }));

    results.push(seedOrder);
  }

  return results;
}
