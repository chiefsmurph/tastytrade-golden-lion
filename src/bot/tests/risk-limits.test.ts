import test from "node:test";
import assert from "node:assert/strict";

import {
  getCashDipTargetBoostMaxSpreadPct,
  getCashDipTargetBoostPct,
  getMarginDipTargetBoostMaxSpreadPct,
  getMarginDipTargetBoostPct,
  isDipBoostSuppressedByWideSpread,
} from "~/strategy/risk-limits";
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

function withSpreadSuppressionEnv<T>(value: string | undefined, fn: () => T): T {
  const key = "STRATEGY_MARGIN_DIP_TARGET_BOOST_MAX_SPREAD_PCT";
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

test("dip boost is off by default", () => {
  withBoostEnv(undefined, () => {
    assert.equal(getMarginDipTargetBoostPct(-0.1, 8), 0);
  });
});

test("cash dip boost is off by default and independent of the margin knob", () => {
  withEnv("STRATEGY_CASH_DIP_TARGET_BOOST_MAX_PCT", undefined, () => {
    // Enabling MARGIN must NOT enable cash — they are separate knobs.
    withBoostEnv("0.25", () => {
      assert.equal(getCashDipTargetBoostPct(-0.1, 8), 0, "margin knob does not enable cash");
    });
  });
  // And enabling cash must not depend on the margin knob being set.
  withBoostEnv(undefined, () => {
    withEnv("STRATEGY_CASH_DIP_TARGET_BOOST_MAX_PCT", "0.25", () => {
      assert.ok(getCashDipTargetBoostPct(-0.1, 8) > 0, "cash knob enables cash on its own");
    });
  });
});

test("cash dip boost mirrors margin: conviction floor, mid-loss scaling, and shared guards", () => {
  withEnv("STRATEGY_CASH_DIP_TARGET_BOOST_MAX_PCT", "0.25", () => {
    // Conviction floor (booleans >= 4).
    assert.equal(getCashDipTargetBoostPct(-0.1, 3), 0);
    assert.ok(getCashDipTargetBoostPct(-0.1, 4) > 0);
    // Scales with MID loss (2%->12% band), capped.
    assert.equal(getCashDipTargetBoostPct(-0.02, 8), 0);
    assert.ok(Math.abs(getCashDipTargetBoostPct(-0.07, 8) - 0.125) < 1e-9);
    assert.equal(getCashDipTargetBoostPct(-0.3, 8), 0.25);
    // Bid-safety gate (shared): bid within 10pts of the 30% stop floor -> no boost.
    assert.equal(getCashDipTargetBoostPct(-0.05, 8, null, -0.21), 0);
    assert.ok(getCashDipTargetBoostPct(-0.07, 8, null, -0.10) > 0);
    // Wide-spread suppression uses the CASH ceiling, not the margin one.
    withEnv("STRATEGY_CASH_DIP_TARGET_BOOST_MAX_SPREAD_PCT", "0.15", () => {
      assert.equal(getCashDipTargetBoostMaxSpreadPct(), 0.15);
      assert.equal(getCashDipTargetBoostPct(-0.07, 6, 0.18), 0, "wide spread suppresses");
      assert.ok(getCashDipTargetBoostPct(-0.07, 6, 0.1) > 0, "tight spread passes");
    });
  });
});

test("dip boost requires good boolean signals", () => {
  withBoostEnv("0.25", () => {
    assert.equal(getMarginDipTargetBoostPct(-0.1, null), 0);
    assert.equal(getMarginDipTargetBoostPct(-0.1, 3), 0);
    assert.ok(getMarginDipTargetBoostPct(-0.1, 4) > 0);
  });
});

test("dip boost scales with MID loss depth between 2% and 12%", () => {
  withBoostEnv("0.25", () => {
    // First arg is the MID return (fair value), not the ask.
    // At cost or shallow losses: no boost.
    assert.equal(getMarginDipTargetBoostPct(0, 8), 0);
    assert.equal(getMarginDipTargetBoostPct(-0.02, 8), 0);
    // Midway (7% mid loss = halfway through the 2%-12% band): half the max.
    const midway = getMarginDipTargetBoostPct(-0.07, 8);
    assert.ok(Math.abs(midway - 0.125) < 1e-9, `expected 0.125, got ${midway}`);
    // At and beyond the deep end: full boost, no runaway scaling.
    assert.equal(getMarginDipTargetBoostPct(-0.12, 8), 0.25);
    assert.equal(getMarginDipTargetBoostPct(-0.3, 8), 0.25);
    // Gains never boost.
    assert.equal(getMarginDipTargetBoostPct(0.1, 8), 0);
  });
});

// The WEN case (2026-07-06): ask stayed +1% to +7% while the bid ran −9% to
// −18%. Under the old ask-based trigger the boost never fired despite a boolean
// score of 6. With the mid-return basis, the mid is deep enough to fire.
test("dip boost now fires when the ask is flat/up but the MID is down (WEN case)", () => {
  withBoostEnv("0.25", () => {
    // ask ≈ +5%, bid ≈ −15% → mid ≈ −5% (down through the 2% floor).
    const askReturn = 0.05;
    const bidReturn = -0.15;
    const midReturn = (askReturn + bidReturn) / 2; // -0.05
    // Old behavior (ask basis) would be 0; new behavior (mid basis) fires.
    assert.equal(getMarginDipTargetBoostPct(askReturn, 6), 0, "ask-basis would not fire");
    assert.ok(
      getMarginDipTargetBoostPct(midReturn, 6) > 0,
      "mid-basis fires on the same position",
    );
  });
});

test("dip boost does NOT fire for a genuinely healthy position (mid up)", () => {
  withBoostEnv("0.25", () => {
    // Both sides up: mid is positive, no dip regardless of a wide-ish spread.
    assert.equal(getMarginDipTargetBoostPct(0.05, 8), 0);
    // Mid barely below cost but inside the 2% deadband: still no boost.
    assert.equal(getMarginDipTargetBoostPct(-0.015, 8), 0);
  });
});

test("wide-spread suppression is off (non-binding) by default", () => {
  // Absent → Infinity (never suppresses).
  withSpreadSuppressionEnv(undefined, () => {
    assert.equal(getMarginDipTargetBoostMaxSpreadPct(), Infinity);
  });
  // Blank env var resolves to the in-code default (off), never NaN.
  withSpreadSuppressionEnv("", () => {
    assert.equal(getMarginDipTargetBoostMaxSpreadPct(), Infinity);
  });
  // Non-positive is treated as unset (off).
  withSpreadSuppressionEnv("-0.1", () => {
    assert.equal(getMarginDipTargetBoostMaxSpreadPct(), Infinity);
  });
  withSpreadSuppressionEnv("0.15", () => {
    assert.equal(getMarginDipTargetBoostMaxSpreadPct(), 0.15);
  });
});

test("with suppression off, a wide spread does not block the boost (only ask→mid changes)", () => {
  withBoostEnv("0.25", () => {
    withSpreadSuppressionEnv(undefined, () => {
      // 18%-wide spread, deep mid dip → still boosts (suppression is off).
      assert.ok(getMarginDipTargetBoostPct(-0.07, 6, 0.18) > 0);
    });
  });
});

test("isDipBoostSuppressedByWideSpread only suppresses a known spread over a set ceiling", () => {
  // Ceiling unset → never suppresses, regardless of spread.
  withSpreadSuppressionEnv(undefined, () => {
    assert.equal(isDipBoostSuppressedByWideSpread(0.5), false);
    assert.equal(isDipBoostSuppressedByWideSpread(null), false);
  });
  withSpreadSuppressionEnv("0.15", () => {
    assert.equal(isDipBoostSuppressedByWideSpread(0.18), true); // over ceiling
    assert.equal(isDipBoostSuppressedByWideSpread(0.15), false); // exactly at ceiling
    assert.equal(isDipBoostSuppressedByWideSpread(0.1), false); // under ceiling
    // Unknown/degenerate spread degrades gracefully (no suppression).
    assert.equal(isDipBoostSuppressedByWideSpread(null), false);
    assert.equal(isDipBoostSuppressedByWideSpread(undefined), false);
    assert.equal(isDipBoostSuppressedByWideSpread(Number.NaN), false);
  });
});

test("with suppression on, a wide-spread position is suppressed but a tight one still boosts", () => {
  withBoostEnv("0.25", () => {
    withSpreadSuppressionEnv("0.15", () => {
      // 18% spread > 15% threshold → suppressed (this is the WEN trap).
      assert.equal(getMarginDipTargetBoostPct(-0.07, 6, 0.18), 0);
      // 10% spread ≤ 15% threshold → the boost still applies.
      assert.ok(getMarginDipTargetBoostPct(-0.07, 6, 0.1) > 0);
      // Unknown/absent spread degrades gracefully: does NOT suppress.
      assert.ok(getMarginDipTargetBoostPct(-0.07, 6, null) > 0);
      assert.ok(getMarginDipTargetBoostPct(-0.07, 6, undefined) > 0);
    });
  });
});

// Bid-safety gate tests (2026-07-07 Issue B, TE margin case).
// Default intraday stop floor is 30% (from STRATEGY_INTRADAY_STOP_LOSS_PCT).
// Safety margin is 10 points → gate threshold is −20% bid return.

test("bid-safety gate suppresses the boost when bid is within 10% of the stop floor", () => {
  withBoostEnv("0.25", () => {
    // mid = −5% (enough to trigger), bid = −21% (past the −20% gate with 30% floor).
    // The TE 2026-07-07 scenario: boost fired, position hit −33% stop an hour later.
    assert.equal(getMarginDipTargetBoostPct(-0.05, 8, null, -0.21), 0);
    // Exactly at the gate boundary (−20%): suppressed.
    assert.equal(getMarginDipTargetBoostPct(-0.05, 8, null, -0.20), 0);
  });
});

test("bid-safety gate allows the boost when bid is well above the stop floor", () => {
  withBoostEnv("0.25", () => {
    // mid = −7%, bid = −10%: bid is only 10% down, well above the −20% gate.
    assert.ok(getMarginDipTargetBoostPct(-0.07, 8, null, -0.10) > 0);
    // mid = −7%, bid = −19%: just inside the safe zone (−19% > −20% threshold).
    assert.ok(getMarginDipTargetBoostPct(-0.07, 8, null, -0.19) > 0);
  });
});

test("bid-safety gate degrades gracefully when bid is absent (null/undefined)", () => {
  withBoostEnv("0.25", () => {
    // No bid data: gate does not suppress (missing quote ≠ danger).
    assert.ok(getMarginDipTargetBoostPct(-0.07, 8, null, null) > 0);
    assert.ok(getMarginDipTargetBoostPct(-0.07, 8, null, undefined) > 0);
    // Old 3-arg call signature (no bid arg): still works, gate skipped.
    assert.ok(getMarginDipTargetBoostPct(-0.07, 8, null) > 0);
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

  // daytradeScore leg removed 2026-07-19 — pain grants nothing at ANY point
  // in the window, even at the once-generous early bar.
  const scorePosition = { ticker: "TEST", daytradeScore: -25 } as never;
  assert.equal(
    computePositionGate({ crossAccountAskReturnFraction: null, secretPosition: scorePosition, currentTime: windowStart }).signals.basicStockYes,
    false,
  );
  assert.equal(
    computePositionGate({ crossAccountAskReturnFraction: null, secretPosition: scorePosition, currentTime: windowEnd }).signals.basicStockYes,
    false,
  );
});
