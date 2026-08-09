export type ProgrammaticAction = "MANAGE_ALLOCATION" | "CLOSE_POSITION";
import type { PositionGateResult } from "./position-gate";
import type { ScaleOutContext } from "./scale-out";
import { EOD_ARMED_MINUTE } from "./spread-thresholds";
import {
  resolveStopPersistence,
  type StopPersistenceContext,
} from "./stop-persistence";
import { readEnvBool, readEnvInt } from "~/core/env-utils";

// Unified return structure containing target state goals for the execution loop
export interface ExecutionStrategy {
  action: ProgrammaticAction;
  reason: string;
  // Hard-risk closes (EOD liquidation, stop-loss floors) chase fast and cross
  // to the bid on the final tick; take-profit closes keep the slow chase.
  isUrgentClose?: boolean;
  // Partial take-profit (scale-out): fraction of the position to close on this
  // trip (0..1). Absent/undefined ⇒ full close. The execution dispatcher turns
  // a <1 value into a maxQuantityToClose and marks the group as "scaled".
  closeFraction?: number;
  // Scaled runner that is holding its remainder: skip further adds so it simply
  // rides to its higher target / breakeven ratchet. Honored by the dispatcher.
  suppressAdds?: boolean;
  // The intraday stop's trigger condition held on THIS evaluation — the bid
  // cleared the floor and the midpoint confirmed it. Set on both the fired close
  // and the persistence deferral, and absent everywhere else. Read by
  // evaluate-position to advance (or reset) the persistence streak; it is the
  // engine's only output that is state, not decision.
  stopTriggerHeld?: boolean;
}

export interface ExecutionTargets {
  targetDTE: number;
  targetAccountExposure: number;
  bidWeight: number;
  midWeight: number;
  askWeight: number;
  maxTargetAccountExposure?: number;
  booleanSurplusPct?: number;
  // Applied by manage-allocation AFTER group-target normalization and the gate
  // ceiling clamp — normalization rescales targetAccountExposure to the
  // account schedule (and hands a lone group the full account target), so a
  // boost baked into targetAccountExposure would be normalized away.
  dipTargetBoostPct?: number;
  positionGate?: PositionGateResult;
  // Margin only: when the OTM candidate fails the entry-spread/liquidity gate,
  // permit a fall back to the nearest-the-money ITM strike that passes. Gated on
  // high conviction (buyWeight > 280) so momentum-flip names still skip rather
  // than buy ITM. (daytradeScore leg removed 2026-07-19 — telemetry-only now.)
  marginItmFallbackEligible?: boolean;
}

export function getNoBuyCutoffMinute(accountType: StrategyAccountType): number {
  return accountType === "cash" ? 13 * 60 : 12 * 60 + 30;
}

// Both stop floors compare against currentBidPrice (bid return), not mid.
// Tune them relative to what the position looks like at the bid, not the midpoint.
// (The intraday floor can additionally require the midpoint to agree before it
// fires — see isStopLossMidConfirmEnabled below. That is an extra condition on the
// trigger, not a change of basis: this floor is still read against the bid.)
export function getIntradayStopLossFloor(): number {
  const raw = process.env.STRATEGY_INTRADAY_STOP_LOSS_PCT?.trim();
  if (!raw) return 0.30;
  const parsed = Number(raw) / 100;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.30;
}

export function getEodStopLossFloor(): number {
  const raw = process.env.STRATEGY_EOD_STOP_LOSS_PCT?.trim();
  if (!raw) return 0.10;
  const parsed = Number(raw) / 100;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.10;
}

const DEFAULT_STOP_LOSS_MID_CONFIRM_FLOOR = 0.20;

