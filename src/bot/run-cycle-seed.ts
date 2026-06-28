import { getAccountMarginOrCash, getMarginAccountNumber, isReadOnlyAccount } from "~/core/default-account";
import { getPositionEvaluations } from "./get-position-evaluations";
import { RunSeedOrder } from "./run-history";
import seedSymbol, { SeedSymbolResult } from "./seed-symbol";
import {
  getCashAccountSeedCandidatesFromMarginEvaluations,
  isWithinCashAccountSeedFromMarginWindow,
} from "./cash-account-seeding";
import { CASH_ACCOUNT_SEED_FROM_MARGIN_ORDER_SOURCE } from "./order-sources";

export type CashAccountSeedResult = RunSeedOrder;

function mapCashAccountSeedOrderForRunHistory(
  sourceAccountNumber: string,
  askReturnPctSource: number,
  result: SeedSymbolResult,
): CashAccountSeedResult {
  return {
    accountNumber: result.accountNumber,
    askReturnPctSource,
    candidateSymbol: result.candidateSymbol ?? null,
    estimatedOrderCost: result.estimatedOrderCost ?? null,
    limitPrice: result.limitPrice ?? null,
    placedOrder: result.placedOrder,
    side: result.side,
    skippedReason: result.skippedReason ?? null,
    sourceAccountNumber,
    symbol: result.symbol,
  };
}

export async function maybeSeedCashAccountFromMarginAccount(
  accountNumber: string,
  currentTime: Date,
  excludedUnderlyingSymbols: ReadonlySet<string> = new Set(),
): Promise<CashAccountSeedResult[]> {
  if (isReadOnlyAccount(accountNumber)) {
    return [];
  }

  const accountMarginOrCash = await getAccountMarginOrCash(accountNumber);
  if (accountMarginOrCash !== "cash") {
    return [];
  }

  if (!isWithinCashAccountSeedFromMarginWindow(currentTime)) {
    return [];
  }

  const marginAccountNumber = await getMarginAccountNumber();
  if (marginAccountNumber === accountNumber) {
    return [];
  }

  const marginEvaluations = await getPositionEvaluations(marginAccountNumber);
  const localExcludedUnderlyingSymbols = new Set(
    Array.from(excludedUnderlyingSymbols, (symbol) => String(symbol).toUpperCase()),
  );

  for (const evaluation of marginEvaluations) {
    if (evaluation.strategy.action === "CLOSE_POSITION") {
      localExcludedUnderlyingSymbols.add(
        String(evaluation.underlyingSymbol ?? "").toUpperCase(),
      );
    }
  }

  const seedCandidates = getCashAccountSeedCandidatesFromMarginEvaluations(
    marginEvaluations,
  ).filter(
    (candidate) =>
      !localExcludedUnderlyingSymbols.has(
        String(candidate.underlyingSymbol ?? "").toUpperCase(),
      ),
  );

  const seedResults: CashAccountSeedResult[] = [];
  for (const candidate of seedCandidates) {
    const result = await seedSymbol(
      candidate.underlyingSymbol,
      candidate.side,
      accountNumber,
      {
        orderSource: CASH_ACCOUNT_SEED_FROM_MARGIN_ORDER_SOURCE,
      },
    );
    seedResults.push(
      mapCashAccountSeedOrderForRunHistory(
        marginAccountNumber,
        candidate.askReturnPerc,
        result,
      ),
    );
  }

  return seedResults;
}
