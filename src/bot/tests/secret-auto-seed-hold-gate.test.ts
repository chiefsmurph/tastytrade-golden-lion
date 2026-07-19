import test from "node:test";
import assert from "node:assert/strict";

import { isCashSeedBlockedByHoldGate } from "~/strategy/secret/secret-auto-seed";
import type { SecretRegime } from "~/strategy/secret/types";

const calmRegime: SecretRegime = { crashRegime: false };
const crashRegime: SecretRegime = { crashRegime: true };

test("missing or non-numeric holdScore BLOCKS the seed (unlike run-cycle's permissive growth gate)", () => {
  assert.equal(isCashSeedBlockedByHoldGate({}, calmRegime, 0.45), true);
  assert.equal(isCashSeedBlockedByHoldGate({ holdScore: undefined }, calmRegime, 0.45), true);
  // The feed's index signature means junk can ride along — only real numbers pass.
  assert.equal(
    isCashSeedBlockedByHoldGate({ holdScore: "0.6" as unknown as number }, calmRegime, 0.45),
    true,
  );
  assert.equal(isCashSeedBlockedByHoldGate({ holdScore: Number.NaN }, calmRegime, 0.45), true);
});

test("holdScore below the floor blocks; at or above passes", () => {
  assert.equal(isCashSeedBlockedByHoldGate({ holdScore: 0.44 }, calmRegime, 0.45), true);
  assert.equal(isCashSeedBlockedByHoldGate({ holdScore: 0.45 }, calmRegime, 0.45), false);
  assert.equal(isCashSeedBlockedByHoldGate({ holdScore: 1.0 }, calmRegime, 0.45), false);
});

test("isOvernightEligible false blocks; undefined is allowed", () => {
  assert.equal(
    isCashSeedBlockedByHoldGate({ holdScore: 0.6, isOvernightEligible: false }, calmRegime, 0.45),
    true,
  );
  assert.equal(
    isCashSeedBlockedByHoldGate({ holdScore: 0.6, isOvernightEligible: undefined }, calmRegime, 0.45),
    false,
  );
  assert.equal(
    isCashSeedBlockedByHoldGate({ holdScore: 0.6, isOvernightEligible: true }, calmRegime, 0.45),
    false,
  );
});

test("crashRegime blocks; calm, missing-flag, and null regimes pass", () => {
  assert.equal(isCashSeedBlockedByHoldGate({ holdScore: 0.6 }, crashRegime, 0.45), true);
  assert.equal(isCashSeedBlockedByHoldGate({ holdScore: 0.6 }, calmRegime, 0.45), false);
  assert.equal(isCashSeedBlockedByHoldGate({ holdScore: 0.6 }, {}, 0.45), false);
  assert.equal(isCashSeedBlockedByHoldGate({ holdScore: 0.6 }, null, 0.45), false);
});

test("default floor comes from STRATEGY_CASH_SEED_MIN_HOLD_SCORE (0.45 when unset)", () => {
  const original = process.env.STRATEGY_CASH_SEED_MIN_HOLD_SCORE;
  delete process.env.STRATEGY_CASH_SEED_MIN_HOLD_SCORE;
  try {
    assert.equal(isCashSeedBlockedByHoldGate({ holdScore: 0.44 }, calmRegime), true);
    assert.equal(isCashSeedBlockedByHoldGate({ holdScore: 0.45 }, calmRegime), false);

    process.env.STRATEGY_CASH_SEED_MIN_HOLD_SCORE = "0.6";
    assert.equal(isCashSeedBlockedByHoldGate({ holdScore: 0.5 }, calmRegime), true);
  } finally {
    if (original !== undefined) {
      process.env.STRATEGY_CASH_SEED_MIN_HOLD_SCORE = original;
    } else {
      delete process.env.STRATEGY_CASH_SEED_MIN_HOLD_SCORE;
    }
  }
});