/**
 * STRATEGY_STOP_LOSS_REQUIRE_MID_CONFIRM — require the MIDPOINT to agree before the
 * intraday bid stop fires.
 *
 * WHY. The stop compares currentBidPrice to the cost basis, and on this book the bid
 * is not a price anyone trades at. Measured over every close in the run ledger
 * 2026-07-06 → 2026-08-07 (n=80 unique closes, 34 of them stop closes): the realized
 * fill came in a MEDIAN 8.2pp of entry ABOVE the bid the stop triggered on (mean
 * +14.5pp), while it came in 2.7pp BELOW the midpoint (mean −3.5pp). Median absolute
 * error against realized: bid 11.6pp, mid 5.4pp. Across all 80 closes the midpoint is
 * the closer estimator in 46 (58%), |err| 4.8pp vs 7.3pp. So the midpoint is roughly
 * twice as good a description of what the position is actually worth, and the bid is
 * BIASED, not merely noisy.
 *
 * The bias is account-shaped, which is what makes one shared floor wrong: the
 * mid-minus-bid gap is a mean 16.7pp of entry on cash and 7.6pp on margin, so an
 * identical −30% rule trips the cash book at roughly half the drawdown it trips the
 * margin book at. 22 of the 25 intraday stops in the window (cash 21 of 24) would not
 * have fired on a −30% MIDPOINT. The extreme: PTON 2026-08-07 stopped on a −63.05%
 * bid against a +136.45% ask (145.9% spread) and realized −5.4%.
 *
 * WHY A CONFIRMATION AND NOT A BASIS SWITCH. A pure mid-basis stop at the same floor
 * is the same rule as "bid AND mid both under the floor" (mid >= bid whenever the
 * quote is not crossed), and it is far too blunt: it fires on 3 of the 25 and defers
 * 22, whose median realized was −19.2% — it would sit through genuinely broken
 * positions (NEXT −35.1%, VG −32.9%, TE −31.8%). A spread ceiling on the trigger
 * discriminates worse still: capping at 50% defers 11 whose median realized was
 * −12.1%. Requiring the midpoint to clear a SEPARATE, shallower floor fires on 16 of
 * 25 and defers 9 whose median realized was −7.1% and median mid −6.2% — i.e. it
 * removes the phantom triggers and keeps every deep one.
 *
 * DEFAULT ON as of 2026-08-08 (it shipped default-off in PR #35). A second window,
 * 2026-07-17 → 08-07, is what promoted it. There the stop family is the bot's entire
 * loss — stop-loss (n=28) returned −21.0% and eod-stop (n=12) −13.7%, together more
 * than the whole net loss of the book, while every other exit class combined was
 * positive (take-profit n=8, +20.4%). And the triggers are not describing the
 * positions: **15 of 34 stops fired while the position was flat or UP on the offer**,
 * the bot's own fills came in +14.5pp of entry better than the bid they triggered on
 * in **20 of 25** cases, and **15 of 17 intraday stops had a MIDPOINT above −30%** —
 * they would not have fired on mid at all. A −30% bid stop is roughly a −15% stop in
 * executable terms. IOVA 2026-08-03 is the clean example: the midpoint sat between
 * +2.7% and +12% all day, one cycle printed a −53.3% bid against a +68% ask, the stop
 * fired, and it FILLED AT +6.4% — a winner sold on a phantom bid.
 *
 * At the default 20% floor this defers exactly the 6 demonstrably-wrong stops in that
 * window (CNH, TDOC, IOVA, SG, AUR, PTON) and still fires the 11 real ones, whose
 * median realized was −29.6%.
 *
 * DO NOT RAISE IT TO 25. Measured: 25% defers 11 of the 17 intraday stops, including
 * genuinely dead positions sitting at a −22% midpoint. 20 is the edge of the split.
 *
 * The midpoint is NOT truth either, and the justification is not that it predicts
 * better. TDOC 2026-07-30 showed a −5.8% midpoint and booked −25.0%. The argument for
 * this gate is narrower and harder to argue with: **stop triggering on a number the
 * position cannot transact at.**
 *
 * SCOPE: the intraday floor only. The EOD floor (−10%) is deliberately untouched —
 * n=9 there, its floor is shallow enough that the same gap means something different,
 * and deferring an exit minutes from the close is a materially worse trade than
 * deferring one at 9am.
 */
export function isStopLossMidConfirmEnabled(): boolean {
  return readEnvBool("STRATEGY_STOP_LOSS_REQUIRE_MID_CONFIRM", true);
}

/**
 * STRATEGY_STOP_LOSS_MID_CONFIRM_PCT — how far under water the MIDPOINT must also be
 * before the intraday bid stop is allowed to fire. Integer percent, same convention
 * as the floors above (`20` ⇒ mid return must be <= −20%).
 *
 * Clamped to the intraday floor: a confirmation floor deeper than the bid floor would
 * make the bid trigger dead weight and silently turn this into a pure mid stop at a
 * floor nobody wrote down.
 */
export function getStopLossMidConfirmFloor(intradayFloor: number): number {
  const raw = process.env.STRATEGY_STOP_LOSS_MID_CONFIRM_PCT?.trim();
  const parsed = raw ? Number(raw) / 100 : DEFAULT_STOP_LOSS_MID_CONFIRM_FLOOR;
  const floor =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_STOP_LOSS_MID_CONFIRM_FLOOR;
  return Math.min(floor, intradayFloor);
}

/**
 * Midpoint return vs cost basis, or null when no honest midpoint exists.
 *
 * Every null case FAILS TOWARD TODAY'S BEHAVIOUR (the stop fires): a one-sided quote
 * has no midpoint, a crossed quote's "midpoint" is below the bid and would defer a
 * stop on arithmetic rather than on evidence, and a position with no cost basis has a
 * meaningless return on any basis. The confirmation may only ever SUPPRESS a trigger
 * on a quote good enough to argue with.
 */
