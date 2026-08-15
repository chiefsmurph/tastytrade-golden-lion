/**
 * What instrument is this position, and could the bot have opened it?
 *
 * ONE HOME, DELIBERATELY. Two guards need this answer and they sit on opposite
 * sides of the trade: the ENTRY guard (`allocation-instrument-guard.ts`, which
 * stops an equity holding from attracting option buys) and the EXIT guard (the
 * close-side instrument guard). Both are asking the same question, so the
 * predicate lives in this leaf module rather than inside either one.
 *
 * WHY IT MATTERS. Every BUY path in this repo hard-codes the instrument type it
 * opens — `manage-allocation.ts`, `spray-buy.ts` and `seed-symbol.ts` all write
 * `"Equity Option"` — so the bot can only ever open an option. But equity enters
 * the engine as a first-class position group: a share lot has no C/P suffix, so
 * `evaluate-position.ts` keys it `TICKER::none` and every downstream branch then
 * treats it exactly like an option group. The owner hand-buys shares in the
 * margin account, and those lots land in that same shape.
 *
 * THE INVARIANT both guards are built on: **the bot may only act on an
 * instrument it is capable of opening itself.**
 *
 * FUTURE — SMS-DIRECTED EQUITY. If the bot is ever given a path to buy shares on
 * the owner's instruction, this predicate stops being the right shape: the
 * question becomes WHOSE position it is rather than WHAT it is. Make it
 * provenance-aware at that point rather than widening the openable set — an
 * owner-directed share lot is still his position to manage.
 */

import type { CurrentPosition } from "~/core/types";
import { isOccOptionSymbol, normalizeInstrumentType } from "./actions/order-utils";

/**
 * Instrument types this bot can OPEN. If a new opening path ever adds a type,
 * add it here in the same commit or the guards will strand the result.
 */
const OPENABLE_INSTRUMENT_TYPES = new Set(["Equity Option"]);

/**
 * The instrument type we will report for a position. Prefers the broker field;
 * falls back to the SYMBOL SHAPE when it is absent.
 *
 * The fallback direction is a safety choice, not a convenience: a well-formed
 * 21-character OCC contract symbol ("AAPL  260619C00100000") is a POSITIVE match
 * for an option, so a missing broker field can never silently reclassify a real
 * option and disarm the behaviour that depends on it. A bare ticker ("TDUP")
 * cannot pass that shape test, so a share lot is still caught either way.
 */
export function getPositionInstrumentType(position: CurrentPosition): string {
  const raw = String(position?.["instrument-type"] ?? "").trim();
  if (raw) return normalizeInstrumentType(raw);
  return isOccOptionSymbol(String(position?.symbol ?? "")) ? "Equity Option" : "Unknown";
}

/** True when the bot could have opened this position itself. */
export function isOpenableInstrument(position: CurrentPosition): boolean {
  return OPENABLE_INSTRUMENT_TYPES.has(getPositionInstrumentType(position));
}

/**
 * The positions in a group the bot could not have opened. Empty ⇒ the group is
 * one the bot owns end to end.
 *
 * Evaluated across EVERY position in the group, not just the first: a mixed pile
 * is not half-safe, so one non-openable leg makes the whole group hands-off.
 */
export function getNonOpenablePositions(
  positions: readonly CurrentPosition[] | undefined,
): CurrentPosition[] {
  return (positions ?? []).filter((position) => !isOpenableInstrument(position));
}
