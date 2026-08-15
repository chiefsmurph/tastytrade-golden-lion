/**
 * Close-instrument guard — the bot may only CLOSE what it is capable of OPENING.
 *
 * WHY THIS EXISTS. The margin EOD sweep liquidated the owner's hand-bought
 * SHARES four separate times (all `hard-risk-close`, all with the reason
 * "Market closed or closing - liquidate all positions immediately"), and all
 * four filled. Equity is not an accident of the data model — it enters the
 * engine as a first-class position group: `evaluate-position.ts` keys a share
 * lot as `TICKER::none` (`getOptionSideForPosition(...) ?? "none"`) and every
 * strategy branch then treats it exactly like an option group.
 *
 * THE ASYMMETRY THAT MADE IT LIVE. All three BUY paths hard-code the instrument
 * type they open (`manage-allocation.ts`, `spray-buy.ts`, `seed-symbol.ts` all
 * write `"Equity Option"`), but `buildClosingOrderPayload` (`order-utils.ts`)
 * reads the instrument type off the POSITION. So the bot can only ever open an
 * option, yet it will faithfully sell whatever it finds held. The strategy layer
 * cannot fix this even in principle: `evaluateTradingStrategy` receives
 * `PositionMetrics` — bid, ask, weighted average fill, two timestamps — and the
 * instrument type is never passed in.
 *
 * THE INVARIANT. Close only what we can open. That is provably safe today
 * (one openable type), and it is a cleaner rule than enumerating the strategy
 * branches that can reach a close — EOD liquidation, stop-loss, take-profit,
 * overnight reduction and the operator IPC close are five different callers of
 * the same dispatcher, and a rule attached to the dispatcher covers all of them
 * plus whatever is added next.
 *
 * WHY AT DISPATCH, NOT AS AN IMPLICIT DO-NOT-TOUCH. Both stop the liquidation,
 * but do-not-touch groups are dropped from the execution-path exposure sums
 * (`run-cycle-context.ts` `actionableCompletedEvaluations` -> `buildInitialBudget`,
 * and the same filter in `execute-position-evaluations.ts`). Marking equity
 * hands-off would therefore make the bot size its OPTION buys as though that
 * capital were free — trading a visible hazard for an invisible one. Guarding at
 * dispatch leaves equity in the exposure denominator, which is correct: the
 * capital really is committed.
 *
 * FUTURE — SMS-DIRECTED EQUITY. When the planned SMS path lets the owner tell
 * the bot to BUY shares, this predicate stops being the right shape: the bot
 * would then be capable of opening equity, and the question becomes WHOSE
 * position it is rather than WHAT it is. At that point make this
 * provenance-aware (see `position-provenance.ts`) instead of widening the
 * openable-instrument set — an owner-directed share lot is still his exit to
 * make, and a blanket "equity is now closeable" would re-open exactly the hole
 * this module closes. Until that path exists, the blanket block is correct.
 */

import { readEnvBool } from "~/core/env-utils";
import type { CurrentPosition } from "~/core/types";
import type { PositionGroupEvaluation } from "./evaluate-position";
import type { ClosePositionResult } from "./actions/close-position";
import { isOccOptionSymbol, normalizeInstrumentType } from "./actions/order-utils";

/**
 * Instrument types this bot can OPEN. Every buy path hard-codes exactly this
 * one value; if a new opening path ever adds a type, add it here in the same
 * commit or the guard will silently strand the resulting positions.
 */
const OPENABLE_INSTRUMENT_TYPES = new Set(["Equity Option"]);

/** Greppable token on every suppressed close. */
export const CLOSE_INSTRUMENT_SUPPRESSED_TOKEN = "CLOSE_INSTRUMENT_SUPPRESSED";

/** Which caller wanted the close — carried into the suppression log. */
export type CloseDispatchSite =
  | "cycle-close"
  | "overnight-reduction"
  | "operator-close";

/**
 * The instrument type we will report for a position. Prefers the broker field;
 * falls back to the SYMBOL SHAPE when the field is absent, so a missing field
 * can never silently disarm a real option's stop.
 */
export function getPositionInstrumentType(position: CurrentPosition): string {
  const raw = String(position?.["instrument-type"] ?? "").trim();
  if (raw) return normalizeInstrumentType(raw);
  // No instrument-type from the broker. A well-formed 21-char OCC contract
  // symbol is a POSITIVE match for an option ("AAPL  260619C00100000"); a bare
  // ticker ("TDUP") is not. Erring toward "option" here is the safe direction:
  // it preserves today's behaviour for options, and a share lot still fails
  // because its symbol cannot pass the OCC shape test.
  return isOccOptionSymbol(String(position?.symbol ?? "")) ? "Equity Option" : "Unknown";
}

/** True when the bot could have opened this position itself. */
export function isOpenableInstrument(position: CurrentPosition): boolean {
  return OPENABLE_INSTRUMENT_TYPES.has(getPositionInstrumentType(position));
}

/**
 * Kill switch. DEFAULT ON: the behaviour it blocks has already cost real money
 * four times and the owner has confirmed he does not want it.
 *
 * `readEnvBool`, never `toBooleanFlag(process.env.X ?? true)` — dotenv turns a
 * present-but-blank `BOT_CLOSE_ONLY_OPENABLE_INSTRUMENTS=` line into `""`,
 * which is not nullish, so `??` would never reach the fallback and the flag
 * would ship silently OFF. See AGENTS.md non-negotiable 5.
 */
