import test from "node:test";
import assert from "node:assert/strict";

import { computeUnderlyingStabilization } from "../underlying-stabilization";

test("computeUnderlyingStabilization flags a bounce off the recent low", () => {
  // Fell to 90 then recovered to 95 → stabilizing.
  const result = computeUnderlyingStabilization([100, 95, 90, 95]);
  assert.equal(result.sampleCount, 4);
  assert.equal(result.isStabilizing, true);
  assert.ok(result.latestVsRecentLowPct > 0.05);
  assert.ok(Math.abs(result.netChangePct - -0.05) < 1e-9);
});

test("computeUnderlyingStabilization does not flag a series still making new lows", () => {
  const result = computeUnderlyingStabilization([100, 96, 92, 90]);
  assert.equal(result.isStabilizing, false); // latest IS the low
  assert.equal(result.latestVsRecentLowPct, 0);
});

test("computeUnderlyingStabilization needs at least 2 valid samples", () => {
  assert.equal(computeUnderlyingStabilization([]).isStabilizing, false);
  assert.equal(computeUnderlyingStabilization([100]).sampleCount, 1);
  // non-finite / non-positive prices are dropped
  assert.equal(computeUnderlyingStabilization([100, NaN, 0, -5]).sampleCount, 1);
});
