/**
 * Exit-decision observability — one greppable JSON line per intraday-stop and
 * take-profit verdict.
 *
 * WHY THIS EXISTS. The exit rebuild that shipped 2026-08-09 (§6b midpoint
 * confirmation, §6c midpoint take-profit, §6d persistence across cycles) landed
 * in two files that between them emitted NOTHING —
 * `evaluate-trading-strategy.ts` and `stop-persistence-store.ts` contained zero
 * log statements. The gates were therefore unverifiable in production: when nine
 * stops fired 08-12/13 at −34% to −39% instead of snapping at the −30% floor,
 * that reading is consistent with a persistence gate working exactly as designed
 * AND with the price simply gapping through the floor, and nothing in the logs
 * could tell the two apart.
 *
 * WHAT IT HAS TO ANSWER, from logs alone:
 *   1. did the bid cross the intraday floor on this cycle?
 *   2. did the MIDPOINT confirm it, or was the stop withheld because mid
 *      disagreed — and at what two prices, against which two floors?
 *   3. what is the persistence streak right now, and what does it need to be?
 *   4. did the stop FIRE or was it WITHHELD, and by WHICH gate?
 *   5. for a take-profit: which basis fired it (bid or mid) and at what target?
 *
 * SILENCE MUST NOT BE AMBIGUOUS. A withheld exit is logged just as loudly as a
 * fired one, so "no line" means one thing only: the bid never crossed the floor
 * while the stop window was open. That is why the cooldown short-circuit
 * (gate 3, which returns before the stop is even consulted) also emits a line
 * when the bid is under the floor — otherwise a cooldown and a quiet position
 * look identical from the outside.
 *
 * OBSERVABILITY ONLY. Nothing here is read by any decision. Every value logged
 * is computed by the engine for its own purposes and handed over afterwards; the
 * builders are pure, and the only side effect in the module is `console.log`.
 *
 * WHY `console.log` AND NOT `console.warn`. PM2 splits stdout and stderr into
 * two files, so mixing the two would scatter one token across both and break
 * `grep`-then-read-in-order, which is the whole point of a single token.
 */

/**
 * The one greppable token. Every line this module emits carries it, for both
 * gates and for every verdict:
 *
 *   pm2 logs silver-lynx-tastytrade --lines 5000 --nostream | grep EXIT_GATE_DECISION
 */
export const EXIT_GATE_DECISION_TOKEN = "EXIT_GATE_DECISION";

const EXIT_GATE_SCOPE = "exit-gate";

/** Which circuit breaker produced this line. */
type ExitGateName = "intraday-stop" | "take-profit";

/** Did an order actually go out, or did a gate hold it back? */
export type ExitGateDecision = "FIRED" | "WITHHELD";

/**
 * The SPECIFIC gate that held the exit back. Never a generic "blocked" — the
 * operator question is always "which one", and each of these maps to exactly one
 * documented rule:
 *   - `mid-confirm`          §6b, the midpoint did not agree the position is broken
 *   - `persistence`          §6d, the trigger has only been seen on this one cycle
 *   - `cooldown`             gate 3, the stop was never consulted this cycle
 *   - `bid-below-breakeven`  §6c, a mid-triggered take-profit that could book a loss
 */
export type ExitGateWithheldBy =
  | "mid-confirm"
  | "persistence"
  | "cooldown"
  | "bid-below-breakeven";

/** Which price basis satisfied a take-profit. */
export type TakeProfitBasis = "bid" | "mid";

/** The quote the verdict was read off. */
export interface ExitGateQuote {
  currentBidPrice: number;
  currentAskPrice: number;
  weightedAverageFill: number;
  /** Optional group identity (`UNDERLYING::side`); logs only, never a decision input. */
  groupKey?: string;
}

export interface IntradayStopLogInput {
  accountType: string;
  quote: ExitGateQuote;
  /** Bid return vs cost basis, as a fraction (−0.34 = −34%). */
  bidReturn: number;
  /** Midpoint return, or null when the quote has no honest midpoint (§6b). */
  midReturn: number | null;
  /** The bid floor the trigger cleared, as a positive fraction (0.30 = −30%). */
  intradayFloor: number;
  /** The shallower midpoint floor, as a positive fraction (0.20 = −20%). */
  midFloor: number;
  midConfirmEnabled: boolean;
  /** Consecutive cycles INCLUDING this one — already inclusive, never `+ 1`. */
  observedCycles: number;
  requiredCycles: number;
  /** False when the caller supplied no cycle history, so §6d is inert here. */
  persistenceActive: boolean;
  bypassed: boolean;
  decision: ExitGateDecision;
  withheldBy?: ExitGateWithheldBy;
  /**
   * What the engine will report to the persistence store for this evaluation.
   * `false` means the streak is about to RESET — the single most misread part of
   * the gate, so it is stated rather than inferred.
   */
  stopTriggerHeld: boolean;
  /** The engine's own reason string, so a log line joins to the run history. */
  reason: string;
}