function hasArguableQuote(metrics: PositionMetrics): boolean {
  const { currentBidPrice, currentAskPrice, weightedAverageFill } = metrics;
  // ask >= bid > 0 subsumes "ask is present"; a crossed or one-sided book fails it.
  return weightedAverageFill > 0 && currentBidPrice > 0 && currentAskPrice >= currentBidPrice;
}

function getMidReturn(metrics: PositionMetrics): number | null {
  if (!hasArguableQuote(metrics)) return null;
  const { currentBidPrice, currentAskPrice, weightedAverageFill } = metrics;
  const midpoint = (currentBidPrice + currentAskPrice) / 2;
  return (midpoint - weightedAverageFill) / weightedAverageFill;
}

interface StopLossMidConfirmation {
  defer: boolean;
  midFloor: number;
  midReturn?: number;
}

/** Should a bid trigger that has already cleared `intradayFloor` be held back? */
function evaluateStopLossMidConfirmation(
  metrics: PositionMetrics,
  intradayFloor: number,
): StopLossMidConfirmation {
  const midFloor = getStopLossMidConfirmFloor(intradayFloor);
  if (!isStopLossMidConfirmEnabled()) {
    return { defer: false, midFloor };
  }

  const midReturn = getMidReturn(metrics);
  if (midReturn == null) {
    return { defer: false, midFloor };
  }

  return { defer: midReturn > -midFloor, midFloor, midReturn };
}

/**
 * The intraday floor's verdict once the BID trigger has already cleared. Split out
 * of the engine so the deferral branches are readable next to the close they replace.
 *
 * Two independent conditions can hold the close back, in order:
 *   1. mid confirmation — the quote does not agree that the position is broken;
 *   2. persistence      — the quote agrees, but only on this one reading.
 *
 * Both deferrals suppress adds. Falling through to a plain MANAGE_ALLOCATION would
 * let the allocator average down on the same quote the stop was just told not to
 * trust — the honest reading of a disputed quote is "do nothing", not "do the
 * opposite". It also keeps the group's cost basis static while a streak builds,
 * which is what makes the store's WAF re-entry guard meaningful.
 */
function resolveIntradayStop(
  metrics: PositionMetrics,
  currentReturn: number,
  intradayFloor: number,
  persistence?: StopPersistenceContext,
): ExecutionStrategy {
  const midConfirmation = evaluateStopLossMidConfirmation(metrics, intradayFloor);
  if (midConfirmation.defer) {
    return {
      action: "MANAGE_ALLOCATION",
      reason: `Stop-loss deferred by mid confirmation (bid ${(currentReturn * 100).toFixed(2)}% <= -${(intradayFloor * 100).toFixed(0)}% but mid ${((midConfirmation.midReturn ?? 0) * 100).toFixed(2)}% > -${(midConfirmation.midFloor * 100).toFixed(0)}%) - holding, no adds`,
      suppressAdds: true,
    };
  }

  const persistenceVerdict = resolveStopPersistence(
    currentReturn,
    getMidReturn(metrics),
    intradayFloor,
    persistence,
  );
  if (persistenceVerdict.defer) {
    return {
      action: "MANAGE_ALLOCATION",
      reason: `Stop-loss awaiting confirmation (bid ${(currentReturn * 100).toFixed(2)}% <= -${(intradayFloor * 100).toFixed(0)}% on ${persistenceVerdict.observedCycles} of ${persistenceVerdict.requiredCycles} consecutive cycles) - holding, no adds`,
      stopTriggerHeld: true,
      suppressAdds: true,
    };
  }

  return {
    action: "CLOSE_POSITION",
    reason: `Hit absolute loss limit (${(currentReturn * 100).toFixed(2)}% <= -${(intradayFloor * 100).toFixed(0)}%) - stop loss triggered${persistenceVerdict.bypassed ? " (collapse bypass)" : ""}`,
    isUrgentClose: true,
    stopTriggerHeld: true,
  };
}

function getScheduleTailPoints(
  accountType: StrategyAccountType,
  value: number,
): TimeSchedulePoint[] {
  const TWELVE_THIRTY_PM = 12 * 60 + 30;
  const cutoffMinute = getNoBuyCutoffMinute(accountType);

  return cutoffMinute > TWELVE_THIRTY_PM
    ? [
        { minute: TWELVE_THIRTY_PM, value },
        { minute: cutoffMinute, value },
      ]
    : [{ minute: TWELVE_THIRTY_PM, value }];
}

function getMaxAskWeightForPositionSize(positionSizePct: number): number {
  if (positionSizePct <= 0.15) {
    return 0.50;
  }

  if (positionSizePct <= 0.30) {
    return 0.75;
  }

  return 1.00;
}

