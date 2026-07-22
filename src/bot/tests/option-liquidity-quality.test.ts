import test from "node:test";
import assert from "node:assert/strict";

import {
  computeOptionLiquidityQuality,
  evaluateConcentrationCaps,
  getCombinedUnderlyingCapPct,
  getMaxUnderlyingAccountPct,
  getMinLiquidityCapMultiplier,
  getPerUnderlyingCapPctForQuality,
  summarizeChainStructure,
} from "~/strategy/option-liquidity-quality";
import type { TastytradeExpiration } from "~/core/types";

// The dev .env can leak into tests through the import chain, so every test that
// depends on a cap env var pins it and restores after.
function setEnv(entries: Iterable<[string, string | undefined]>): void {
  for (const [key, value] of entries) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = Object.keys(vars).map(
    (key) => [key, process.env[key]] as [string, string | undefined],
  );
  setEnv(Object.entries(vars));
  try {
    return await fn();
  } finally {
    setEnv(previous);
  }
}

const CAP_ENV_UNSET: Record<string, string | undefined> = {
  STRATEGY_MAX_UNDERLYING_ACCOUNT_PCT: undefined,
  STRATEGY_MIN_LIQUIDITY_CAP_MULTIPLIER: undefined,
  STRATEGY_COMBINED_UNDERLYING_CAP_PCT: undefined,
};

function exp(dte: number, type = "Weekly"): TastytradeExpiration {
  return {
    "expiration-type": type,
    "expiration-date": "2026-08-01",
    "days-to-expiration": dte,
    "settlement-type": "PM",
    strikes: [],
  };
}

// SG-like: weeklies at 3/10/17/24 -> in-window weeklies present.
const SG_WEEKLIES: TastytradeExpiration[] = [exp(3), exp(10), exp(17), exp(24), exp(45, "Regular")];
// XXI-like monthly-only: nearest expiration is 31 DTE.
const XXI_MONTHLY_ONLY: TastytradeExpiration[] = [exp(31, "Regular"), exp(59, "Regular")];

// ---------------------------------------------------------------------------
// Chain structure classification
// ---------------------------------------------------------------------------

test("summarizeChainStructure: SG weeklies are in-window, not monthly-only", () => {
  const s = summarizeChainStructure(SG_WEEKLIES);
  assert.equal(s.hasWeekliesInWindow, true);
  assert.equal(s.monthlyOnly, false);
  assert.equal(s.firstExpirationDte, 3);
  assert.ok(s.weeklyWindowCount >= 2, "expected multiple in-window expirations");
});

test("summarizeChainStructure: XXI first exp 31 DTE is monthly-only, no window weeklies", () => {
  const s = summarizeChainStructure(XXI_MONTHLY_ONLY);
  assert.equal(s.hasWeekliesInWindow, false);
  assert.equal(s.monthlyOnly, true);
  assert.equal(s.firstExpirationDte, 31);
});

test("summarizeChainStructure: empty chain is worst-case (no ladder)", () => {
  const s = summarizeChainStructure([]);
  assert.equal(s.hasWeekliesInWindow, false);
  assert.equal(s.monthlyOnly, true);
  assert.equal(Number.isFinite(s.firstExpirationDte), false);
});

// ---------------------------------------------------------------------------
// optionLiquidityQuality score
// ---------------------------------------------------------------------------

test("quality: SG weeklies + tight spread + deep OI scores high", () => {
  const r = computeOptionLiquidityQuality({
    expirations: SG_WEEKLIES,
    spreadPct: 0.03,
    openInterest: 2000,
  });
  assert.equal(r.weekliesSubScore, 1);
  assert.equal(r.spreadSubScore, 1);
  assert.equal(r.oiSubScore, 1);
  assert.equal(r.score, 1);
});

