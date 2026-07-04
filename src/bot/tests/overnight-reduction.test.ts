import test from "node:test";
import assert from "node:assert/strict";

import {
  getAgeBasedFloorPct,
  computeOvernightReductionTargetPct,
  isInOvernightReductionWindow,
} from "~/strategy/overnight-reduction";
import type { PositionGateSignals } from "~/strategy/position-gate";

// Pin the two env-driven knobs to their documented defaults so the math is
// deterministic regardless of a loaded .env: 6 days to sell-off, 20% start floor.
delete process.env.STRATEGY_OVERNIGHT_REDUCTION_DAYS_TO_SELLOFF;
delete process.env.STRATEGY_OVERNIGHT_REDUCTION_START_FLOOR_PCT;

function signals(overrides: Partial<PositionGateSignals> = {}): PositionGateSignals {
  return {
    crossAccountYes: false,
    basicStockYes: false,
    strongStockYes: false,
    goodBooleanScore: 0,
    allBooleansGood: false,
    ...overrides,
  };
}

test("getAgeBasedFloorPct: day 1 sits at the full start floor", () => {
  assert.equal(getAgeBasedFloorPct(1), 0.2);
});

test("getAgeBasedFloorPct: midpoint age is half the start floor", () => {
  // t = (3.5 - 1) / (6 - 1) = 0.5 → 0.20 * 0.5
  assert.equal(getAgeBasedFloorPct(3.5), 0.1);
});

test("getAgeBasedFloorPct: at/after the sell-off day there is no floor (full close)", () => {
  assert.equal(getAgeBasedFloorPct(6), null);
  assert.equal(getAgeBasedFloorPct(7), null);
});

test("isInOvernightReductionWindow brackets 7:30–11:30", () => {
  assert.equal(isInOvernightReductionWindow(new Date("2026-07-06T07:29:00")), false);
  assert.equal(isInOvernightReductionWindow(new Date("2026-07-06T07:30:00")), true);
  assert.equal(isInOvernightReductionWindow(new Date("2026-07-06T11:29:00")), true);
  assert.equal(isInOvernightReductionWindow(new Date("2026-07-06T11:30:00")), false);
});

test("computeOvernightReductionTargetPct pauses on protective signals", () => {
  const time = new Date("2026-07-06T09:30:00");
  assert.equal(
    computeOvernightReductionTargetPct(time, 0.6, signals({ crossAccountYes: true }), 1),
    null,
  );
  assert.equal(
    computeOvernightReductionTargetPct(time, 0.6, signals({ strongStockYes: true }), 1),
    null,
  );
});

test("computeOvernightReductionTargetPct returns null before the window opens", () => {
  const time = new Date("2026-07-06T07:00:00");
  assert.equal(computeOvernightReductionTargetPct(time, 0.6, signals(), 1), null);
});

test("computeOvernightReductionTargetPct returns null once already at/below the floor", () => {
  // day 1 floor = 0.20; exposure already at 0.15 → nothing to reduce
  const time = new Date("2026-07-06T09:30:00");
  assert.equal(computeOvernightReductionTargetPct(time, 0.15, signals(), 1), null);
});

test("computeOvernightReductionTargetPct interpolates from current exposure toward the floor", () => {
  // 9:30 → t = (570 - 450) / 240 = 0.5, day-1 floor = 0.20, exposure 0.60
  // target = 0.60 * 0.5 + 0.20 * 0.5 = 0.40
  const time = new Date("2026-07-06T09:30:00");
  const target = computeOvernightReductionTargetPct(time, 0.6, signals(), 1);
  assert.equal(target, 0.4);
});

test("computeOvernightReductionTargetPct reaches the floor by the window close", () => {
  // 11:30 → t clamps to 1, day-1 floor 0.20 → target = floor
  const time = new Date("2026-07-06T11:30:00");
  const target = computeOvernightReductionTargetPct(time, 0.6, signals(), 1);
  assert.equal(target, 0.2);
});

test("computeOvernightReductionTargetPct with no registry age drives toward full close", () => {
  // ageDays=null → no floor → effectiveFloor 0; at t=1 the target collapses to 0
  const time = new Date("2026-07-06T11:30:00");
  const target = computeOvernightReductionTargetPct(time, 0.6, signals(), null);
  assert.equal(target, 0);
});
