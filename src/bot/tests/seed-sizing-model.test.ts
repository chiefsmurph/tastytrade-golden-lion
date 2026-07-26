import test from "node:test";
import assert from "node:assert/strict";

import {
  computeSeedSizing,
  clampFavorabilityInput,
  getSeedSizingFloorPct,
  getSeedSizingCeilingPct,
  OPTION_CONTRACT_MULTIPLIER,
} from "~/strategy/seed-sizing-model";

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

test("floor/ceiling LIVE defaults are 12% / 35% and env-overridable via SECRET_ prefix", () => {
  withEnv("SECRET_SEED_SIZING_FLOOR_PCT", undefined, () => {
    assert.equal(getSeedSizingFloorPct(), 0.12);
  });
  withEnv("SECRET_SEED_SIZING_CEILING_PCT", undefined, () => {
    assert.equal(getSeedSizingCeilingPct(), 0.35);
  });
  withEnv("SECRET_SEED_SIZING_FLOOR_PCT", "0.10", () => {
    assert.equal(getSeedSizingFloorPct(), 0.1);
  });
  withEnv("SECRET_SEED_SIZING_CEILING_PCT", "0.30", () => {
    assert.equal(getSeedSizingCeilingPct(), 0.3);
  });
});

test("floor/ceiling accept integer-looking percents (12/35) as well as fractions", () => {
  // The server .env writes these as `12`/`35`; readEnvFraction must normalize
  // them to 0.12 / 0.35 rather than the latent 1200%/3500% raw-number bug.
  withEnv("SECRET_SEED_SIZING_FLOOR_PCT", "12", () => {
    assert.equal(getSeedSizingFloorPct(), 0.12);
  });
  withEnv("SECRET_SEED_SIZING_CEILING_PCT", "35", () => {
    assert.equal(getSeedSizingCeilingPct(), 0.35);
  });
});

test("neutral inputs pass through to the ceiling target", () => {
  // Both pluggable inputs default to 1.0 → target sits exactly at the ceiling.
  const result = computeSeedSizing({
    accountNLV: 1650,
    optionPrice: 1.0,
    floorPct: 0.12,
    ceilingPct: 0.25,
  });
  assert.equal(result.modelTargetPct, 0.25);
  assert.equal(result.regimeFavorability, 1);
  assert.equal(result.optionLiquidityQuality, 1);
});

test("floor clamp: inputs that fade below the floor are lifted to the floor", () => {
  // 0.25 × 0.3 × 1.0 = 0.075, below the 0.12 floor → clamped up to 0.12.
  const result = computeSeedSizing({
    accountNLV: 1650,
    optionPrice: 1.0,
    regimeFavorability: 0.3,
    optionLiquidityQuality: 1.0,
    floorPct: 0.12,
    ceilingPct: 0.25,
  });
  assert.equal(result.modelTargetPct, 0.12);
});

test("ceiling clamp: target never exceeds the ceiling even with an inverted band", () => {
  // floor > ceiling would invert the band; ceiling stays the hard upper bound.
  const result = computeSeedSizing({
    accountNLV: 1650,
    optionPrice: 1.0,
    floorPct: 0.4,
    ceilingPct: 0.25,
  });
  // ceiling is raised to meet the floor (0.4) so it stays a valid upper bound,
  // and the target cannot exceed it.
  assert.ok(result.modelTargetPct <= result.ceilingPct);
  assert.equal(result.modelTargetPct, 0.4);
});

test("mid-band: partial fade lands strictly between floor and ceiling", () => {
  // 0.25 × 0.8 × 1.0 = 0.20, inside [0.12, 0.25].
  const result = computeSeedSizing({
    accountNLV: 1650,
    optionPrice: 1.0,
    regimeFavorability: 0.8,
    floorPct: 0.12,
    ceilingPct: 0.25,
  });
  assert.ok(Math.abs(result.modelTargetPct - 0.2) < 1e-9);
});

