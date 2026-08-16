import { getAccountMarginOrCash, getMarginAccountNumber } from "~/core/default-account";
import { closePosition, ClosePositionResult } from "./actions/close-position";
import { PositionGroupEvaluation } from "./evaluate-position";
import { getPositionEvaluations } from "./get-position-evaluations";
import { getDoNotTouchGroupKeys, isEvaluationDoNotTouch } from "./do-not-touch-groups";
import {
  isCloseBlockedByInstrumentGuard,
  suppressCloseForInstrumentGuard,
} from "./close-instrument-guard";

interface CloseSymbolPositionResult {
  accountNumber: string;
  underlyingSymbol: string;
  side?: "call" | "put";
  matchedGroupKeys: string[];
  /** Groups that matched the request but were withheld (do-not-touch / instrument guard). */
  suppressedGroupKeys?: string[];
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

/** A withheld group, reported per-position so the caller sees exactly what was spared. */
function buildDoNotTouchResults(
  accountNumber: string,
  evaluation: PositionGroupEvaluation,
): ClosePositionResult[] {
  return evaluation.positionSnapshots.map((snapshot) => ({
    accountNumber,
    action: "CLOSE_POSITION" as const,
    placedOrder: false,
    skippedReason: `protected do-not-touch group ${evaluation.groupKey}`,
    symbol: snapshot.position.symbol,
    underlyingSymbol: evaluation.underlyingSymbol,
  }));
}

export interface OperatorCloseTargets {
  closeable: PositionGroupEvaluation[];
  suppressedGroupKeys: string[];
  suppressedResults: ClosePositionResult[];
}

/**
 * Split the operator's matched groups into the ones we may actually send a
 * closing order for and the ones we withhold.
 *
 * TWO PROTECTIONS APPLY, both of which this path used to bypass entirely:
 *
 *  1. `BOT_DO_NOT_TOUCH_GROUPS`. Every other execution path honours it; this one
 *     did not, so the operator IPC close was a hole straight through the account's
 *     primary safety rail. It matters most with `side` omitted, because then the
 *     request matches EVERY group on the underlying including the `::none` leg.
 *  2. The close-instrument guard — the bot may only close what it can open.
 *
 * Neither is a "the operator can't have meant that" veto in disguise: a genuine
 * operator override is `BOT_DO_NOT_TOUCH_GROUPS` minus the entry, or the kill
 * switch. Both are deliberate acts; a typo'd ticker is not.
 *
 * Split out from `closeSymbolPosition` so the decision is reachable without a
 * broker: everything around it is live API calls, which is precisely why this
 * path went unprotected for so long.
 */
export function partitionOperatorCloseTargets(
  accountNumber: string,
  matches: readonly PositionGroupEvaluation[],
  requestLabel: string,
): OperatorCloseTargets {
  const doNotTouchGroupKeys = getDoNotTouchGroupKeys();
  const targets: OperatorCloseTargets = {
    closeable: [],
    suppressedGroupKeys: [],
    suppressedResults: [],
  };

  for (const evaluation of matches) {
    if (isEvaluationDoNotTouch(evaluation, doNotTouchGroupKeys)) {
      targets.suppressedGroupKeys.push(evaluation.groupKey);
      targets.suppressedResults.push(...buildDoNotTouchResults(accountNumber, evaluation));
    } else if (isCloseBlockedByInstrumentGuard(evaluation)) {
      targets.suppressedGroupKeys.push(evaluation.groupKey);
      targets.suppressedResults.push(
        ...suppressCloseForInstrumentGuard({
          accountNumber,
          dispatchSite: "operator-close",
          evaluation,
          requestedBy: requestLabel,
        }),
      );
    } else {
      targets.closeable.push(evaluation);
    }
  }

  return targets;
}

/** What the suppression log records as the requester. */
export function buildOperatorRequestLabel(
  normalizedSymbol: string,
  side?: "call" | "put",
): string {
  return `operator closeSymbolPosition(${normalizedSymbol}${side ? `, ${side}` : ""})`;
}

/**
 * Assemble the operator's reply. Pure, so the "everything matched was
 * protected" branch is reachable without a broker.
 */
export function buildCloseSymbolPositionResult(
  accountNumber: string,
  normalizedSymbol: string,
  side: "call" | "put" | undefined,
  targets: OperatorCloseTargets,
  results: readonly ClosePositionResult[],
): CloseSymbolPositionResult {
  const { closeable, suppressedGroupKeys, suppressedResults } = targets;
  return {
    accountNumber,
    underlyingSymbol: normalizedSymbol,
    side,
    matchedGroupKeys: closeable.map((evaluation) => evaluation.groupKey),
    ...(suppressedGroupKeys.length > 0 ? { suppressedGroupKeys } : {}),
    results: [...results, ...suppressedResults],
    ...(closeable.length === 0
      ? {
          skippedReason: `Every matching group for ${normalizedSymbol} in ${accountNumber} is protected (${suppressedGroupKeys.join(", ")})`,
        }
      : {}),
  };
}

/**
 * Operator-initiated surgical close for a single underlying (optionally one
 * side). Unlike a full runCycle this touches nothing else, and unlike the
 * cycle's close path it crosses the morning spread gate — the whole point of a
 * manual bailout is to exit an illiquid position regardless of spread. Chases
 * urgently (crosses toward the bid) like a hard-risk close.
 *
 * Protections are decided by `partitionOperatorCloseTargets`; see there.
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

  const targets = partitionOperatorCloseTargets(
    resolvedAccountNumber,
    matches,
    buildOperatorRequestLabel(normalizedSymbol, side),
  );

  const results = (
    await Promise.all(
      targets.closeable.map((evaluation) =>
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

  return buildCloseSymbolPositionResult(
    resolvedAccountNumber,
    normalizedSymbol,
    side,
    targets,
    results,
  );
}

export default closeSymbolPosition;