export function applyPositionSizeWeightCaps(
  targets: ExecutionTargets,
  positionSizePct: number,
): ExecutionTargets {
  const normalizedPositionSize = Number.isFinite(positionSizePct)
    ? Math.max(0, positionSizePct)
    : 0;
  const maxAskWeight = getMaxAskWeightForPositionSize(normalizedPositionSize);
  const cappedAskWeight = Math.min(targets.askWeight, maxAskWeight);
  const askReduction = Math.max(0, targets.askWeight - cappedAskWeight);

  return {
    ...targets,
    askWeight: roundToTwoDecimals(cappedAskWeight),
    midWeight: roundToTwoDecimals(targets.midWeight + askReduction),
  };
}

export interface PositionMetrics {
  currentBidPrice: number;
  currentAskPrice: number;
  weightedAverageFill: number;   // Our WAF cost basis
  currentTime: Date;             // Current system clock
  lastActionTime: Date;          // When this recommendation first flashed
}

export type StrategyAccountType = "margin" | "cash" | "unknown";

interface TimeSchedulePoint {
  minute: number;
  value: number;
}

export function calcTimeBlend(
  currentTime: Date,
  startScore: number,
  endScore: number,
  startMinute: number,
  endMinute: number,
): number {
  const currentMinute = currentTime.getHours() * 60 + currentTime.getMinutes();
  const minuteSpan = endMinute - startMinute;

  if (minuteSpan <= 0) {
    return roundToTwoDecimals(endScore);
  }

  const minutesPastStart = currentMinute - startMinute;
  const ratioPast = Math.max(0, Math.min(1, minutesPastStart / minuteSpan));
  const spreadBetweenScores = startScore - endScore;
  const currentScore = startScore - spreadBetweenScores * ratioPast;

  return roundToTwoDecimals(currentScore);
}

export function getDynamicTakeProfitTarget(currentTime: Date): number {
  const sixThirtyAM = 6 * 60 + 30;
  const twelveFiftyFivePM = 12 * 60 + 55;

  return calcTimeBlend(currentTime, 0.4, 0.07, sixThirtyAM, twelveFiftyFivePM);
}

const DEFAULT_TAKE_PROFIT_MID_MARGIN = 0.05;

/**
 * STRATEGY_TAKE_PROFIT_ALLOW_MID — let the dynamic take-profit fire on the MIDPOINT
 * as well as the bid. **Default ON.**
 *
 * WHY. The take-profit reads the same bid the stop does, so the same wide spreads
 * that make the stop fire early make the take-profit fire late or never. Over
 * 2026-07-17 → 08-07, across 14 symbol-days, **158 cycles sat above the dynamic
 * target at the MIDPOINT while the bid had not reached it, against 5 cycles where
 * the bid triggered.** SGML finished 2026-08-07 at a +22.3% midpoint and never sold.
 * Fixing only the loss side of a bid-based engine leaves the win side censored — the
 * bid stop and the bid target are the same measurement error with opposite signs.
 */
function isTakeProfitMidPathEnabled(): boolean {
  return readEnvBool("STRATEGY_TAKE_PROFIT_ALLOW_MID", true);
}

/**
 * STRATEGY_TAKE_PROFIT_MID_MARGIN_PCT — how far ABOVE the dynamic target the midpoint
 * must sit before the mid path fires. Integer percent (`5` ⇒ target + 5pp), default 5.
 *
 * The margin exists because a mid trigger is a claim about a price we have not been
 * shown: the close chase starts at the ask and CONCEDES downward, so a midpoint
 * exactly at target would land under it on any fill below mid. Headroom means an
 * ordinary concession still books at or above the target that justified the exit.
 */
function getTakeProfitMidMargin(): number {
  const raw = process.env.STRATEGY_TAKE_PROFIT_MID_MARGIN_PCT?.trim();
  const parsed = raw ? Number(raw) / 100 : DEFAULT_TAKE_PROFIT_MID_MARGIN;
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_TAKE_PROFIT_MID_MARGIN;
}

/**
 * Can the midpoint alone justify a take-profit close?
 *
 * EXECUTABILITY is the whole design constraint here, and it is settled by how
 * `closePosition` actually sells. A take-profit close is NON-urgent, so
 * `getCloseStartPrice` posts it at the ASK and `getSellEdgePrice` walks it down to
 * the BID over up to 10 rungs (close-position.ts). **The bid is therefore the
 * worst-case fill of a mid-triggered exit** — triggering on a mid the position
 * cannot transact at just starts a chase down, which is the exact mistake this
 * change is fixing on the stop side.
 *
 * So the mid path additionally requires the BID to be at or above breakeven. That is
 * an invariant, not a knob: a close classified `take-profit` must never be able to
 * book a loss. It is what keeps the phantom quotes out — PTON's −63.05% bid against a
 * +136.45% ask has a hugely positive midpoint and must never be sold into, and the
 * IOVA cycle that printed a −53.3% bid against a +68% ask would clear a naive mid
 * test on the same day the stop wrongly fired on it.
 *
 * The second half of executability is already in place and deliberately reused rather
 * than duplicated: `shouldSkipClosePositionForMorningSpread` only waives the close-side
 * spread ceiling for BID take-profits and urgent closes, so a mid-triggered close on a
 * genuinely unusable spread is SKIPPED and the position simply held for another cycle.
 * That is the sensible degradation — no fill beats a bad fill when nothing forces the
 * exit.
 */
