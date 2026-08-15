/**
 * Allocation instrument guard — an EQUITY holding must not attract option buys.
 *
 * THE HOLE. `getCandidateSide` (`actions/manage-allocation.ts`) infers the option
 * side from the group's own symbols and defaults a sideless group to `"call"`.
 * That default is right for an option group whose symbols will not parse; it is
 * wrong for the other thing that lands in a sideless group. The owner hand-buys
 * SHARES in the margin account, an equity leg has no C/P suffix, so
 * `evaluate-position.ts` keys it `TICKER::none` (`getOptionSideForPosition(...)
 * ?? "none"`) — and the allocator then reads that share lot as a call position
 * to accumulate into, on the same underlying, with the bot's money.
 *
 * This is the ENTRY half of a hole whose EXIT half is closed by
 * [close-instrument-guard.ts](./close-instrument-guard.ts), which stops the margin
 * EOD sweep from liquidating those same shares. The two are deliberately symmetric
 * and share ONE predicate — `isOpenableInstrument` / `getNonOpenablePositions`,
 * imported from that module rather than restated here: the bot may only act on an
 * instrument it is capable of opening itself.
 *
 * The shared predicate carries the OCC-symbol-shape fallback for a missing broker
 * `instrument-type`, and that is a safety property BOTH guards depend on: a
 * well-formed 21-character contract symbol still reads as an option, so an absent
 * broker field can never silently reclassify a real option — on the close side that
 * would disarm a live stop, and here it would strand a position the bot opened
 * itself. A bare ticker cannot pass the shape test, so a share lot is caught either
 * way.
 *
 * WHY A SKIP AND NOT AN IMPLICIT DO-NOT-TOUCH. Do-not-touch groups are dropped
 * from the execution-path exposure sums (`run-cycle-context.ts` filters them out
 * of `actionableCompletedEvaluations` before `buildInitialBudget`), so marking
 * equity hands-off would make the bot size its option buys as though that capital
 * were free. Skipping at the allocation step leaves the equity in the exposure
 * denominator, which is correct: the capital is committed.
 *
 * WHY NOT JUST FIX `getCandidateSide`. Returning `null` there would answer
 * "which side" with "none", and every caller would still have to decide what to
 * do about it. The honest statement is not "this group has no side", it is "this
 * group is not something we can buy" — so it is a skip with a reason, in the same
 * shape as every other allocation skip, and it appears in run history.
 */

import { readEnvBool } from "~/core/env-utils";
import type { PositionGroupEvaluation } from "./evaluate-position";
import {
  getNonOpenablePositions,
  getPositionInstrumentType,
} from "./close-instrument-guard";

/** Greppable token on every suppressed allocation. */
export const ALLOCATION_INSTRUMENT_SUPPRESSED_TOKEN = "ALLOCATION_INSTRUMENT_SUPPRESSED";

/**
 * Kill switch, **default ON**. This one CHANGES SIZING BEHAVIOUR — a group that
 * used to be an accumulation target stops being one — so it gets a switch that
 * restores the previous behaviour exactly.
 *
 * `readEnvBool`, never `toBooleanFlag(process.env.X ?? true)`: dotenv turns a
 * present-but-blank `BOT_BUY_ONLY_OPENABLE_INSTRUMENTS=` line into `""`, which is
 * not nullish, so `??` never reaches the fallback and a default-true flag would
 * ship silently OFF. See AGENTS.md non-negotiable 5.
 */
export function isAllocationInstrumentGuardEnabled(): boolean {
  return readEnvBool("BOT_BUY_ONLY_OPENABLE_INSTRUMENTS", true);
}

/**
 * Should this group be skipped for allocation? False when the guard is disarmed,
 * so a kill-switched bot behaves exactly as it did before.
 */
export function isAllocationBlockedByInstrumentGuard(
  evaluation: Pick<PositionGroupEvaluation, "positions">,
): boolean {
  if (!isAllocationInstrumentGuardEnabled()) return false;
  return getNonOpenablePositions(evaluation).length > 0;
}

/** The instrument types that caused the block, deduped and in encounter order. */
function getBlockingInstrumentTypes(
  evaluation: Pick<PositionGroupEvaluation, "positions">,
): string[] {
  return [
    ...new Set(getNonOpenablePositions(evaluation).map(getPositionInstrumentType)),
  ];
}

/**
 * The skip reason carried into `AllocationExecutionResult.skippedReason`, so a
 * suppressed buy is visible in run history rather than silently absent.
 */
export function buildSuppressedAllocationReason(
  evaluation: Pick<PositionGroupEvaluation, "positions">,
): string {
  const types = getBlockingInstrumentTypes(evaluation);
  return `instrument guard: bot can only accumulate instruments it can open (Equity Option); group holds ${types.length > 0 ? types.join("/") : "Unknown"}`;
}

/**
 * One greppable JSON line per suppressed allocation. The owner needs to see what
 * the bot WOULD have bought against his shares, so this carries the ticker, the
 * group key, the instrument types, the side the old default would have picked,
 * and the exposure target that was in play.
 */
export function logSuppressedAllocation(context: {
  accountNumber: string;
  evaluation: Pick<
    PositionGroupEvaluation,
    "positions" | "groupKey" | "underlyingSymbol"
  >;
  /** The side `getCandidateSide` would have returned — `"call"` for an equity group. */
  wouldHaveBoughtSide: string;
  targetDTE?: number;
}): void {
  const { accountNumber, evaluation } = context;
  const blocked = getNonOpenablePositions(evaluation);

  console.log(
    JSON.stringify({
      scope: "allocation-instrument-guard",
      token: ALLOCATION_INSTRUMENT_SUPPRESSED_TOKEN,
      accountNumber,
      underlyingSymbol: evaluation.underlyingSymbol,
      groupKey: evaluation.groupKey,
      instrumentTypes: getBlockingInstrumentTypes(evaluation),
      wouldHaveBoughtSide: context.wouldHaveBoughtSide,
      targetDTE: context.targetDTE ?? null,
      heldQuantity: blocked.reduce(
        (sum, position) => sum + Math.abs(Number(position.quantity) || 0),
        0,
      ),
      symbols: blocked.map((position) => String(position.symbol ?? "")),
      message:
        "suppressed an allocation buy - the bot cannot open this instrument, so it must not accumulate against it",
    }),
  );
}
