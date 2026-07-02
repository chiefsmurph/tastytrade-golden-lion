import { PositionGateSignals } from "./position-gate";

const REDUCTION_START_MINUTE = 7 * 60 + 30;
const REDUCTION_END_MINUTE = 11 * 60 + 30;

export function getNumDaysToSellOff(): number {
  const raw = process.env.BOT_OVERNIGHT_REDUCTION_DAYS_TO_SELLOFF?.trim();
  if (!raw) return 6;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 2 ? Math.round(parsed) : 6;
}

function getReductionStartFloorPct(): number {
  const raw = process.env.BOT_OVERNIGHT_REDUCTION_START_FLOOR_PCT?.trim();
  if (!raw) return 0.20;
  const parsed = Number(raw) / 100;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.20;
}

function getAgeBasedFloorPct(ageDays: number): number | null {
  const numDays = getNumDaysToSellOff();
  const startFloor = getReductionStartFloorPct();
  if (ageDays >= numDays) return null;
  const t = (ageDays - 1) / (numDays - 1);
  return startFloor * (1 - t);
}

// Returns forced max exposure pct, or null if no reduction applies.
// Signals with crossAccountYes or strongStockYes override and pause reduction.
// ageDays=null means position not in registry — treat as overnight with no floor (full close).
export function computeOvernightReductionTargetPct(
  currentTime: Date,
  currentExposurePct: number,
  signals: PositionGateSignals | undefined,
  ageDays: number | null,
): number | null {
  if (signals?.crossAccountYes || signals?.strongStockYes) return null;

  const minuteOfDay = currentTime.getHours() * 60 + currentTime.getMinutes();
  if (minuteOfDay < REDUCTION_START_MINUTE) return null;

  const floor = ageDays !== null ? getAgeBasedFloorPct(ageDays) : null;

  if (floor !== null && currentExposurePct <= floor) return null;

  const effectiveFloor = floor ?? 0;

  const t = Math.min(
    1,
    (minuteOfDay - REDUCTION_START_MINUTE) /
      (REDUCTION_END_MINUTE - REDUCTION_START_MINUTE),
  );

  const target = currentExposurePct * (1 - t) + effectiveFloor * t;
  return Math.max(effectiveFloor, target);
}