function isTakeProfitMidTriggered(
  metrics: PositionMetrics,
  bidReturn: number,
  target: number,
): boolean {
  if (!isTakeProfitMidPathEnabled()) return false;
  if (!(bidReturn >= 0)) return false;
  const midReturn = getMidReturn(metrics);
  return midReturn != null && midReturn >= target + getTakeProfitMidMargin();
}

function getTimeInMinutes(currentTime: Date): number {
  return currentTime.getHours() * 60 + currentTime.getMinutes();
}

// Runner decision for a group whose first tranche was already scaled out. The
// base take-profit no longer applies: ride to a higher target, protect at
// breakeven (never let a winner become a loser), else hold and suppress adds.
// Extracted so the branch set stays out of the main engine and is unit-testable.
function evaluateScaledRunner(
  currentReturn: number,
  dynamicTakeProfitTarget: number,
  scaleOut: ScaleOutContext,
): ExecutionStrategy {
  const runnerTarget = dynamicTakeProfitTarget * scaleOut.runnerTargetMultiple;
  if (currentReturn >= runnerTarget) {
    return {
      action: "CLOSE_POSITION",
      reason: `Runner target reached (${(currentReturn * 100).toFixed(2)}% >= ${(runnerTarget * 100).toFixed(2)}%) - close remaining runner`,
    };
  }
  if (currentReturn <= 0) {
    return {
      action: "CLOSE_POSITION",
      reason: `Runner breakeven ratchet (${(currentReturn * 100).toFixed(2)}% <= 0%) - lock the scaled-out remainder`,
      isUrgentClose: true,
    };
  }
  return {
    action: "MANAGE_ALLOCATION",
    reason: `Scaled runner riding (${(currentReturn * 100).toFixed(2)}%, target ${(runnerTarget * 100).toFixed(2)}%) - holding remainder, no adds`,
    suppressAdds: true,
  };
}

/**
 * The take-profit gate, or null when neither basis has reached the target.
 *
 * Both bases produce the SAME `Profit target reached (…)` prefix on purpose — the
 * P&L ledger classifies closes by that prefix (pnl-ledger.ts `classifyCloseDecision`),
 * so a mid-path exit has to stay a `take-profit` there. The tail names the basis so
 * the two are still separable when reading the run history.
 */
function resolveTakeProfit(
  metrics: PositionMetrics,
  currentReturn: number,
  dynamicTakeProfitTarget: number,
  scaleOut?: ScaleOutContext,
): ExecutionStrategy | null {
  const targetPct = (dynamicTakeProfitTarget * 100).toFixed(2);
  const bidTriggered = currentReturn >= dynamicTakeProfitTarget;
  if (
    !bidTriggered &&
    !isTakeProfitMidTriggered(metrics, currentReturn, dynamicTakeProfitTarget)
  ) {
    return null;
  }

  const basis = bidTriggered
    ? `${(currentReturn * 100).toFixed(2)}% >= ${targetPct}%`
    : `mid ${((getMidReturn(metrics) ?? 0) * 100).toFixed(2)}% >= ${targetPct}% + ${(getTakeProfitMidMargin() * 100).toFixed(0)}pp, bid ${(currentReturn * 100).toFixed(2)}%`;
  const scaling = scaleOut?.enabled === true;

  return {
    action: "CLOSE_POSITION",
    reason: scaling
      ? `Profit target reached (${basis}) - scaling out ${(scaleOut!.fraction * 100).toFixed(0)}%, letting the rest run`
      : `Profit target reached (${basis}) - close position and lock in gains`,
    ...(scaling ? { closeFraction: scaleOut!.fraction } : {}),
  };
}

/**
 * Main Institutional Decision Engine
 * Tracks the state targets of the portfolio. If the action is MANAGE_ALLOCATION,
 * the broker pipeline should inspect exposure and execute buy orders accordingly.
 *
 * `stopPersistence` is the caller's cycle history for this group. Omitting it makes
 * the persistence gate INERT — see resolveStopPersistence for why the execution-time
 * re-check must not re-litigate a stop the cycle already confirmed.
 */
