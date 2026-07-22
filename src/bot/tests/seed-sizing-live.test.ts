import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveSeedQuantity,
  getMarginMaxTotalUtilization,
  DEFAULT_MARGIN_MAX_TOTAL_UTILIZATION,
} from "~/strategy/seed-sizing-live";

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// Snapshot + restore env so tests can't leak into each other.
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous = Object.fromEntries(
    Object.keys(vars).map((key) => [key, process.env[key]]),
  );
  setEnv(vars);
  try {
    return fn();
  } finally {
    setEnv(previous);
  }
}

// A generous baseline: caps + margin rail effectively off. No dollar clip knob
// exists any more — size is governed entirely by percentages. Overridden
// per-test where a rail is being exercised.
const BASE = {
  accountNLV: 1650,
  optionPrice: 0.98,
  accountType: "cash" as const,
  concentrationBasis: 1650,
  existingAccountExposure: 0,
  existingCombinedExposure: 0,
  marginTotalOptionExposure: 0,
};

const CAPS_OFF = {
  STRATEGY_MAX_UNDERLYING_ACCOUNT_PCT: undefined,
  STRATEGY_COMBINED_UNDERLYING_CAP_PCT: undefined,
  STRATEGY_MARGIN_MAX_TOTAL_UTILIZATION: undefined,
  SECRET_SEED_SIZING_FLOOR_PCT: undefined,
  SECRET_SEED_SIZING_CEILING_PCT: undefined,
};

// ---------------------------------------------------------------------------
// Env knobs (percent / multiple only — no dollar knobs)
// ---------------------------------------------------------------------------

test("getMarginMaxTotalUtilization defaults to 1.5 (rail ON) and refuses to be disabled", () => {
  withEnv({ STRATEGY_MARGIN_MAX_TOTAL_UTILIZATION: undefined }, () => {
    assert.equal(getMarginMaxTotalUtilization(), DEFAULT_MARGIN_MAX_TOTAL_UTILIZATION);
    assert.equal(getMarginMaxTotalUtilization(), 1.5);
  });
  withEnv({ STRATEGY_MARGIN_MAX_TOTAL_UTILIZATION: "2" }, () => {
    assert.equal(getMarginMaxTotalUtilization(), 2);
  });
  // A leverage MULTIPLE, read raw — 1.5 is NOT normalized as a percent.
  withEnv({ STRATEGY_MARGIN_MAX_TOTAL_UTILIZATION: "1.5" }, () => {
    assert.equal(getMarginMaxTotalUtilization(), 1.5);
  });
  // Non-positive / garbage can't disable the safety rail.
  withEnv({ STRATEGY_MARGIN_MAX_TOTAL_UTILIZATION: "0" }, () => {
    assert.equal(getMarginMaxTotalUtilization(), 1.5);
  });
});

// ---------------------------------------------------------------------------
// model → quantity conversion
// ---------------------------------------------------------------------------

test("model drives the real quantity: SG @ $0.98 on $1,650, liquid → 35% → 5 contracts", () => {
  withEnv({ ...CAPS_OFF }, () => {
    const result = resolveSeedQuantity({
      ...BASE,
      optionLiquidityQuality: 1.0, // liquid SG weekly → ceiling
    });
    // 35% of 1650 = 577.50 notional; $0.98 × 100 = $98/contract →
    // floor(577.5 / 98) = 5 contracts, consuming $490.
    assert.equal(result.modelTargetPct, 0.35);
    assert.equal(result.modelContracts, 5);
    assert.equal(result.quantity, 5);
    assert.equal(result.bindingRail, "model");
    assert.equal(result.flooredToOne, false);
    assert.equal(result.orderCost, 490);
  });
});

test("liquidity fade: thin monthly (quality 0) fades to the 12% floor", () => {
  withEnv({ ...CAPS_OFF }, () => {
    const liquid = resolveSeedQuantity({ ...BASE, optionLiquidityQuality: 1.0 });
    const thin = resolveSeedQuantity({ ...BASE, optionLiquidityQuality: 0.0 });
    // Liquid sits at the 35% ceiling; thin fades to the 12% floor.
    assert.equal(liquid.modelTargetPct, 0.35);
    assert.equal(thin.modelTargetPct, 0.12);
    // 12% of 1650 = 198; floor(198 / 98) = 2 contracts.
    assert.equal(thin.quantity, 2);
    assert.ok(thin.quantity < liquid.quantity, "thin must size smaller than liquid");
  });
});

// ---------------------------------------------------------------------------
// min-1 anti-regression floor
// ---------------------------------------------------------------------------

test("min-1 floor: a pricey option the band can't afford still places 1 contract", () => {
  withEnv({ ...CAPS_OFF }, () => {
    // $5.00 option → $500/contract; 35% of 1650 = 577.5 → floor(577.5/500)=1.
    // Use a smaller NLV so the model floors to 0 to prove the anti-regression.
    const result = resolveSeedQuantity({
      ...BASE,
      accountNLV: 1000,
      concentrationBasis: 1000,
      optionPrice: 5.0,
      optionLiquidityQuality: 1.0,
    });
    // 35% of 1000 = 350 < 500 → model 0 contracts, floored up to 1.
    assert.equal(result.modelContracts, 0);
    assert.equal(result.quantity, 1);
    assert.equal(result.flooredToOne, true);
  });
});