test("quality: XXI monthly-only + wide spread + thin OI scores near zero", () => {
  const r = computeOptionLiquidityQuality({
    expirations: XXI_MONTHLY_ONLY,
    spreadPct: 0.35,
    openInterest: 10,
  });
  assert.equal(r.weekliesSubScore, 0);
  assert.equal(r.spreadSubScore, 0);
  assert.equal(r.oiSubScore, 0);
  assert.equal(r.score, 0);
});

test("quality: weekly beats monthly-only when spread/OI are equal", () => {
  const common = { spreadPct: 0.1, openInterest: 300 };
  const weekly = computeOptionLiquidityQuality({ expirations: SG_WEEKLIES, ...common });
  const monthly = computeOptionLiquidityQuality({ expirations: XXI_MONTHLY_ONLY, ...common });
  assert.ok(weekly.score > monthly.score, "weekly chain must score higher than monthly-only");
});

test("quality: tight spread beats wide spread on the same chain", () => {
  const tight = computeOptionLiquidityQuality({
    expirations: SG_WEEKLIES,
    spreadPct: 0.02,
    openInterest: 500,
  });
  const wide = computeOptionLiquidityQuality({
    expirations: SG_WEEKLIES,
    spreadPct: 0.28,
    openInterest: 500,
  });
  assert.ok(tight.score > wide.score, "tight spread must score higher than wide spread");
});

test("quality: unknown spread/OI degrade to neutral, not zero", () => {
  const r = computeOptionLiquidityQuality({
    expirations: SG_WEEKLIES,
    spreadPct: null,
    openInterest: null,
  });
  assert.equal(r.spreadSubScore, 0.5);
  assert.equal(r.oiSubScore, 0.5);
  assert.ok(r.missingFields.includes("spreadPct"));
  assert.ok(r.missingFields.includes("openInterest"));
  // weeklies (1) dominates so an SG name with an unknown quote stays clearly liquid.
  assert.ok(r.score > 0.5);
});

test("quality: score is clamped to [0,1]", () => {
  const r = computeOptionLiquidityQuality({
    expirations: SG_WEEKLIES,
    spreadPct: 0,
    openInterest: 1e9,
  });
  assert.ok(r.score >= 0 && r.score <= 1);
});

// ---------------------------------------------------------------------------
// Concentration cap getters
// ---------------------------------------------------------------------------

test("cap getters: off (Infinity) unless set to a positive value", async () => {
  for (const raw of [undefined, "", "   ", "0", "-5", "garbage"]) {
    await withEnv(
      { ...CAP_ENV_UNSET, STRATEGY_MAX_UNDERLYING_ACCOUNT_PCT: raw },
      () => {
        assert.equal(getMaxUnderlyingAccountPct(), Number.POSITIVE_INFINITY);
      },
    );
    await withEnv(
      { ...CAP_ENV_UNSET, STRATEGY_COMBINED_UNDERLYING_CAP_PCT: raw },
      () => {
        assert.equal(getCombinedUnderlyingCapPct(), Number.POSITIVE_INFINITY);
      },
    );
  }
});

test("min-liquidity-cap-multiplier defaults to 0.4 and clamps to [0,1]", async () => {
  await withEnv({ ...CAP_ENV_UNSET }, () => {
    assert.equal(getMinLiquidityCapMultiplier(), 0.4);
  });
  await withEnv({ STRATEGY_MIN_LIQUIDITY_CAP_MULTIPLIER: "2" }, () => {
    assert.equal(getMinLiquidityCapMultiplier(), 1);
  });
  await withEnv({ STRATEGY_MIN_LIQUIDITY_CAP_MULTIPLIER: "-1" }, () => {
    assert.equal(getMinLiquidityCapMultiplier(), 0.4);
  });
});

// ---------------------------------------------------------------------------
// Per-underlying quality-scaled cap
// ---------------------------------------------------------------------------

