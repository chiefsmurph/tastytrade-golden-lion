import test from "node:test";
import assert from "node:assert/strict";

import { getSeedDecision } from "~/strategy/seed-decision";
import type { SecretSourcePosition } from "~/strategy/secret/types";

// Window 8–20% → midpoint 14: loss 10 = early zone, loss 15 = deep zone.
const THRESHOLDS = { minDownPct: 8, maxDownPct: 20 };

function position(extra: Partial<SecretSourcePosition>): SecretSourcePosition {
  return { ticker: "X", ...extra } as SecretSourcePosition;
}

// Both conviction sources are consulted at every depth: the automated feed
// thesis at full marks OR the manual-thesis score over a depth-scaled bar.

test("early zone: full automated thesis seeds even with a low manual score", async () => {
  const decision = await getSeedDecision(
    "X",
    10,
    2, // manual score well below the bar
    position({ thesisCount: 4, thesisMax: 4 }),
    THRESHOLDS,
  );
  assert.equal(decision.shouldSeed, true);
  assert.match(decision.reason, /feed thesis FULL/);
});

test("early zone: manual score ≥ 4 seeds even with a partial automated thesis", async () => {
  const decision = await getSeedDecision(
    "X",
    10,
    4,
    position({ thesisCount: 2, thesisMax: 4 }),
    THRESHOLDS,
  );
  assert.equal(decision.shouldSeed, true);
  assert.match(decision.reason, /manual score 4\/10 vs ≥4/);
});

test("early zone: neither source sufficient → skip", async () => {
  const decision = await getSeedDecision(
    "X",
    10,
    3,
    position({ thesisCount: 3, thesisMax: 4 }),
    THRESHOLDS,
  );
  assert.equal(decision.shouldSeed, false);
});

test("deep zone: the manual bar rises to 6", async () => {
  const seeds = await getSeedDecision("X", 15, 6, position({ thesisCount: 1, thesisMax: 4 }), THRESHOLDS);
  assert.equal(seeds.shouldSeed, true);

  const skips = await getSeedDecision("X", 15, 5, position({ thesisCount: 3, thesisMax: 4 }), THRESHOLDS);
  assert.equal(skips.shouldSeed, false);
  assert.match(skips.reason, /deep-loss/);
});

test("deep zone: full automated thesis seeds even when the manual score is low", async () => {
  const decision = await getSeedDecision(
    "X",
    15,
    2,
    position({ thesisCount: 4, thesisMax: 4 }),
    THRESHOLDS,
  );
  assert.equal(decision.shouldSeed, true);
});

test("getBooleanSeedMultiplier tiers: <3 neutral, 3+ 0.95x, 5+ 0.85x, 7+ 0.7x, null neutral", async () => {
  const { getBooleanSeedMultiplier } = await import("~/strategy/seed-decision");
  assert.equal(getBooleanSeedMultiplier(null), 1.0);
  assert.equal(getBooleanSeedMultiplier(2), 1.0);
  assert.equal(getBooleanSeedMultiplier(3), 0.95);
  assert.equal(getBooleanSeedMultiplier(5), 0.85);
  assert.equal(getBooleanSeedMultiplier(7), 0.7);
  assert.equal(getBooleanSeedMultiplier(12), 0.7);
});
