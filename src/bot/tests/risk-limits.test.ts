import test from "node:test";
import assert from "node:assert/strict";

import { getMarginDipTargetBoostPct } from "~/strategy/risk-limits";

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
