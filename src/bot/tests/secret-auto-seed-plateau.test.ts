import test from "node:test";
import assert from "node:assert/strict";

import { isMarginSeedBlockedByPlateau } from "~/strategy/secret/secret-auto-seed";

test("blocks margin seeds when plateauScore is numeric and below the floor", () => {
  assert.equal(isMarginSeedBlockedByPlateau({ plateauScore: 20 }, 35), true);
  assert.equal(isMarginSeedBlockedByPlateau({ plateauScore: 0 }, 35), true);
  assert.equal(isMarginSeedBlockedByPlateau({ plateauScore: 34.9 }, 35), true);
});

test("allows margin seeds at or above the floor", () => {
  assert.equal(isMarginSeedBlockedByPlateau({ plateauScore: 35 }, 35), false);
  assert.equal(isMarginSeedBlockedByPlateau({ plateauScore: 100 }, 35), false);
});

test("missing or non-numeric plateauScore never blocks", () => {
  assert.equal(isMarginSeedBlockedByPlateau({}, 35), false);
  assert.equal(isMarginSeedBlockedByPlateau({ plateauScore: undefined }, 35), false);
  // The feed's index signature means junk can ride along — only real numbers gate.
  assert.equal(
    isMarginSeedBlockedByPlateau({ plateauScore: "20" as unknown as number }, 35),
    false,
  );
  // NaN < threshold is false, so NaN passes through as "unknown".
  assert.equal(isMarginSeedBlockedByPlateau({ plateauScore: Number.NaN }, 35), false);
});

test("default floor comes from SECRET_SEED_MIN_PLATEAU (35 when unset)", () => {
  const original = process.env.SECRET_SEED_MIN_PLATEAU;
  delete process.env.SECRET_SEED_MIN_PLATEAU;
  try {
    assert.equal(isMarginSeedBlockedByPlateau({ plateauScore: 34 }), true);
    assert.equal(isMarginSeedBlockedByPlateau({ plateauScore: 36 }), false);

    process.env.SECRET_SEED_MIN_PLATEAU = "50";
    assert.equal(isMarginSeedBlockedByPlateau({ plateauScore: 40 }), true);
  } finally {
    if (original !== undefined) {
      process.env.SECRET_SEED_MIN_PLATEAU = original;
    } else {
      delete process.env.SECRET_SEED_MIN_PLATEAU;
    }
  }
});
