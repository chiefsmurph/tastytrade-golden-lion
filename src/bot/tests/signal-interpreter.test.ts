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

test("computeAggressivenessBoost: daytradeScore tiers", () => {
  assert.equal(computeAggressivenessBoost({ daytradeScore: -250 }), 200);
  assert.equal(computeAggressivenessBoost({ daytradeScore: -150 }), 100);
  assert.equal(computeAggressivenessBoost({ daytradeScore: -50 }), 0);
});

test("computeAggressivenessBoost: returnPerc tiers", () => {
  assert.equal(computeAggressivenessBoost({ returnPerc: -6 }), 200);
  assert.equal(computeAggressivenessBoost({ returnPerc: -3 }), 100);
  assert.equal(computeAggressivenessBoost({ returnPerc: -1 }), 0);
});

test("computeAggressivenessBoost: superRecScore over 80 lifts to level 1", () => {
  assert.equal(computeAggressivenessBoost({ superRecScore: 90 }), 100);
  assert.equal(computeAggressivenessBoost({ superRecScore: 80 }), 0);
});

test("computeAggressivenessBoost takes the max level across signals", () => {
  // daytradeScore is level 1, returnPerc is level 2 → level 2 wins
  assert.equal(
    computeAggressivenessBoost({ daytradeScore: -150, returnPerc: -6 }),
    200,
  );
});

test("computeAggressivenessBoost: no signals → 0", () => {
  assert.equal(computeAggressivenessBoost({}), 0);
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
    { ticker: "RUM", buyWeight: 100, daytradeScore: -250 }, // 100 + 200
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
    { ticker: "RUM", buyWeight: 120, returnPerc: -3 }, // 120 + 100
  ];

  assert.equal(getBuyWeightForSymbol(positions, "rum"), 220);
  assert.equal(getBuyWeightForSymbol(positions, "TSLA"), null);
});