test("%→contracts conversion floors to whole contracts at the option price", () => {
  // NLV 1650, target 25% = $412.50 notional. At $1.00/contract → $100 each →
  // floor(412.5 / 100) = 4 contracts, consuming $400.
  const result = computeSeedSizing({
    accountNLV: 1650,
    optionPrice: 1.0,
    floorPct: 0.12,
    ceilingPct: 0.25,
  });
  assert.equal(OPTION_CONTRACT_MULTIPLIER, 100);
  assert.equal(result.modelTargetNotional, 412.5);
  assert.equal(result.modelContracts, 4);
  assert.equal(result.modelContractsNotional, 400);
});

test("a $0.98 option on a $1,650 account: 1 accidental contract vs the model's band", () => {
  // The 2026-07-20 SG case: 1 contract × $0.98 × 100 = $98 = 5.9% (an accident
  // of price). The model targets 25% = $412.50 → floor(412.5 / 98) = 4 contracts.
  const result = computeSeedSizing({
    accountNLV: 1650,
    optionPrice: 0.98,
    floorPct: 0.12,
    ceilingPct: 0.25,
  });
  assert.equal(result.modelContracts, 4);
});

test("target notional too small for one contract yields 0 contracts", () => {
  // A $5.00 option → $500/contract; a tiny account can't afford one at 25%.
  const result = computeSeedSizing({
    accountNLV: 1000,
    optionPrice: 5.0,
    floorPct: 0.12,
    ceilingPct: 0.25,
  });
  // 25% of 1000 = 250 < 500 → 0 whole contracts.
  assert.equal(result.modelContracts, 0);
  assert.equal(result.modelContractsNotional, 0);
});

test("degenerate price / NLV inputs collapse to 0 contracts, never NaN", () => {
  assert.equal(computeSeedSizing({ accountNLV: 1650, optionPrice: 0 }).modelContracts, 0);
  assert.equal(computeSeedSizing({ accountNLV: 0, optionPrice: 1 }).modelContracts, 0);
  const negNlv = computeSeedSizing({ accountNLV: -100, optionPrice: 1 });
  assert.equal(negNlv.modelTargetNotional, 0);
  assert.equal(negNlv.modelContracts, 0);
});

test("clampFavorabilityInput: out-of-contract values collapse to neutral 1.0, in-band pass", () => {
  assert.equal(clampFavorabilityInput(undefined), 1);
  assert.equal(clampFavorabilityInput(Number.NaN), 1);
  assert.equal(clampFavorabilityInput(Infinity), 1);
  assert.equal(clampFavorabilityInput(-0.5), 1); // negative → neutral, cannot zero the target
  assert.equal(clampFavorabilityInput(1.5), 1); // > 1 → neutral, cannot inflate past ceiling
  assert.equal(clampFavorabilityInput(0), 0); // a genuine 0 is honored (fades to floor)
  assert.equal(clampFavorabilityInput(0.6), 0.6);
});

test("governorFactor fades the seed toward the floor like any other favorability input", () => {
  // neutral ceiling seed (both fav inputs 1) with an explicit floor/ceiling band
  const full = computeSeedSizing({ accountNLV: 10000, optionPrice: 1, floorPct: 0.12, ceilingPct: 0.35 });
  assert.ok(Math.abs(full.modelTargetPct - 0.35) < 1e-9);
  // a cash-knife governorFactor (0.5) fades the target: 0.35 × 0.5 = 0.175, above the 0.12 floor
  const knifed = computeSeedSizing({ accountNLV: 10000, optionPrice: 1, floorPct: 0.12, ceilingPct: 0.35, governorFactor: 0.5 });
  assert.ok(Math.abs(knifed.modelTargetPct - 0.175) < 1e-9);
  assert.ok(knifed.modelTargetPct < full.modelTargetPct);
  // never below the floor — even a deep factor clamps up to the floor (cash never zeroes)
  const deep = computeSeedSizing({ accountNLV: 10000, optionPrice: 1, floorPct: 0.12, ceilingPct: 0.35, governorFactor: 0.1 });
  assert.ok(Math.abs(deep.modelTargetPct - 0.12) < 1e-9);
  // absent/neutral factor is a no-op
  const neutral = computeSeedSizing({ accountNLV: 10000, optionPrice: 1, floorPct: 0.12, ceilingPct: 0.35, governorFactor: 1 });
  assert.ok(Math.abs(neutral.modelTargetPct - 0.35) < 1e-9);
});