test("thin name is capped LOWER than a liquid name (same base cap)", async () => {
  await withEnv(
    {
      ...CAP_ENV_UNSET,
      STRATEGY_MAX_UNDERLYING_ACCOUNT_PCT: "0.1",
      STRATEGY_MIN_LIQUIDITY_CAP_MULTIPLIER: "0.4",
    },
    () => {
      const liquidCap = getPerUnderlyingCapPctForQuality(1);
      const thinCap = getPerUnderlyingCapPctForQuality(0);
      // Full-quality name gets the full 10%; a thin name only 0.4 * 10% = 4%.
      assert.ok(Math.abs(liquidCap - 0.1) < 1e-9);
      assert.ok(Math.abs(thinCap - 0.04) < 1e-9);
      assert.ok(thinCap < liquidCap);
    },
  );
});

test("per-underlying cap is Infinity (off) when base cap unset regardless of quality", async () => {
  await withEnv({ ...CAP_ENV_UNSET }, () => {
    assert.equal(getPerUnderlyingCapPctForQuality(0), Number.POSITIVE_INFINITY);
    assert.equal(getPerUnderlyingCapPctForQuality(1), Number.POSITIVE_INFINITY);
  });
});

// ---------------------------------------------------------------------------
// Combined cross-account cap enforcement
// ---------------------------------------------------------------------------

test("combined cross-account cap binds when both accounts stack into one name", async () => {
  await withEnv(
    {
      ...CAP_ENV_UNSET,
      // Per-account cap is generous (20%), combined cap is the binding one (10%).
      STRATEGY_MAX_UNDERLYING_ACCOUNT_PCT: "0.2",
      STRATEGY_MIN_LIQUIDITY_CAP_MULTIPLIER: "1",
      STRATEGY_COMBINED_UNDERLYING_CAP_PCT: "0.1",
    },
    () => {
      const r = evaluateConcentrationCaps({
        quality: 1,
        accountBasis: 100_000,
        // This account holds $8k; the OTHER account already holds another $8k,
        // so combined is $16k against a $10k combined cap.
        existingAccountExposure: 8_000,
        existingCombinedExposure: 16_000,
      });
      // Per-account headroom: 20% of 100k - 8k = 12k. Combined: 10k - 16k -> 0.
      assert.equal(r.perUnderlyingHeadroom, 12_000);
      assert.equal(r.combinedHeadroom, 0);
      assert.equal(r.allowedAdditionalExposure, 0);
      assert.equal(r.bindingCap, "combined");
    },
  );
});

test("per-underlying cap binds for a thin name before the combined cap does", async () => {
  await withEnv(
    {
      ...CAP_ENV_UNSET,
      STRATEGY_MAX_UNDERLYING_ACCOUNT_PCT: "0.1",
      STRATEGY_MIN_LIQUIDITY_CAP_MULTIPLIER: "0.4",
      STRATEGY_COMBINED_UNDERLYING_CAP_PCT: "0.5",
    },
    () => {
      const r = evaluateConcentrationCaps({
        quality: 0, // thin monthly -> 4% cap = $4k on a $100k basis
        accountBasis: 100_000,
        existingAccountExposure: 3_000,
        existingCombinedExposure: 3_000,
      });
      assert.ok(Math.abs(r.perUnderlyingCapDollars - 4_000) < 1e-6);
      assert.ok(Math.abs(r.perUnderlyingHeadroom - 1_000) < 1e-6); // 4k - 3k
      assert.ok(Math.abs(r.allowedAdditionalExposure - 1_000) < 1e-6);
      assert.equal(r.bindingCap, "per-underlying");
    },
  );
});

test("both caps off -> unbounded additional exposure", async () => {
  await withEnv({ ...CAP_ENV_UNSET }, () => {
    const r = evaluateConcentrationCaps({
      quality: 0.5,
      accountBasis: 100_000,
      existingAccountExposure: 50_000,
      existingCombinedExposure: 90_000,
    });
    assert.equal(r.allowedAdditionalExposure, Number.POSITIVE_INFINITY);
    assert.equal(r.bindingCap, "none");
  });
});
