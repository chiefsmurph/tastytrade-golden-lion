export type ProgrammaticAction = "MANAGE_ALLOCATION" | "CLOSE_POSITION";

// Unified return structure containing target state goals for the execution loop
export interface ExecutionStrategy {
  action: ProgrammaticAction;
  reason: string;
}

export interface ExecutionTargets {
  targetDTE: number;
  targetAccountExposure: number;
  bidWeight: number;
  midWeight: number;
  askWeight: number;
  maxTargetAccountExposure?: number;
}

function getNoBuyCutoffMinute(accountType: StrategyAccountType): number {
  return accountType === "cash" ? 13 * 60 : 12 * 60 + 30;
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

/**
 * Main Institutional Decision Engine
 * Tracks the state targets of the portfolio. If the action is MANAGE_ALLOCATION,
 * the broker pipeline should inspect exposure and execute buy orders accordingly.
 */
export function evaluateTradingStrategy(
  metrics: PositionMetrics,
  accountType: StrategyAccountType = "unknown",
): ExecutionStrategy {
  const { currentBidPrice, weightedAverageFill, currentTime, lastActionTime } = metrics;

  // 1. SYSTEM CLOCK CONVERSIONS (Pacific Standard Time - Minutes from midnight)
  const timeInMinutes = getTimeInMinutes(currentTime);

  const accumulationCutoffMinute = getNoBuyCutoffMinute(accountType);
  const TWELVE_FIFTY_FIVE_PM = 12 * 60 + 55;

  const currentReturn = (currentBidPrice - weightedAverageFill) / weightedAverageFill;

  // 2. HARD CIRCUIT BREAKERS (EOD Liquidation & Risk Floors)

  if (timeInMinutes >= TWELVE_FIFTY_FIVE_PM && accountType === "margin") {
    return {
      action: "CLOSE_POSITION",
      reason: "Market closed or closing - liquidate all positions immediately"
    };
  }

  // Take Profit Target Gate
  const dynamicTakeProfitTarget = getDynamicTakeProfitTarget(currentTime);
  if (currentReturn >= dynamicTakeProfitTarget) {
    return {
      action: "CLOSE_POSITION",
      reason: `Profit target reached (${(currentReturn * 100).toFixed(2)}% >= ${(dynamicTakeProfitTarget * 100).toFixed(2)}%) - close position and lock in gains`
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
  if (timeInMinutes < accumulationCutoffMinute && currentReturn <= -0.30) {
    return {
      action: "CLOSE_POSITION",
      reason: `Hit absolute loss limit (${(currentReturn * 100).toFixed(2)}% <= -30%) - stop loss triggered`
    };
  }

  // 4. BLOCK ALL NEW ACCUMULATION PAST THE ACCOUNT-SPECIFIC CUTOFF
  if (timeInMinutes >= accumulationCutoffMinute) {
    if (currentReturn <= -0.10) {
      return {
        action: "CLOSE_POSITION",
        reason: `End-of-day risk management (${(currentReturn * 100).toFixed(2)}% <= -10%) - close losing positions before market close`
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

  const targetDTE = Math.round(
    blendBySchedule(timeInMinutes, [
      { minute: SIX_THIRTY_AM, value: 30 },
      { minute: NINE_AM, value: 25 },
      { minute: TEN_AM, value: 20 },
      { minute: ELEVEN_AM, value: 14 },
      { minute: ELEVEN_THIRTY_AM, value: 7 },
      ...getScheduleTailPoints(accountType, 7),
    ]),
  );
  const targetAccountExposure = blendBySchedule(timeInMinutes, [
    { minute: SIX_THIRTY_AM, value: 0.40 },
    { minute: NINE_AM, value: 0.50 },
    { minute: TEN_AM, value: 0.65 },
    { minute: ELEVEN_AM, value: 0.85 },
    { minute: ELEVEN_THIRTY_AM, value: 1.00 },
    ...getScheduleTailPoints(accountType, 0.80),
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

  // Get time-of-day base targets for DTE
  const timeOfDayTargets = getTimeOfDayExecutionTargets(currentTime);

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
): ExecutionStrategy {
  return evaluateTradingStrategy(metrics, accountType);
}

function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

function blendBySchedule(
  currentMinute: number,
  schedule: TimeSchedulePoint[],
): number {
  if (schedule.length === 0) {
    return 0;
  }

  const sortedSchedule = [...schedule].sort((left, right) => left.minute - right.minute);

  if (currentMinute <= sortedSchedule[0].minute) {
    return roundToTwoDecimals(sortedSchedule[0].value);
  }

  const lastPoint = sortedSchedule[sortedSchedule.length - 1];
  if (currentMinute >= lastPoint.minute) {
    return roundToTwoDecimals(lastPoint.value);
  }

  for (let index = 0; index < sortedSchedule.length - 1; index += 1) {
    const startPoint = sortedSchedule[index];
    const endPoint = sortedSchedule[index + 1];

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