import { getAccountMarginOrCash, getMarginAccountNumber } from "~/core/default-account";
import { closePosition, ClosePositionResult } from "./actions/close-position";
import { PositionGroupEvaluation } from "./evaluate-position";
import { getPositionEvaluations } from "./get-position-evaluations";

interface CloseSymbolPositionResult {
  accountNumber: string;
  underlyingSymbol: string;
  side?: "call" | "put";
  matchedGroupKeys: string[];
  results: ClosePositionResult[];
  skippedReason?: string;
}

function groupMatchesTarget(
  evaluation: PositionGroupEvaluation,
  normalizedSymbol: string,
  side?: "call" | "put",
): boolean {
  if (evaluation.underlyingSymbol.toUpperCase() !== normalizedSymbol) {
    return false;
  }
  if (!side) return true;
  return evaluation.groupKey.endsWith(`::${side}`);
}

function buildNoMatchResult(
  accountNumber: string,
  normalizedSymbol: string,
  side?: "call" | "put",
): CloseSymbolPositionResult {
  const sideLabel = side ?? "call/put";
  return {
    accountNumber,
    underlyingSymbol: normalizedSymbol,
    side,
    matchedGroupKeys: [],
    results: [],
    skippedReason: `No open ${sideLabel} position found for ${normalizedSymbol} in ${accountNumber}`,
  };
}

/**
 * Operator-initiated surgical close for a single underlying (optionally one
 * side). Unlike a full runCycle this touches nothing else, and unlike the
 * cycle's close path it crosses the morning spread gate — the whole point of a
 * manual bailout is to exit an illiquid position regardless of spread. Chases
 * urgently (crosses toward the bid) like a hard-risk close.
 */
async function closeSymbolPosition(
  symbol: string,
  side?: "call" | "put",
  accountNumber?: string,
): Promise<CloseSymbolPositionResult> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!normalizedSymbol) {
    throw new Error("symbol is required");
  }

  const resolvedAccountNumber =
    accountNumber?.trim() || (await getMarginAccountNumber());
  const accountType = await getAccountMarginOrCash(resolvedAccountNumber);

  const evaluations = await getPositionEvaluations(resolvedAccountNumber);
  const matches = evaluations.filter((evaluation) =>
    groupMatchesTarget(evaluation, normalizedSymbol, side),
  );

  if (matches.length === 0) {
    return buildNoMatchResult(resolvedAccountNumber, normalizedSymbol, side);
  }

  const results = (
    await Promise.all(
      matches.map((evaluation) =>
        closePosition(resolvedAccountNumber, evaluation, {
          isUrgentClose: true,
          forceThroughSpreadGate: true,
          // "unknown" is a valid StrategyAccountType; closePosition coalesces it
          // internally, so no need to map it to undefined here.
          accountType,
        }),
      ),
    )
  ).flat();

  return {
    accountNumber: resolvedAccountNumber,
    underlyingSymbol: normalizedSymbol,
    side,
    matchedGroupKeys: matches.map((evaluation) => evaluation.groupKey),
    results,
  };
}

export default closeSymbolPosition;
