import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateTradingStrategy,
  getDynamicTakeProfitTarget,
} from "~/strategy/evaluate-trading-strategy";
import {
  computeScaleOutMaxQuantity,
  getScaleOutConfig,
  type ScaleOutContext,
} from "~/strategy/scale-out";
import { localTimeAt, minutesBefore } from "./test-clock";

// At 06:30 the dynamic take-profit target is exactly 0.40, so the runner target
// (×1.5) is 0.60 — convenient fixed anchors for these cases. 06:30 is LOCAL:
// getDynamicTakeProfitTarget blends on getHours()/getMinutes().
function metricsWithReturn(returnPct: number) {
  const currentTime = localTimeAt(6, 30);
  // 11 min ago → past the 10-min cooldown (irrelevant to take-profit/runner
  // branches, which run before cooldown, but keeps the fallthrough clean).
  const lastActionTime = minutesBefore(currentTime, 11);
  return {
    currentBidPrice: 1 + returnPct,
    currentAskPrice: 1 + returnPct,
    weightedAverageFill: 1,
    currentTime,
    lastActionTime,
  };
}

const CTX = (over: Partial<ScaleOutContext>): ScaleOutContext => ({
  enabled: true,
  fraction: 0.5,
  runnerTargetMultiple: 1.5,
  alreadyScaled: false,
  ...over,
});

test("06:30 dynamic target is 0.40 (anchor for these tests)", () => {
  assert.equal(getDynamicTakeProfitTarget(localTimeAt(6, 30)), 0.4);
});

test("scale-out DISABLED → unchanged full close at target (no closeFraction)", () => {
  const result = evaluateTradingStrategy(metricsWithReturn(0.45), "cash");
  assert.equal(result.action, "CLOSE_POSITION");
  assert.equal(result.closeFraction, undefined);
  assert.match(result.reason, /lock in gains/);
});

test("scale-out disabled + below target → MANAGE_ALLOCATION, no suppressAdds", () => {
  const result = evaluateTradingStrategy(metricsWithReturn(0.1), "cash");
  assert.equal(result.action, "MANAGE_ALLOCATION");
  assert.equal(result.suppressAdds, undefined);
});

test("FRESH + enabled: first target trip → partial close (closeFraction = fraction)", () => {
  const result = evaluateTradingStrategy(
    metricsWithReturn(0.45),
    "cash",
    CTX({ alreadyScaled: false }),
  );
  assert.equal(result.action, "CLOSE_POSITION");
  assert.equal(result.closeFraction, 0.5);
  assert.equal(result.isUrgentClose, undefined);
  assert.match(result.reason, /scaling out 50%/);
});

test("FRESH + enabled + below target → MANAGE_ALLOCATION (not scaled, not runner)", () => {
  const result = evaluateTradingStrategy(
    metricsWithReturn(0.1),
    "cash",
    CTX({ alreadyScaled: false }),
  );
  assert.equal(result.action, "MANAGE_ALLOCATION");
  assert.equal(result.suppressAdds, undefined);
});

test("RUNNER: above base target but below runner target → hold + suppressAdds", () => {
  // 0.45 ≥ base 0.40 (would close if fresh) but < runner 0.60 → the runner holds.
  const result = evaluateTradingStrategy(
    metricsWithReturn(0.45),
    "cash",
    CTX({ alreadyScaled: true }),
  );
  assert.equal(result.action, "MANAGE_ALLOCATION");
  assert.equal(result.suppressAdds, true);
});

test("RUNNER: at/above runner target (0.60) → full close of the remainder", () => {
  const result = evaluateTradingStrategy(
    metricsWithReturn(0.65),
    "cash",
    CTX({ alreadyScaled: true }),
  );
  assert.equal(result.action, "CLOSE_POSITION");
  assert.equal(result.closeFraction, undefined);
  assert.match(result.reason, /Runner target/);
});

test("RUNNER: breakeven ratchet (return ≤ 0) → urgent close of the remainder", () => {
  const result = evaluateTradingStrategy(
    metricsWithReturn(-0.05),
    "cash",
    CTX({ alreadyScaled: true }),
  );
  assert.equal(result.action, "CLOSE_POSITION");
  assert.equal(result.isUrgentClose, true);
  assert.match(result.reason, /breakeven/);
});

test("getScaleOutConfig is cash-only and off unless the flag is set", () => {
  const prevFlag = process.env.STRATEGY_PARTIAL_SCALE_OUT_ENABLED;
  const prevFraction = process.env.STRATEGY_SCALE_OUT_FRACTION;
  try {
    delete process.env.STRATEGY_PARTIAL_SCALE_OUT_ENABLED;
    assert.equal(getScaleOutConfig("cash").enabled, false, "off when flag unset");

    process.env.STRATEGY_PARTIAL_SCALE_OUT_ENABLED = "true";
    assert.equal(getScaleOutConfig("cash").enabled, true, "on for cash when set");
    assert.equal(getScaleOutConfig("margin").enabled, false, "never on for margin (v1)");
    assert.equal(getScaleOutConfig("unknown").enabled, false, "never on for unknown");

    process.env.STRATEGY_SCALE_OUT_FRACTION = "60";
    assert.equal(getScaleOutConfig("cash").fraction, 0.6, "percent form parses to fraction");
  } finally {
    if (prevFlag === undefined) delete process.env.STRATEGY_PARTIAL_SCALE_OUT_ENABLED;
    else process.env.STRATEGY_PARTIAL_SCALE_OUT_ENABLED = prevFlag;
    if (prevFraction === undefined) delete process.env.STRATEGY_SCALE_OUT_FRACTION;
    else process.env.STRATEGY_SCALE_OUT_FRACTION = prevFraction;
  }
});

test("computeScaleOutMaxQuantity leaves a remainder (or undefined = full close)", () => {
  // full close cases → undefined
  assert.equal(computeScaleOutMaxQuantity(undefined, 10), undefined, "no fraction");
  assert.equal(computeScaleOutMaxQuantity(1, 10), undefined, "fraction 1 = full close");
  assert.equal(computeScaleOutMaxQuantity(0.5, 1), undefined, "1-lot can't split");
  // partial cases → close floor(qty*fraction), always leaving ≥ 1
  assert.equal(computeScaleOutMaxQuantity(0.5, 2), 1, "2 → close 1, leave 1");
  assert.equal(computeScaleOutMaxQuantity(0.5, 3), 1, "3 → close 1, leave 2");
  assert.equal(computeScaleOutMaxQuantity(0.5, 4), 2, "4 → close 2, leave 2");
  assert.equal(computeScaleOutMaxQuantity(0.9, 2), 1, "high fraction still leaves ≥ 1");
  // never returns ≥ total (would be a full close, not a scale-out)
  for (let q = 2; q <= 20; q++) {
    const closed = computeScaleOutMaxQuantity(0.5, q) as number;
    assert.ok(closed >= 1 && closed < q, `q=${q}: close ${closed} leaves a remainder`);
  }
});
