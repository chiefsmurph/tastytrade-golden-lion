import { getAccountMarginOrCash, getCashAccountNumber, getMarginAccountNumber, isReadOnlyAccount } from "~/core/default-account";
import { getAccountBalanceNumber } from "~/core/account-balance";
import tastytradeApi from "~/core/tastytrade-client";
import { getGroupMarketValue } from "./actions/order-utils";
import { getGroupSideForPositions, type PositionGroupEvaluation } from "./evaluate-position";
import { getPositionEvaluations } from "./get-position-evaluations";
import { RunSeedOrder } from "./run-history";
import seedSymbol, { SeedSymbolResult } from "./seed-symbol";
import { MARGIN_SEED_FROM_CASH_ORDER_SOURCE, CASH_SEED_FROM_MARGIN_ORDER_SOURCE } from "./order-sources";
import { isWithinCashAccountSeedFromMarginWindow } from "~/strategy/seeding-windows";
import type { SecretSourcePosition } from "./secret/types";
import { countGoodBooleans, getBooleanSurplusPct } from "~/strategy/position-gate";
import { recordPositionOpened, getRegistryEntry } from "./position-registry";
import {
  getMarginSeedConfig,
  getCashSeedFromMarginConfig,
  getTimeOfDaySeedMultiplier,
  getPositionAgeSeedMultiplier,
  getPositionAgeMinutesSeedMultiplier,
  getBooleanSeedMultiplier,
  getScaledThresholds,
  getSeedDecision,
} from "~/strategy/seed-decision";

export type MarginSeedResult = RunSeedOrder;

function getAskReturnPct(evaluation: PositionGroupEvaluation): number | null {
  const fill = evaluation.metrics.weightedAverageFill;
  if (!(fill > 0)) return null;
  return ((evaluation.metrics.currentAskPrice - fill) / fill) * 100;
}

async function getPositionAgeDays(
  accountNumber: string,
  symbol: string,
  currentTime: Date,
  evaluation: PositionGroupEvaluation,
): Promise<number | null> {
  const entry = await getRegistryEntry(accountNumber, symbol);
  if (entry?.openedAt) {
    return (currentTime.getTime() - new Date(entry.openedAt).getTime()) / 86_400_000;
  }

  const createdAt = evaluation.positions[0]?.["created-at"];
  if (createdAt) {
    return (currentTime.getTime() - new Date(createdAt).getTime()) / 86_400_000;
  }

  return null;
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

export async function maybeSeedCashAccountFromMarginAccount(
  accountNumber: string,
  currentTime: Date,
  excludedUnderlyingSymbols: ReadonlySet<string> = new Set(),
  secretPositions: readonly SecretSourcePosition[] = [],
): Promise<MarginSeedResult[]> {
  if (isReadOnlyAccount(accountNumber)) return [];

  const accountMarginOrCash = await getAccountMarginOrCash(accountNumber);
  if (accountMarginOrCash !== "cash") return [];

  if (!isWithinCashAccountSeedFromMarginWindow(currentTime)) return [];

  const config = getCashSeedFromMarginConfig();
  if (config === null) return [];

  const marginAccountNumber = await getMarginAccountNumber();
  if (marginAccountNumber === accountNumber) return [];

  const timeFactor = getTimeOfDaySeedMultiplier(currentTime);

  const [marginEvaluations, marginBalance] = await Promise.all([
    getPositionEvaluations(marginAccountNumber),
    tastytradeApi.balancesAndPositionsService.getAccountBalanceValues(marginAccountNumber),
  ]);
  const marginNetLiq = getAccountBalanceNumber(marginBalance, "net-liquidating-value");

  const localExcluded = new Set(
    Array.from(excludedUnderlyingSymbols, (s) => String(s).toUpperCase()),
  );

  const results: MarginSeedResult[] = [];

  for (const evaluation of marginEvaluations) {
    if (evaluation.strategy.action !== "MANAGE_ALLOCATION") continue;

    const side = getGroupSideForPositions(evaluation.positions);
    if (side !== "call" && side !== "put") continue;

    const symbol = String(evaluation.underlyingSymbol ?? "").toUpperCase();
    if (!symbol || localExcluded.has(symbol)) continue;

    const askReturnPct = getAskReturnPct(evaluation);
    if (askReturnPct === null) continue;

    const secretPosition = secretPositions.find(
      (p) => String(p.ticker ?? "").trim().toUpperCase() === symbol,
    );
    const goodBooleanScore = secretPosition != null ? countGoodBooleans(secretPosition) : null;
    const booleanSurplusPct = goodBooleanScore != null ? getBooleanSurplusPct(goodBooleanScore) : null;

    const positionAgeDays = await getPositionAgeDays(marginAccountNumber, symbol, currentTime, evaluation);
    const positionAgeMinutes = positionAgeDays !== null ? positionAgeDays * 24 * 60 : null;
    const ageFactor = getPositionAgeMinutesSeedMultiplier(positionAgeMinutes);

    const positionMarketValue = getGroupMarketValue(evaluation.positionSnapshots);
    const pctOfNetLiq = marginNetLiq > 0 ? positionMarketValue / marginNetLiq : 0;

    const booleanFactor = getBooleanSeedMultiplier(goodBooleanScore);
    const thresholds = getScaledThresholds(config, timeFactor, ageFactor, booleanFactor);

    const lossDepth = -askReturnPct;
    if (lossDepth < thresholds.minDownPct || lossDepth > thresholds.maxDownPct) continue;

    const decision = await getSeedDecision(symbol, lossDepth, goodBooleanScore, secretPosition, thresholds);

    if (!decision.shouldSeed) {
      console.log(JSON.stringify({
        scope: "run-cycle-cash-from-margin",
        symbol,
        side,
        accountNumber,
        askReturnPct,
        lossDepth,
        positionAgeMinutes: positionAgeMinutes !== null ? +positionAgeMinutes.toFixed(1) : null,
        pctOfNetLiq: +pctOfNetLiq.toFixed(4),
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

    const result = await seedSymbol(evaluation.underlyingSymbol, side, accountNumber, {
      orderSource: CASH_SEED_FROM_MARGIN_ORDER_SOURCE,
    });

    if (result.placedOrder) {
      await recordPositionOpened(accountNumber, symbol, side);
    }

    const seedOrder: MarginSeedResult = {
      accountNumber: result.accountNumber,
      askReturnPctSource: askReturnPct,
      booleanSurplusPct,
      candidateSymbol: result.candidateSymbol ?? null,
      estimatedOrderCost: result.estimatedOrderCost ?? null,
      goodBooleanScore,
      ivRank: decision.ivRank,
      limitPrice: result.limitPrice ?? null,
      placedOrder: result.placedOrder,
      scope: "run-cycle-cash-from-margin",
      side: result.side,
      skippedReason: result.skippedReason ?? null,
      sourceAccountNumber: marginAccountNumber,
      symbol: result.symbol,
      triggerReason: `margin down ${Math.abs(askReturnPct).toFixed(1)}% ask (${positionAgeMinutes !== null ? positionAgeMinutes.toFixed(0) + "min old" : "age unknown"}) — ${decision.reason}`,
    };

    console.log(JSON.stringify({
      scope: "run-cycle-cash-from-margin",
      symbol,
      side,
      accountNumber,
      askReturnPct,
      lossDepth,
      positionAgeMinutes: positionAgeMinutes !== null ? +positionAgeMinutes.toFixed(1) : null,
      pctOfNetLiq: +pctOfNetLiq.toFixed(4),
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
