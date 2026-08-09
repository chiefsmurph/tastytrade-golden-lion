import { readEnvInt } from "~/core/env-utils";

/**
 * Stop-loss PERSISTENCE: the intraday stop must see its trigger hold across N
 * consecutive evaluations of the same position group before it closes.
 *
 * WHY. The stop reads a single instantaneous quote. Over 2026-07-17 → 08-07 the
 * stop family is the entire loss the bot books — stop-loss (n=28) returned
 * −21.0% and eod-stop (n=12) −13.7%, together more than the whole net loss of
 * the book, while every other exit class combined was positive (take-profit
 * n=8, +20.4%). The failure mode is not "the stop is too tight", it is that the
 * stop is sampling noise:
 *
 * - **5 of the 5 stops with full-day quote history fired on ONE cycle out of the
 *   26–100 cycles that position was held**, on days whose MEDIAN bid return was
 *   −10% to −23%. The trigger is behaving as a max-of-day sampler on a noisy
 *   series, not as a description of the position.
 * - **15 of 21 stops fired inside the first or last 30 minutes of the session**,
 *   where the median spread was 57% versus 24.5% midday.
 * - **15 of 34 stops fired while the position was flat or UP on the offer.**
 *
 * A single extra confirmation is the highest-leverage available fix precisely
 * because the bad triggers are one-cycle events: requiring the condition to
 * survive one more observation costs ~one cycle of delay on a real stop and
 * removes the one-print artifacts entirely.
 *
 * NOT the entry spread gate. Stopped positions were ENTERED at a median 9.6–13.3%
 * spread and only 3 of 32 were anywhere near the 30% entry ceiling — the spread
 * blows out AFTER entry. That hypothesis is measured and dead; do not re-tighten
 * the entry gate on this evidence.
 */
export interface StopPersistenceContext {
  /**
   * How many consecutive IMMEDIATELY-PRECEDING evaluations of this exact group
   * (same account, same `UNDERLYING::side`, same cost basis) already saw the
   * stop trigger hold. 0 for a group with no usable history — including a
   * position on its very first cycle.
   */
  priorConsecutiveTriggers: number;
}

export interface StopPersistenceVerdict {
  /** Hold the stop this cycle (the streak is not long enough yet). */
  defer: boolean;
  /** Consecutive triggering evaluations INCLUDING this one. */
  observedCycles: number;
  /** How many the configured floor demands. */
  requiredCycles: number;
  /** The collapse escape hatch fired, so the streak requirement was skipped. */
  bypassed: boolean;
}

const DEFAULT_PERSIST_CYCLES = 2;
const DEFAULT_PERSIST_BYPASS_FLOOR = 0.45;
// The bypass has to sit strictly deeper than the floor it can override, or every
// stop bypasses and the gate is dead weight. 1.25× mirrors the mid-confirmation
// clamp on the other side (that one is clamped to be no DEEPER than the floor).
const MIN_BYPASS_MULTIPLE_OF_FLOOR = 1.25;

/**
 * STRATEGY_STOP_LOSS_PERSIST_CYCLES — consecutive triggering evaluations required
 * before the intraday stop closes. **1 restores the pre-2026-08-08 behaviour**
 * (fire on the first print); the default is **2**.
 */
function getStopLossPersistCycles(): number {
  return readEnvInt("STRATEGY_STOP_LOSS_PERSIST_CYCLES", DEFAULT_PERSIST_CYCLES, (n) => n >= 1);
}

/**
 * STRATEGY_STOP_LOSS_PERSIST_BYPASS_PCT — the collapse escape hatch. When the BID
 * and the MIDPOINT are BOTH at or below −this, the stop fires immediately with no
 * streak requirement. Integer percent, same convention as the floors.
 *
 * Default **45**: 1.5× the −30% intraday floor, and far below the −29.6% median
 * realized loss of the 11 stops in the window that were genuinely right — so it
 * cannot swallow the ordinary case persistence exists to filter. Requiring the
 * midpoint to agree is what makes it safe to arm: a phantom bid alone (PTON's
 * −63.05% bid against a +136.45% ask) must never buy an instant exit, and that is
 * the exact reading persistence is protecting against.
 *
 * Honest scope: on the 2026-07-17 → 08-07 sample this bypass fires on ZERO stops.
 * It is tail insurance for a real gap-down, not a knob tuned to recover the sample.
 */
function getStopLossPersistBypassFloor(intradayFloor: number): number {
  const raw = process.env.STRATEGY_STOP_LOSS_PERSIST_BYPASS_PCT?.trim();
  const parsed = raw ? Number(raw) / 100 : DEFAULT_PERSIST_BYPASS_FLOOR;
  const floor =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PERSIST_BYPASS_FLOOR;
  return Math.max(floor, intradayFloor * MIN_BYPASS_MULTIPLE_OF_FLOOR);
}

/**
 * Should a bid trigger that has already cleared the floor (and the midpoint
 * confirmation) be held back for one more cycle?
 *
 * `persistence == null` ⇒ the caller has no cycle history to offer, and the gate
 * is INERT. That is deliberate and load-bearing: the execution-time re-check in
 * `closePosition` and the contract-selection probe both re-run the engine without
 * a store, and an active gate there would silently cancel a stop that the cycle
 * had already confirmed.
 *
 * A position on its FIRST cycle has `priorConsecutiveTriggers === 0` and is
 * therefore deferred. Two stops in the measured window (AUR 2026-08-06, PTON
 * 2026-08-07) fired on their opening cycle with no predecessor at all; firing on
 * cycle 1 with no history is precisely what this gate exists to prevent.
 */
export function resolveStopPersistence(
  bidReturn: number,
  midReturn: number | null,
  intradayFloor: number,
  persistence?: StopPersistenceContext,
): StopPersistenceVerdict {
  const requiredCycles = getStopLossPersistCycles();
  const priorTriggers = Math.max(0, persistence?.priorConsecutiveTriggers ?? 0);
  const observedCycles = priorTriggers + 1;
  const inert = persistence == null || requiredCycles <= 1;

  const bypassFloor = getStopLossPersistBypassFloor(intradayFloor);
  const bypassed =
    !inert &&
    midReturn != null &&
    bidReturn <= -bypassFloor &&
    midReturn <= -bypassFloor;

  return {
    bypassed,
    defer: !inert && !bypassed && observedCycles < requiredCycles,
    observedCycles,
    requiredCycles,
  };
}
