export type ProgrammaticAction = "MANAGE_ALLOCATION" | "CLOSE_POSITION";
import type { PositionGateResult } from "./position-gate";
import type { ScaleOutContext } from "./scale-out";
import { EOD_ARMED_MINUTE } from "./spread-thresholds";
import { readEnvInt } from "~/core/env-utils";

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
 * Main Institutional Decision Engine
 * Tracks the state targets of the portfolio. If the action is MANAGE_ALLOCATION,
 * the broker pipeline should inspect exposure and execute buy orders accordingly.
 */
export function evaluateTradingStrategy(
  metrics: PositionMetrics,
  accountType: StrategyAccountType = "unknown",
  scaleOut?: ScaleOutContext,
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

  if (currentReturn >= dynamicTakeProfitTarget) {
    const scaling = scaleOut?.enabled === true;
    return {
      action: "CLOSE_POSITION",
      reason: scaling
        ? `Profit target reached (${(currentReturn * 100).toFixed(2)}% >= ${(dynamicTakeProfitTarget * 100).toFixed(2)}%) - scaling out ${(scaleOut!.fraction * 100).toFixed(0)}%, letting the rest run`
        : `Profit target reached (${(currentReturn * 100).toFixed(2)}% >= ${(dynamicTakeProfitTarget * 100).toFixed(2)}%) - close position and lock in gains`,
      ...(scaling ? { closeFraction: scaleOut!.fraction } : {}),
    };
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
    return {
      action: "CLOSE_POSITION",
      reason: `Hit absolute loss limit (${(currentReturn * 100).toFixed(2)}% <= -${(intradayFloor * 100).toFixed(0)}%) - stop loss triggered`,
      isUrgentClose: true
    };
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
): ExecutionStrategy {
  return evaluateTradingStrategy(metrics, accountType, scaleOut);
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