export function evaluateTradingStrategy(
  metrics: PositionMetrics,
  accountType: StrategyAccountType = "unknown",
  scaleOut?: ScaleOutContext,
  stopPersistence?: StopPersistenceContext,
): ExecutionStrategy {
  const { currentBidPrice, weightedAverageFill, currentTime, lastActionTime } = metrics;

  // 1. SYSTEM CLOCK CONVERSIONS (Pacific Standard Time - Minutes from midnight)
  const timeInMinutes = getTimeInMinutes(currentTime);

  const accumulationCutoffMinute = getNoBuyCutoffMinute(accountType);

  const currentReturn = (currentBidPrice - weightedAverageFill) / weightedAverageFill;

  // 2. HARD CIRCUIT BREAKERS (EOD Liquidation & Risk Floors)

  // Armed at 12:50 so a cycle starting late in the interval still fits a full
  // urgent tick-chase before the 1:00 PM PT options close.
  if (timeInMinutes >= EOD_ARMED_MINUTE && accountType === "margin") {
    return {
      action: "CLOSE_POSITION",
      reason: "Market closed or closing - liquidate all positions immediately",
      isUrgentClose: true
    };
  }

  // Take Profit / Scale-Out Gate
  const dynamicTakeProfitTarget = getDynamicTakeProfitTarget(currentTime);

  // Scaled runner: the base target is superseded (see evaluateScaledRunner).
  // EOD margin liquidation above still flattens margin runners before this.
  if (scaleOut?.enabled && scaleOut.alreadyScaled) {
    return evaluateScaledRunner(currentReturn, dynamicTakeProfitTarget, scaleOut);
  }

  const takeProfit = resolveTakeProfit(
    metrics,
    currentReturn,
    dynamicTakeProfitTarget,
    scaleOut,
  );
  if (takeProfit) {
    return takeProfit;
  }

  // Minimum 10-minute cooldown since last action
  const timeSinceLastActionMs = currentTime.getTime() - lastActionTime.getTime();
  const timeSinceLastActionMinutes = timeSinceLastActionMs / (1000 * 60);
  if (timeSinceLastActionMinutes < 10) {
    return {
      action: "MANAGE_ALLOCATION",
      reason: `Still in cooldown period (${timeSinceLastActionMinutes.toFixed(1)} min < 10 min) - no new actions yet`
    };
  }

  // Absolute Risk Floor Check
  const intradayFloor = getIntradayStopLossFloor();
  if (timeInMinutes < accumulationCutoffMinute && currentReturn <= -intradayFloor) {
    return resolveIntradayStop(
      metrics,
      currentReturn,
      intradayFloor,
      stopPersistence,
    );
  }

  // 4. BLOCK ALL NEW ACCUMULATION PAST THE ACCOUNT-SPECIFIC CUTOFF
  if (timeInMinutes >= accumulationCutoffMinute) {
    const eodFloor = getEodStopLossFloor();
    if (currentReturn <= -eodFloor) {
      return {
        action: "CLOSE_POSITION",
        reason: `End-of-day risk management (${(currentReturn * 100).toFixed(2)}% <= -${(eodFloor * 100).toFixed(0)}%) - close losing positions before market close`,
        isUrgentClose: true
      };
    }
  }

  return {
    action: "MANAGE_ALLOCATION",
    reason: "No circuit breakers triggered - proceed with allocation management"
  };
}

export function getTimeOfDayExecutionTargets(
  currentTime: Date,
  accountType: StrategyAccountType = "unknown",
): ExecutionTargets {
  const timeInMinutes = getTimeInMinutes(currentTime);
  return getTimeOfDayExecutionTargetsForMinute(timeInMinutes, accountType);
}