test("min-1 floor does NOT lift when a hard rail (per-underlying cap) can't afford one", () => {
  withEnv(
    { ...CAPS_OFF, STRATEGY_MAX_UNDERLYING_ACCOUNT_PCT: "0.1" },
    () => {
      // $5.00 option = $500/contract; 10% per-underlying cap on $1650 = $165 →
      // the cap can't afford even one contract, so the anti-regression floor
      // must NOT lift the seed to 1 (a hard cap breach means "do not add").
      const result = resolveSeedQuantity({
        ...BASE,
        optionPrice: 5.0,
        optionLiquidityQuality: 1.0,
      });
      assert.equal(result.quantity, 0);
      assert.equal(result.bindingRail, "blocked");
      assert.ok((result.blockedReason ?? "").includes("per-underlying"));
    },
  );
});

// ---------------------------------------------------------------------------
// concentration cap clamps
// ---------------------------------------------------------------------------

test("per-underlying cap clamps the model quantity down", () => {
  withEnv(
    {
      ...CAPS_OFF,
      // 10% per-underlying cap; top-quality multiplier = 1 → 10% of 1650 = $165.
      STRATEGY_MAX_UNDERLYING_ACCOUNT_PCT: "0.1",
    },
    () => {
      const result = resolveSeedQuantity({
        ...BASE,
        optionLiquidityQuality: 1.0,
      });
      // Cap headroom $165 / $98 = floor 1 contract, below the model's 5.
      assert.equal(result.modelContracts, 5);
      assert.equal(result.quantity, 1);
      assert.equal(result.bindingRail, "per-underlying-cap");
    },
  );
});

test("combined cross-account cap clamps below the per-underlying cap", () => {
  withEnv(
    {
      ...CAPS_OFF,
      STRATEGY_MAX_UNDERLYING_ACCOUNT_PCT: "0.5", // 50% → $825 room
      STRATEGY_COMBINED_UNDERLYING_CAP_PCT: "0.2", // 20% → $330 combined
    },
    () => {
      const result = resolveSeedQuantity({
        ...BASE,
        optionLiquidityQuality: 1.0,
        existingCombinedExposure: 200, // $330 - $200 = $130 room → 1 contract
      });
      assert.equal(result.quantity, 1);
      assert.equal(result.bindingRail, "combined-cap");
    },
  );
});

test("per-underlying cap already breached blocks the seed entirely (0 contracts)", () => {
  withEnv(
    { ...CAPS_OFF, STRATEGY_MAX_UNDERLYING_ACCOUNT_PCT: "0.1" },
    () => {
      const result = resolveSeedQuantity({
        ...BASE,
        optionLiquidityQuality: 1.0,
        existingAccountExposure: 200, // already over the $165 cap → 0 room
      });
      assert.equal(result.quantity, 0);
      assert.equal(result.bindingRail, "blocked");
      assert.ok((result.blockedReason ?? "").includes("per-underlying"));
    },
  );
});

// ---------------------------------------------------------------------------
// total-margin-utilization ceiling
// ---------------------------------------------------------------------------

test("total-margin ceiling blocks when open margin exposure already exceeds 1.5x NLV", () => {
  withEnv({ ...CAPS_OFF }, () => {
    const result = resolveSeedQuantity({
      ...BASE,
      accountType: "margin",
      marginTotalOptionExposure: 2600, // 1.5 × 1650 = 2475 ceiling, already over
      optionLiquidityQuality: 1.0,
    });
    assert.equal(result.quantity, 0);
    assert.equal(result.bindingRail, "blocked");
    assert.ok((result.blockedReason ?? "").includes("margin-utilization"));
  });
});

test("total-margin ceiling clamps (not blocks) when partial headroom remains", () => {
  withEnv({ ...CAPS_OFF }, () => {
    const result = resolveSeedQuantity({
      ...BASE,
      accountType: "margin",
      // ceiling 2475; already 2377 used → $98 headroom → exactly 1 contract.
      marginTotalOptionExposure: 2377,
      optionLiquidityQuality: 1.0,
    });
    assert.equal(result.quantity, 1);
    assert.equal(result.bindingRail, "margin-utilization");
  });
});

test("margin ceiling does NOT apply to the cash account (cash is unlevered)", () => {
  withEnv({ ...CAPS_OFF }, () => {
    const cash = resolveSeedQuantity({
      ...BASE,
      accountType: "cash",
      // A huge 'margin' exposure is irrelevant on a cash seed.
      marginTotalOptionExposure: 99999,
      optionLiquidityQuality: 1.0,
    });
    assert.equal(cash.marginUtilizationContracts, Number.POSITIVE_INFINITY);
    assert.equal(cash.quantity, 5); // unaffected by the margin rail
  });
});

// ---------------------------------------------------------------------------
// same band for both accounts
// ---------------------------------------------------------------------------

test("margin and cash use the SAME sizing band (only the leverage rail differs)", () => {
  withEnv({ ...CAPS_OFF }, () => {
    const cash = resolveSeedQuantity({ ...BASE, accountType: "cash", optionLiquidityQuality: 1.0 });
    const margin = resolveSeedQuantity({
      ...BASE,
      accountType: "margin",
      optionLiquidityQuality: 1.0,
      // margin exposure well under the 2475 ceiling → rail not binding
      marginTotalOptionExposure: 0,
    });
    // Identical band → identical model target and (rail non-binding) quantity.
    assert.equal(margin.modelTargetPct, cash.modelTargetPct);
    assert.equal(margin.quantity, cash.quantity);
  });
});
