import test from "node:test";
import assert from "node:assert/strict";

import { getMorningSpreadThresholdPct } from "~/strategy/spread-thresholds";
import { getMaxOptionSpreadPctForTime } from "~/strategy/entry-filters";

function at(time: string): Date {
  return new Date(`2026-06-25T${time}:00`);
}

test("getMorningSpreadThresholdPct ramps from 5% at open to 30% after 8:00", () => {
  assert.equal(getMorningSpreadThresholdPct(at("06:30")), 0.05);
  assert.equal(getMorningSpreadThresholdPct(at("06:44")), 0.05);
  assert.equal(getMorningSpreadThresholdPct(at("06:45")), 0.10);
  assert.equal(getMorningSpreadThresholdPct(at("07:46")), 0.25);
  assert.equal(getMorningSpreadThresholdPct(at("08:00")), 0.30);
  assert.equal(getMorningSpreadThresholdPct(at("12:30")), 0.30);
});

test("getMaxOptionSpreadPctForTime tightens entries during the morning ramp", () => {
  const originalEnv = process.env.STRATEGY_MAX_OPTION_SPREAD_PCT;
  delete process.env.STRATEGY_MAX_OPTION_SPREAD_PCT;

  try {
    assert.equal(getMaxOptionSpreadPctForTime(at("06:30")), 0.05);
    assert.equal(getMaxOptionSpreadPctForTime(at("07:46")), 0.25);
    assert.equal(getMaxOptionSpreadPctForTime(at("10:00")), 0.30);
  } finally {
    if (originalEnv !== undefined) {
      process.env.STRATEGY_MAX_OPTION_SPREAD_PCT = originalEnv;
    }
  }
});

test("getMaxOptionSpreadPctForTime keeps the configured value as the ceiling", () => {
  const originalEnv = process.env.STRATEGY_MAX_OPTION_SPREAD_PCT;
  process.env.STRATEGY_MAX_OPTION_SPREAD_PCT = "0.2";

  try {
    assert.equal(getMaxOptionSpreadPctForTime(at("07:46")), 0.2);
    assert.equal(getMaxOptionSpreadPctForTime(at("10:00")), 0.2);
    assert.equal(getMaxOptionSpreadPctForTime(at("06:30")), 0.05);
  } finally {
    if (originalEnv !== undefined) {
      process.env.STRATEGY_MAX_OPTION_SPREAD_PCT = originalEnv;
    } else {
      delete process.env.STRATEGY_MAX_OPTION_SPREAD_PCT;
    }
  }
});

test("a 28.57% spread at 07:46 is rejected for entry (LCID 2026-07-02 regression)", () => {
  // bid 0.42 / ask 0.56 → spread 0.14 / mid 0.49 = 28.57%; entering here at the
  // ask is born ~4 points from the -30% bid stop loss.
  const spreadPct = (0.56 - 0.42) / ((0.56 + 0.42) / 2);

  const originalEnv = process.env.STRATEGY_MAX_OPTION_SPREAD_PCT;
  delete process.env.STRATEGY_MAX_OPTION_SPREAD_PCT;

  try {
    assert.ok(spreadPct > getMaxOptionSpreadPctForTime(at("07:46")));
  } finally {
    if (originalEnv !== undefined) {
      process.env.STRATEGY_MAX_OPTION_SPREAD_PCT = originalEnv;
    }
  }
});
