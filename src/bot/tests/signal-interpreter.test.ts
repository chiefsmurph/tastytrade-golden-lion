import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeBuyWeight,
  computeAggressivenessBoost,
  toSecretExecutionTargets,
  getBuyWeightsFromPositions,
  getBuyWeightForSymbol,
} from "~/strategy/signal-interpreter";
import type { ExecutionTargets } from "~/strategy/evaluate-trading-strategy";
import type { SecretSourcePosition } from "~/strategy/secret/types";

const baseTargets: ExecutionTargets = {
  targetDTE: 14,
  targetAccountExposure: 0.4,
  askWeight: 0.2,
  bidWeight: 0.3,
  midWeight: 0.5,
};

test("normalizeBuyWeight maps the 0..400 scale into 0..1", () => {
  assert.equal(normalizeBuyWeight(0), 0);
  assert.equal(normalizeBuyWeight(200), 0.5);
  assert.equal(normalizeBuyWeight(400), 1);
});

test("normalizeBuyWeight clamps out-of-range inputs", () => {
  assert.equal(normalizeBuyWeight(800), 1);
  assert.equal(normalizeBuyWeight(-100), 0);
});

test("computeAggressivenessBoost: buyFraction tiers (backtested 2026-07-19)", () => {
  // > 1.0 = full thesis + willBuy icing — the best backtested bucket.
  assert.equal(computeAggressivenessBoost({ buyFraction: 1.25 }), 200);
  // exactly 1.0 = full thesis alone.
  assert.equal(computeAggressivenessBoost({ buyFraction: 1.0 }), 100);
  assert.equal(computeAggressivenessBoost({ buyFraction: 0.75 }), 0);
  assert.equal(computeAggressivenessBoost({ buyFraction: 0 }), 0);
});

test("computeAggressivenessBoost: the dropped pain signals no longer boost", () => {
  // daytradeScore/returnPerc/superRecScore granted boosts inside the
  // backtested death valley — now telemetry-only.
  assert.equal(
    computeAggressivenessBoost({ daytradeScore: -250, returnPerc: -6, superRecScore: 90 }),
    0,
  );
});

test("computeAggressivenessBoost: missing or non-finite buyFraction → 0", () => {
  assert.equal(computeAggressivenessBoost({}), 0);
  assert.equal(computeAggressivenessBoost({ buyFraction: Number.NaN }), 0);
});

test("toSecretExecutionTargets: zero buy weight yields the conservative baseline", () => {
  const result = toSecretExecutionTargets(0, baseTargets);
  assert.equal(result.targetDTE, 14);
  assert.equal(result.targetAccountExposure, 0.4);
  assert.equal(result.askWeight, 0.2);
  assert.equal(result.midWeight, 0.55);
  assert.equal(result.bidWeight, 0.25);
  // Route weights always sum to 1
  assert.equal(
    result.askWeight + result.midWeight + result.bidWeight,
    1,
  );
});

test("toSecretExecutionTargets: full buy weight leans exposure and ask up", () => {
  const result = toSecretExecutionTargets(400, baseTargets);
  assert.equal(result.targetAccountExposure, 0.95);
  assert.equal(result.askWeight, 0.8);
  assert.equal(result.bidWeight, 0);
  assert.equal(result.midWeight, 0.2);
  assert.equal(
    result.askWeight + result.midWeight + result.bidWeight,
    1,
  );
});

test("toSecretExecutionTargets: mid buy weight interpolates and still sums to 1", () => {
  const result = toSecretExecutionTargets(200, baseTargets);
  assert.equal(result.targetAccountExposure, 0.68);
  assert.equal(result.askWeight, 0.5);
  assert.equal(result.midWeight, 0.45);
  assert.equal(result.bidWeight, 0.05);
  assert.equal(
    result.askWeight + result.midWeight + result.bidWeight,
    1,
  );
});

test("getBuyWeightsFromPositions adds the aggressiveness boost to matching tickers", () => {
  const positions: SecretSourcePosition[] = [
    { ticker: "RUM", buyWeight: 100, buyFraction: 1.25 }, // 100 + 200
    { ticker: "TSLA", buyWeight: 50 }, // 50 + 0
    { ticker: "NVDA", buyWeight: 300 }, // filtered out (not requested)
  ];

  const weights = getBuyWeightsFromPositions(positions, ["RUM", "TSLA"]);
  assert.deepEqual(weights, [300, 50]);
});

test("getBuyWeightsFromPositions drops non-finite buy weights", () => {
  const positions: SecretSourcePosition[] = [
    { ticker: "RUM", buyWeight: Number.NaN },
    { ticker: "TSLA", buyWeight: 80 },
  ];

  assert.deepEqual(getBuyWeightsFromPositions(positions, ["RUM", "TSLA"]), [80]);
});

test("getBuyWeightForSymbol returns weight+boost, or null when absent", () => {
  const positions: SecretSourcePosition[] = [
    { ticker: "RUM", buyWeight: 120, buyFraction: 1.0 }, // 120 + 100
  ];

  assert.equal(getBuyWeightForSymbol(positions, "rum"), 220);
  assert.equal(getBuyWeightForSymbol(positions, "TSLA"), null);
});