export interface TakeProfitLogInput {
  accountType: string;
  quote: ExitGateQuote;
  bidReturn: number;
  midReturn: number | null;
  /** The dynamic target as a fraction (0.07 = 7%). */
  target: number;
  /** Extra headroom the MID path demands above the target, as a fraction. */
  midMargin: number;
  midPathEnabled: boolean;
  decision: ExitGateDecision;
  basis?: TakeProfitBasis;
  withheldBy?: ExitGateWithheldBy;
  /** Present only when scale-out turned this into a partial close (§6a). */
  closeFraction?: number;
  reason: string;
}

/** Percent, rounded to 2dp, null-safe — logs read in the same units as the docs. */
function toPct(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 100;
}

function toPrice(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

/**
 * The midpoint as a PRICE. Reported alongside the bid and the ask so the reader
 * can check the arithmetic rather than trust the engine's own return figure —
 * the whole rebuild exists because a return computed off one side of a broken
 * quote was believed for weeks.
 */
function getMidPrice(quote: ExitGateQuote): number | null {
  const { currentBidPrice, currentAskPrice } = quote;
  if (!Number.isFinite(currentBidPrice) || !Number.isFinite(currentAskPrice)) {
    return null;
  }
  return (currentBidPrice + currentAskPrice) / 2;
}

function buildQuoteFields(quote: ExitGateQuote) {
  return {
    groupKey: quote.groupKey ?? null,
    bid: toPrice(quote.currentBidPrice),
    ask: toPrice(quote.currentAskPrice),
    mid: toPrice(getMidPrice(quote)),
    weightedAverageFill: toPrice(quote.weightedAverageFill),
  };
}

/** The intraday-stop line. Split from the emitter to keep the shape pure. */
function buildIntradayStopLogPayload(input: IntradayStopLogInput) {
  return {
    scope: EXIT_GATE_SCOPE,
    token: EXIT_GATE_DECISION_TOKEN,
    gate: "intraday-stop" satisfies ExitGateName,
    decision: input.decision,
    withheldBy: input.withheldBy ?? null,
    accountType: input.accountType,
    ...buildQuoteFields(input.quote),
    // The branch is only reachable once the bid has cleared the floor, so this is
    // always true; it is stated anyway so a reader never has to know that.
    bidCrossedFloor: true,
    bidReturnPct: toPct(input.bidReturn),
    midReturnPct: toPct(input.midReturn),
    bidFloorPct: toPct(-input.intradayFloor),
    midFloorPct: toPct(-input.midFloor),
    midConfirmed: input.midReturn == null ? null : input.midReturn <= -input.midFloor,
    midConfirmEnabled: input.midConfirmEnabled,
    observedCycles: input.observedCycles,
    requiredCycles: input.requiredCycles,
    persistenceActive: input.persistenceActive,
    collapseBypassed: input.bypassed,
    stopTriggerHeld: input.stopTriggerHeld,
    reason: input.reason,
  };
}

function buildTakeProfitLogPayload(input: TakeProfitLogInput) {
  return {
    scope: EXIT_GATE_SCOPE,
    token: EXIT_GATE_DECISION_TOKEN,
    gate: "take-profit" satisfies ExitGateName,
    decision: input.decision,
    basis: input.basis ?? null,
    withheldBy: input.withheldBy ?? null,
    accountType: input.accountType,
    ...buildQuoteFields(input.quote),
    bidReturnPct: toPct(input.bidReturn),
    midReturnPct: toPct(input.midReturn),
    targetPct: toPct(input.target),
    midTargetPct: toPct(input.target + input.midMargin),
    midMarginPp: toPct(input.midMargin),
    midPathEnabled: input.midPathEnabled,
    closeFraction: input.closeFraction ?? null,
    reason: input.reason,
  };
}

function emit(payload: Record<string, unknown>): void {
  console.log(JSON.stringify(payload));
}

export function logIntradayStopDecision(input: IntradayStopLogInput): void {
  emit(buildIntradayStopLogPayload(input));
}

export function logTakeProfitDecision(input: TakeProfitLogInput): void {
  emit(buildTakeProfitLogPayload(input));
}