export function isCloseInstrumentGuardEnabled(): boolean {
  return readEnvBool("BOT_CLOSE_ONLY_OPENABLE_INSTRUMENTS", true);
}

/**
 * The non-openable positions in a group. Empty ⇒ the group is safe to close.
 *
 * Evaluated across EVERY position in the group, not just the first: the bot
 * cannot sell "only the option part" of a mixed pile, so one non-openable leg
 * makes the whole group hands-off.
 */
function getNonOpenablePositions(
  evaluation: Pick<PositionGroupEvaluation, "positions">,
): CurrentPosition[] {
  return (evaluation.positions ?? []).filter((position) => !isOpenableInstrument(position));
}

/**
 * The predicate the dispatch sites call. False when the guard is disarmed, so a
 * kill-switched bot behaves exactly as it does today.
 */
export function isCloseBlockedByInstrumentGuard(
  evaluation: Pick<PositionGroupEvaluation, "positions">,
): boolean {
  if (!isCloseInstrumentGuardEnabled()) return false;
  return getNonOpenablePositions(evaluation).length > 0;
}

export interface SuppressedCloseContext {
  accountNumber: string;
  dispatchSite: CloseDispatchSite;
  evaluation: Pick<
    PositionGroupEvaluation,
    "positions" | "groupKey" | "underlyingSymbol" | "strategy"
  >;
  /** Free-form note on which branch wanted the close (EOD, stop, operator IPC…). */
  requestedBy?: string;
  /** Contracts/shares the caller intended to sell, when it is not the whole group. */
  requestedQuantity?: number;
}

/** Human-readable skip reason. Also used as the `ClosePositionResult.skippedReason`. */
function buildSuppressedCloseReason(instrumentTypes: readonly string[]): string {
  const types = instrumentTypes.length > 0 ? instrumentTypes.join("/") : "Unknown";
  return `instrument guard: bot can only close instruments it can open (Equity Option); held as ${types}`;
}

/**
 * Log every suppressed close with the full context. The owner needs to be able
 * to see exactly what the bot WOULD have sold, so this is a warn (not a debug)
 * and carries the ticker, group key, instrument type, dispatch site, the
 * strategy reason that asked for the close, and the quantity at risk.
 */
export function logSuppressedClose(context: SuppressedCloseContext): void {
  const { accountNumber, dispatchSite, evaluation } = context;
  const blocked = getNonOpenablePositions(evaluation);
  const instrumentTypes = [...new Set(blocked.map(getPositionInstrumentType))];
  const quantity = blocked.reduce(
    (sum, position) => sum + Math.abs(Number(position.quantity) || 0),
    0,
  );

  console.warn(
    JSON.stringify({
      scope: "close-instrument-guard",
      token: CLOSE_INSTRUMENT_SUPPRESSED_TOKEN,
      accountNumber,
      underlyingSymbol: evaluation.underlyingSymbol,
      groupKey: evaluation.groupKey,
      instrumentTypes,
      dispatchSite,
      requestedBy: context.requestedBy ?? evaluation.strategy.reason,
      strategyAction: evaluation.strategy.action,
      isUrgentClose: evaluation.strategy.isUrgentClose === true,
      quantity: context.requestedQuantity ?? quantity,
      symbols: blocked.map((position) => String(position.symbol ?? "")),
      message:
        "suppressed a closing order - the bot cannot open this instrument, so it must not sell it",
    }),
  );
}

/**
 * Split close candidates into the ones a closing order may be dispatched for and
 * the ones the guard withholds. This is the dispatcher's actual selection step —
 * exported so it can be exercised directly, since the dispatchers themselves are
 * broker-bound.
 */
export function partitionClosesByInstrumentGuard<
  T extends Pick<PositionGroupEvaluation, "positions">,
>(evaluations: readonly T[]): { dispatch: T[]; suppressed: T[] } {
  const dispatch: T[] = [];
  const suppressed: T[] = [];
  for (const evaluation of evaluations) {
    if (isCloseBlockedByInstrumentGuard(evaluation)) suppressed.push(evaluation);
    else dispatch.push(evaluation);
  }
  return { dispatch, suppressed };
}

/**
 * Log the suppression and produce the per-position "no order placed" records the
 * cycle's run history and the IPC callers expect. Mirrors the shape the
 * read-only path already emits, so a withheld close is visible downstream rather
 * than silently absent.
 */
export function suppressCloseForInstrumentGuard(
  context: SuppressedCloseContext,
): ClosePositionResult[] {
  logSuppressedClose(context);

  const { accountNumber, evaluation } = context;
  const skippedReason = buildSuppressedCloseReason([
    ...new Set(getNonOpenablePositions(evaluation).map(getPositionInstrumentType)),
  ]);

  return (evaluation.positions ?? []).map((position) => ({
    accountNumber,
    action: "CLOSE_POSITION" as const,
    placedOrder: false,
    skippedReason,
    symbol: String(position.symbol ?? ""),
    underlyingSymbol: evaluation.underlyingSymbol,
  }));
}