function getTimeOfDayExecutionTargetsForMinute(
  timeInMinutes: number,
  accountType: StrategyAccountType = "unknown",
): ExecutionTargets {

  const SIX_THIRTY_AM      = 6 * 60 + 30;
  const NINE_AM            = 9 * 60 + 0;
  const TEN_AM             = 10 * 60 + 0;
  const ELEVEN_AM          = 11 * 60 + 0;
  const ELEVEN_THIRTY_AM   = 11 * 60 + 30;
  const noBuyCutoffMinute = getNoBuyCutoffMinute(accountType);

  const marginMaxDTE = readEnvInt("STRATEGY_MARGIN_MAX_TARGET_DTE", 7, (n) => n > 0);
  const cashMinDTE   = readEnvInt("STRATEGY_CASH_MIN_TARGET_DTE", 7, (n) => n > 0);

  const rawTargetDTE = Math.round(
    blendBySchedule(timeInMinutes, [
      { minute: SIX_THIRTY_AM, value: 30 },
      { minute: NINE_AM, value: 25 },
      { minute: TEN_AM, value: 20 },
      { minute: ELEVEN_AM, value: 14 },
      { minute: ELEVEN_THIRTY_AM, value: 7 },
      ...getScheduleTailPoints(accountType, 7),
    ]),
  );
  const targetDTE = accountType === "margin"
    ? Math.min(rawTargetDTE, marginMaxDTE)
    : Math.max(rawTargetDTE, cashMinDTE);
  // Morning-weighted exposure schedules (2026-07-12). Margin must be flat by
  // ~12:55 and the cutoff guard blocks entries near the 12:30 cutoff, so early
  // buys are the only ones with runway — margin ramps to full deployment by
  // 10:30 AM. Cash holds overnight and keeps its later 12:45 peak with a
  // raised morning floor. The morning entry-spread ramp (spread-thresholds.ts)
  // is deliberately unchanged: this buys more of what already qualifies, not
  // looser qualification.
  const TEN_THIRTY_AM      = 10 * 60 + 30;
  const TWELVE_FORTY_FIVE  = 12 * 60 + 45;
  const targetAccountExposure = accountType === "cash"
    ? blendBySchedule(timeInMinutes, [
        { minute: SIX_THIRTY_AM,  value: 0.55 },
        { minute: NINE_AM,        value: 0.70 },
        { minute: TEN_AM,         value: 0.80 },
        { minute: ELEVEN_AM,      value: 0.90 },
        { minute: TWELVE_FORTY_FIVE, value: 1.00 },
        { minute: noBuyCutoffMinute, value: 1.00 },
      ])
    : blendBySchedule(timeInMinutes, [
        { minute: SIX_THIRTY_AM,  value: 0.60 },
        { minute: NINE_AM,        value: 0.80 },
        { minute: TEN_THIRTY_AM,  value: 1.00 },
        { minute: noBuyCutoffMinute, value: 1.00 },
      ]);
  const bidWeight = blendBySchedule(timeInMinutes, [
    { minute: SIX_THIRTY_AM, value: 0.70 },
    { minute: NINE_AM, value: 0.50 },
    { minute: TEN_AM, value: 0.33 },
    { minute: ELEVEN_AM, value: 0.20 },
    { minute: ELEVEN_THIRTY_AM, value: 0.00 },
    ...getScheduleTailPoints(accountType, 0.00),
  ]);
  const midWeight = blendBySchedule(timeInMinutes, [
    { minute: SIX_THIRTY_AM, value: 0.20 },
    { minute: NINE_AM, value: 0.30 },
    { minute: TEN_AM, value: 0.33 },
    { minute: ELEVEN_AM, value: 0.30 },
    { minute: ELEVEN_THIRTY_AM, value: 0.25 },
    ...getScheduleTailPoints(accountType, 0.15),
  ]);
  const askWeight = blendBySchedule(timeInMinutes, [
    { minute: SIX_THIRTY_AM, value: 0.10 },
    { minute: NINE_AM, value: 0.20 },
    { minute: TEN_AM, value: 0.33 },
    { minute: ELEVEN_AM, value: 0.50 },
    { minute: ELEVEN_THIRTY_AM, value: 0.75 },
    ...getScheduleTailPoints(accountType, 0.85),
  ]);

  if (timeInMinutes >= noBuyCutoffMinute) {
    return {
      askWeight: 0,
      bidWeight: 0,
      midWeight: 0,
      targetAccountExposure: 0,
      targetDTE,
    };
  }

  return {
    askWeight,
    bidWeight,
    midWeight,
    targetAccountExposure,
    targetDTE,
  };
}

export function getTimeOfDayExecutionTargetsForPstTime(
  timeOfDay?: string,
  accountType: StrategyAccountType = "unknown",
): ExecutionTargets {
  if (!timeOfDay) {
    return getTimeOfDayExecutionTargets(new Date(), accountType);
  }
  const match = timeOfDay.trim().match(/^(?:[01]?\d|2[0-3]):[0-5]\d$/);
  if (!match) {
    throw new Error("Invalid time format. Expected HH:mm in Pacific time, e.g. 10:14");
  }

  const [hoursText, minutesText] = timeOfDay.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const timeInMinutes = hours * 60 + minutes;

  return getTimeOfDayExecutionTargetsForMinute(timeInMinutes, accountType);
}

