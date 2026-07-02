export interface MorningSpreadThreshold {
  minute: number;
  maxSpreadPct: number;
}

export const MORNING_SPREAD_THRESHOLDS: MorningSpreadThreshold[] = [
  { minute: 6 * 60 + 30, maxSpreadPct: 0.05 },
  { minute: 6 * 60 + 45, maxSpreadPct: 0.10 },
  { minute: 7 * 60 + 0, maxSpreadPct: 0.15 },
  { minute: 7 * 60 + 15, maxSpreadPct: 0.20 },
  { minute: 7 * 60 + 30, maxSpreadPct: 0.25 },
  { minute: 8 * 60 + 0, maxSpreadPct: 0.30 },
];

export const EOD_FORCED_CLOSE_MINUTE = 12 * 60 + 55;

export function getMorningSpreadThresholdPct(currentTime: Date): number {
  const currentMinute = currentTime.getHours() * 60 + currentTime.getMinutes();
  let threshold = MORNING_SPREAD_THRESHOLDS[0]?.maxSpreadPct ?? 0;

  for (const spreadThreshold of MORNING_SPREAD_THRESHOLDS) {
    if (currentMinute < spreadThreshold.minute) {
      break;
    }

    threshold = spreadThreshold.maxSpreadPct;
  }

  return threshold;
}
