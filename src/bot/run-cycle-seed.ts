import { getAccountMarginOrCash, getCashAccountNumber, isReadOnlyAccount } from "~/core/default-account";
import { getGroupSideForPositions, type PositionGroupEvaluation } from "./evaluate-position";
import { getPositionEvaluations } from "./get-position-evaluations";
import { RunSeedOrder } from "./run-history";
import seedSymbol, { SeedSymbolResult } from "./seed-symbol";
import { MARGIN_SEED_FROM_CASH_ORDER_SOURCE } from "./order-sources";
import { isWithinCashAccountSeedFromMarginWindow } from "./seeding-windows";
import type { SecretSourcePosition } from "./secret/types";
import { countGoodBooleans, getBooleanSurplusPct } from "./cash-position-gate";

export type MarginSeedResult = RunSeedOrder;

function getMarginSeedFromCashMinDownPct(): number | null {
  const raw = process.env.BOT_MARGIN_SEED_FROM_CASH_MIN_DOWN_PCT?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function getAskReturnPct(evaluation: PositionGroupEvaluation): number | null {
  const fill = evaluation.metrics.weightedAverageFill;
  if (!(fill > 0)) return null;
  return ((evaluation.metrics.currentAskPrice - fill) / fill) * 100;
}

function mapMarginSeedOrderForRunHistory(
  sourceAccountNumber: string,
  askReturnPctSource: number,
  result: SeedSymbolResult,
  goodBooleanScore: number | null,
  booleanSurplusPct: number | null,
): MarginSeedResult {
  return {
    accountNumber: result.accountNumber,
    askReturnPctSource,
    booleanSurplusPct,
    candidateSymbol: result.candidateSymbol ?? null,
    estimatedOrderCost: result.estimatedOrderCost ?? null,
    goodBooleanScore,
    limitPrice: result.limitPrice ?? null,
    placedOrder: result.placedOrder,
    scope: "run-cycle-margin-from-cash",
    side: result.side,
    skippedReason: result.skippedReason ?? null,
    sourceAccountNumber,
    symbol: result.symbol,
    triggerReason: `cash position down ${Math.abs(askReturnPctSource).toFixed(1)}%`,
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

  const minDownPct = getMarginSeedFromCashMinDownPct();
  if (minDownPct === null) {
    return [];
  }

  const cashAccountNumber = await getCashAccountNumber();
  if (cashAccountNumber === accountNumber) {
    return [];
  }

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
    if (askReturnPct === null || askReturnPct >= -minDownPct) continue;

    const secretPosition = secretPositions.find(
      (p) => String(p.ticker ?? "").trim().toUpperCase() === symbol,
    );
    const goodBooleanScore = secretPosition != null ? countGoodBooleans(secretPosition) : null;
    const booleanSurplusPct = goodBooleanScore != null ? getBooleanSurplusPct(goodBooleanScore) : null;

    const result = await seedSymbol(evaluation.underlyingSymbol, side, accountNumber, {
      orderSource: MARGIN_SEED_FROM_CASH_ORDER_SOURCE,
    });

    const seedOrder = mapMarginSeedOrderForRunHistory(
      cashAccountNumber,
      askReturnPct,
      result,
      goodBooleanScore,
      booleanSurplusPct,
    );

    console.log(JSON.stringify({
      scope: "run-cycle-margin-from-cash",
      symbol,
      side,
      accountNumber,
      askReturnPct,
      goodBooleanScore,
      booleanSurplusPct,
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