export function getPositionGroupExecutionTargets(
  askReturnPerc: number,
  timeSinceLastActionMs: number,
  currentTime: Date,
  accountType: StrategyAccountType = "unknown",
): ExecutionTargets {
  // Scale targetExposureValue based on time since last action
  // 20 min → 40%, 60 min → 70%, 120+ min (2 hrs) → cap at 85%
  const timeSinceLastActionMinutes = timeSinceLastActionMs / (1000 * 60);
  const MIN_EXPOSURE = 0.40;
  const MAX_EXPOSURE = 0.85;
  const MIN_TIME_MINUTES = 20;
  const MAX_TIME_MINUTES = 120;
  
  let targetExposure = MIN_EXPOSURE;
  if (timeSinceLastActionMinutes >= MIN_TIME_MINUTES) {
    const timeRatio = Math.min(
      1,
      (timeSinceLastActionMinutes - MIN_TIME_MINUTES) /
        (MAX_TIME_MINUTES - MIN_TIME_MINUTES),
    );
    targetExposure = MIN_EXPOSURE + (MAX_EXPOSURE - MIN_EXPOSURE) * timeRatio;
  }

  // Scale weights based on askReturnPerc aggressiveness
  // More negative (losing) → more aggressive (higher askWeight, lower bidWeight)
  // askReturnPerc = -0.20 (down 20%) → very aggressive
  // askReturnPerc = 0.00 (at cost) → neutral
  // askReturnPerc = 0.10 (up 10%) → conservative
  const aggressivenessFactor = Math.max(-1, Math.min(0.5, -askReturnPerc));
  // aggressivenessFactor: at -0.20 → 0.20, at 0 → 0, at 0.10 → -0.10 (clamped to 0)

  // Start with base weighted split
  let askWeight = 0.33;
  let midWeight = 0.33;
  let bidWeight = 0.33;

  // When losing (negative askReturnPerc), shift weights toward higher prices
  // to reduce cost basis
  if (aggressivenessFactor > 0) {
    // Shift from bid to ask, keeping mid stable
    const bidReduction = 0.25 * aggressivenessFactor;
    const askIncrease = 0.25 * aggressivenessFactor;
    askWeight = Math.min(0.75, 0.33 + askIncrease);
    bidWeight = Math.max(0.05, 0.33 - bidReduction);
    midWeight = roundToTwoDecimals(1 - askWeight - bidWeight);
  }

  // Get time-of-day base targets for DTE. accountType must flow through here:
  // dropping it took the cash branch (max(raw, cashMinDTE) → 30 in the
  // morning) and margin plans blended to 15-30 DTE despite the 7-DTE cap.
  const timeOfDayTargets = getTimeOfDayExecutionTargets(currentTime, accountType);

  return {
    targetDTE: timeOfDayTargets.targetDTE,
    targetAccountExposure: roundToTwoDecimals(targetExposure),
    bidWeight: roundToTwoDecimals(bidWeight),
    midWeight: roundToTwoDecimals(midWeight),
    askWeight: roundToTwoDecimals(askWeight),
  };
}

export function averageExecutionTargets(
  targets: ExecutionTargets[],
): ExecutionTargets {
  if (targets.length === 0) {
    return {
      targetDTE: 30,
      targetAccountExposure: 0.50,
      bidWeight: 0.33,
      midWeight: 0.33,
      askWeight: 0.33,
    };
  }

  const avgDTE = Math.round(
    targets.reduce((sum, t) => sum + t.targetDTE, 0) / targets.length,
  );
  const avgExposure = roundToTwoDecimals(
    targets.reduce((sum, t) => sum + t.targetAccountExposure, 0) / targets.length,
  );
  const avgBidWeight = roundToTwoDecimals(
    targets.reduce((sum, t) => sum + t.bidWeight, 0) / targets.length,
  );
  const avgMidWeight = roundToTwoDecimals(
    targets.reduce((sum, t) => sum + t.midWeight, 0) / targets.length,
  );
  const avgAskWeight = roundToTwoDecimals(
    targets.reduce((sum, t) => sum + t.askWeight, 0) / targets.length,
  );

  return {
    targetDTE: avgDTE,
    targetAccountExposure: avgExposure,
    bidWeight: avgBidWeight,
    midWeight: avgMidWeight,
    askWeight: avgAskWeight,
  };
}

export function buildExecutionStrategy(
  metrics: PositionMetrics,
  accountType: StrategyAccountType = "unknown",
  scaleOut?: ScaleOutContext,
  stopPersistence?: StopPersistenceContext,
): ExecutionStrategy {
  return evaluateTradingStrategy(metrics, accountType, scaleOut, stopPersistence);
}

function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

// INVARIANT: every caller must pass `schedule` already sorted ascending by
// `minute`.  The sort that used to live here has been removed to avoid
// allocating + sorting a new array on every call (called ~5× per cycle with
// effectively constant data).  All call sites in this module construct their
// arrays with entries in strict ascending minute order.
function blendBySchedule(
  currentMinute: number,
  schedule: TimeSchedulePoint[],
): number {
  if (schedule.length === 0) {
    return 0;
  }

  if (currentMinute <= schedule[0].minute) {
    return roundToTwoDecimals(schedule[0].value);
  }

  const lastPoint = schedule[schedule.length - 1];
  if (currentMinute >= lastPoint.minute) {
    return roundToTwoDecimals(lastPoint.value);
  }

  for (let index = 0; index < schedule.length - 1; index += 1) {
    const startPoint = schedule[index];
    const endPoint = schedule[index + 1];

    if (currentMinute >= startPoint.minute && currentMinute < endPoint.minute) {
      return calcTimeBlend(
        new Date(0, 0, 0, Math.floor(currentMinute / 60), currentMinute % 60),
        startPoint.value,
        endPoint.value,
        startPoint.minute,
        endPoint.minute,
      );
    }
  }

  return roundToTwoDecimals(lastPoint.value);
}