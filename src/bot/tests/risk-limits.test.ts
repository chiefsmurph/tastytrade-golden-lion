import test from "node:test";
import assert from "node:assert/strict";

import { getMarginDipTargetBoostPct } from "~/strategy/risk-limits";
import { getPositionFillSeedMultiplier, getScaledThresholds } from "~/strategy/seed-decision";
import { computePositionGate } from "~/strategy/position-gate";
import { getMaxAllocationBuyPositionMultiple } from "~/bot/actions/manage-allocation";

function withBoostEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.STRATEGY_MARGIN_DIP_TARGET_BOOST_MAX_PCT;
  if (value === undefined) {
    delete process.env.STRATEGY_MARGIN_DIP_TARGET_BOOST_MAX_PCT;
  } else {
    process.env.STRATEGY_MARGIN_DIP_TARGET_BOOST_MAX_PCT = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.STRATEGY_MARGIN_DIP_TARGET_BOOST_MAX_PCT;
    } else {
      process.env.STRATEGY_MARGIN_DIP_TARGET_BOOST_MAX_PCT = previous;
    }
  }
}

test("dip boost is off by default", () => {
  withBoostEnv(undefined, () => {
    assert.equal(getMarginDipTargetBoostPct(-0.1, 8), 0);
  });
});

test("dip boost requires good boolean signals", () => {
  withBoostEnv("0.25", () => {
    assert.equal(getMarginDipTargetBoostPct(-0.1, null), 0);
    assert.equal(getMarginDipTargetBoostPct(-0.1, 3), 0);
    assert.ok(getMarginDipTargetBoostPct(-0.1, 4) > 0);
  });
});

test("dip boost scales with loss depth between 2% and 12%", () => {
  withBoostEnv("0.25", () => {
    // At cost or shallow losses: no boost.
    assert.equal(getMarginDipTargetBoostPct(0, 8), 0);
    assert.equal(getMarginDipTargetBoostPct(-0.02, 8), 0);
    // Midway (7% loss = halfway through the 2%-12% band): half the max.
    const midway = getMarginDipTargetBoostPct(-0.07, 8);
    assert.ok(Math.abs(midway - 0.125) < 1e-9, `expected 0.125, got ${midway}`);
    // At and beyond the deep end: full boost, no runaway scaling.
    assert.equal(getMarginDipTargetBoostPct(-0.12, 8), 0.25);
    assert.equal(getMarginDipTargetBoostPct(-0.3, 8), 0.25);
    // Gains never boost.
    assert.equal(getMarginDipTargetBoostPct(0.1, 8), 0);
  });
});

test("max allocation buy position multiple is off unless set", () => {
  const key = "STRATEGY_MAX_ALLOCATION_BUY_POSITION_MULTIPLE";
  const previous = process.env[key];
  try {
    delete process.env[key];
    assert.equal(getMaxAllocationBuyPositionMultiple(), Infinity);
    process.env[key] = "2.5";
    assert.equal(getMaxAllocationBuyPositionMultiple(), 2.5);
    process.env[key] = "-5";
    assert.equal(getMaxAllocationBuyPositionMultiple(), Infinity);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("position-fill seed multiplier scales from conservative to aggressive", () => {
  // No data: neutral.
  assert.equal(getPositionFillSeedMultiplier(null), 1.0);
  // Barely deployed vs target: cash holds back.
  assert.equal(getPositionFillSeedMultiplier(0), 1.5);
  // Halfway to target: midpoint.
  assert.ok(Math.abs(getPositionFillSeedMultiplier(0.5) - 1.1) < 1e-9);
  // At or beyond target: margin fully committed, cash acts sooner.
  assert.ok(Math.abs(getPositionFillSeedMultiplier(1) - 0.7) < 1e-9);
  assert.ok(Math.abs(getPositionFillSeedMultiplier(2) - 0.7) < 1e-9);
});

test("getScaledThresholds never inverts the seed window under stacked conservative multipliers", () => {
  const config = { minDownPct: 8, maxDownPct: 20 };
  // ~3.4× combined (early + brand-new + margin barely deployed): raw min would
  // be 27 > capped max 20 — the old code emptied the window silently.
  const scaled = getScaledThresholds(config, 1.5, 1.5, 1.0, 1.5);
  assert.ok(scaled.minDownPct < scaled.maxDownPct, "window must stay valid (min < max)");
  assert.ok(scaled.maxDownPct <= config.maxDownPct, "max never exceeds the configured cap");
  assert.ok(scaled.maxDownPct - scaled.minDownPct >= 0.009, "leaves at least the epsilon band");
});

test("getScaledThresholds keeps a normal window when multipliers are moderate", () => {
  const config = { minDownPct: 8, maxDownPct: 20 };
  const scaled = getScaledThresholds(config, 1.0, 1.0, 1.0, 1.0);
  assert.equal(scaled.minDownPct, 8);
  assert.equal(scaled.maxDownPct, 20);
});

test("basic stock-yes thresholds scale across the gate window", () => {
  const windowStart = new Date(2026, 6, 6, 6, 30);
  const windowEnd = new Date(2026, 6, 6, 13, 0);

  // percentOfBalance 15 vs base 25: beats the early bar (12.5), not the late bar (25).
  const pctPosition = { ticker: "TEST", percentOfBalance: 15 } as never;
  assert.equal(
    computePositionGate({ crossAccountAskReturnFraction: null, secretPosition: pctPosition, currentTime: windowStart }).signals.basicStockYes,
    true,
  );
  assert.equal(
    computePositionGate({ crossAccountAskReturnFraction: null, secretPosition: pctPosition, currentTime: windowEnd }).signals.basicStockYes,
    false,
  );

  // daytradeScore -25 vs base -40: beats the relaxed early bar (-20), misses the strict late bar (-40).
  const scorePosition = { ticker: "TEST", daytradeScore: -25 } as never;
  assert.equal(
    computePositionGate({ crossAccountAskReturnFraction: null, secretPosition: scorePosition, currentTime: windowStart }).signals.basicStockYes,
    true,
  );
  assert.equal(
    computePositionGate({ crossAccountAskReturnFraction: null, secretPosition: scorePosition, currentTime: windowEnd }).signals.basicStockYes,
    false,
  );
});
