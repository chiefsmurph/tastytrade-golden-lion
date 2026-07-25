import test from "node:test";
import assert from "node:assert/strict";
import {
  computePositionGate,
  getBasicYesMaxTargetPct,
  getBothYesMaxTargetPct,
  getCashGovernorFloor,
  getGovernorMult,
  getMarginGovernorMin,
  governorFactorFor,
  governorFactorForEnabled,
  getPlateauGovernorMult,
  getSingleYesMaxTargetPct,
  getStrongYesMaxTargetPct,
  shouldSeedMarginFromBooleans,
} from "~/strategy/position-gate";
import type { SecretSourcePosition } from "~/strategy/secret/types";

const NOON = new Date(2026, 6, 6, 12, 0);
const BOOST = 0.03; // STRATEGY_GATE_BOOLEAN_BOOST_PCT default

function gate(
  secretPosition: Partial<SecretSourcePosition> | undefined,
  crossAccountAskReturnFraction: number | null = null,
) {
  return computePositionGate({
    crossAccountAskReturnFraction,
    secretPosition: secretPosition as SecretSourcePosition | undefined,
    currentTime: NOON,
  });
}

test("no signals and no cross-account confirmation → maxTargetPct 0 (the #1 skip)", () => {
  assert.equal(gate(undefined).maxTargetPct, 0);
  assert.equal(gate({ ticker: "X" }).maxTargetPct, 0);
});

test("basic-only stock yes lands exactly on the basic tier (score comes only from the rollup)", () => {
  const result = gate({ ticker: "X", isQualityToBuy: true });
  assert.equal(result.signals.basicStockYes, true);
  assert.equal(result.signals.strongStockYes, false);
  assert.equal(result.signals.goodBooleanScore, 0);
  assert.ok(Math.abs(result.maxTargetPct - getBasicYesMaxTargetPct()) < 1e-9);
});

test("strong stock yes (isQualityToBuy + high pct) uses the single-yes tier", () => {
  const result = gate({ ticker: "X", isQualityToBuy: true, percentOfBalance: 80 });
  assert.equal(result.signals.strongStockYes, true);
  assert.ok(result.maxTargetPct >= getSingleYesMaxTargetPct());
});

test("cross-account YES alone uses the single-yes tier", () => {
  // fraction below -threshold (noon threshold = base 10% × 1) → crossAccountYes
  const result = gate({ ticker: "X" }, -0.5);
  assert.equal(result.signals.crossAccountYes, true);
  assert.ok(Math.abs(result.maxTargetPct - getSingleYesMaxTargetPct()) < 1e-9);
});

test("cross-account YES + strong stock YES escalates to the strong tier", () => {
  const result = gate({ ticker: "X", isQualityToBuy: true, percentOfBalance: 80 }, -0.5);
  assert.ok(Math.abs(result.maxTargetPct - getStrongYesMaxTargetPct()) < 1e-9);
});

test("cross-account YES + basic stock YES escalates to the both tier", () => {
  const result = gate({ ticker: "X", isQualityToBuy: true }, -0.5);
  assert.equal(result.signals.strongStockYes, false);
  assert.ok(Math.abs(result.maxTargetPct - getBothYesMaxTargetPct()) < 1e-9);
});

test("daytradeScore grants nothing — no basic tier alone, no strong tier with quality", () => {
  // Removed 2026-07-19: dip polarity granted tiers inside the backtested
  // -70..-150 death valley. Pain is telemetry, not a signal.
  const alone = gate({ ticker: "X", daytradeScore: -350 });
  assert.equal(alone.signals.basicStockYes, false);
  assert.equal(alone.signals.strongStockYes, false);
  assert.equal(alone.maxTargetPct, 0);

  const withQuality = gate({ ticker: "X", isQualityToBuy: true, daytradeScore: -350 });
  assert.equal(withQuality.signals.basicStockYes, true); // from isQualityToBuy
  assert.equal(withQuality.signals.strongStockYes, false); // pct leg only now
});

test("each thesis point adds a fixed boost on top of the tier", () => {
  // manual thesis 2/10 → 2 pts; no stock-yes so tier is 0, boost = 2 × 0.03.
  const result = gate({ ticker: "X", manualThesisCount: 2, manualThesisMax: 10 });
  assert.equal(result.signals.goodBooleanScore, 2);
  assert.ok(Math.abs(result.maxTargetPct - 2 * BOOST) < 1e-9);
});

// ── The thesis rollup is the sole score source (2026-07-13) ──────────────────

test("legacy per-flag fields no longer score — no rollup means 0", () => {
  const result = gate({
    ticker: "X",
    isInBssRange: true,
    isAboveMinPsWordPerc: true,
    willBuy: true,
    daytradeScore: -350,
  });
  assert.equal(result.signals.goodBooleanScore, 0);
});

test("manualThesisCount is the score source, raw on the 0–10 scale", () => {
  assert.equal(
    gate({ ticker: "X", manualThesisCount: 10, manualThesisMax: 10 }).signals.goodBooleanScore,
    10,
  );
  assert.equal(
    gate({ ticker: "X", manualThesisCount: 5, manualThesisMax: 10 }).signals.goodBooleanScore,
    5,
  );
  assert.equal(
    gate({ ticker: "X", manualThesisCount: 4, manualThesisMax: 10 }).signals.goodBooleanScore,
    4,
  );
  // willBuy icing (+2) comes from buyFraction > 1
  assert.equal(
    gate({ ticker: "X", manualThesisCount: 10, manualThesisMax: 10, buyFraction: 1.25 })
      .signals.goodBooleanScore,
    12,
  );
});

test("manual thesis supersedes buyFraction for the score when both are present", () => {
  const result = gate({
    ticker: "X",
    manualThesisCount: 3,
    manualThesisMax: 10,
    buyFraction: 1.0,
  });
  assert.equal(result.signals.goodBooleanScore, 3);
});

test("buyFraction alone spreads across the scale (fallback when manual is absent)", () => {
  assert.equal(gate({ ticker: "X", buyFraction: 1.25 }).signals.goodBooleanScore, 12);
  assert.equal(gate({ ticker: "X", buyFraction: 1.0 }).signals.goodBooleanScore, 10);
  assert.equal(gate({ ticker: "X", buyFraction: 0.75 }).signals.goodBooleanScore, 8);
  assert.equal(gate({ ticker: "X", buyFraction: 0.5 }).signals.goodBooleanScore, 5);
  assert.equal(gate({ ticker: "X", buyFraction: 0.25 }).signals.goodBooleanScore, 3);
  assert.equal(gate({ ticker: "X", buyFraction: 0 }).signals.goodBooleanScore, 0);
});

test("invalid manual thesis falls through to buyFraction, then to 0", () => {
  assert.equal(
    gate({ ticker: "X", manualThesisCount: 5, manualThesisMax: 0, buyFraction: 0.75 })
      .signals.goodBooleanScore,
    8,
  );
  assert.equal(
    gate({ ticker: "X", manualThesisCount: Number.NaN, isInBssRange: true })
      .signals.goodBooleanScore,
    0,
  );
});

test("allBooleansGood is buyFraction >= 1.0; no rollup means false", () => {
  assert.equal(gate({ ticker: "X", buyFraction: 1.0 }).signals.allBooleansGood, true);
  assert.equal(gate({ ticker: "X", buyFraction: 0.75 }).signals.allBooleansGood, false);
  assert.equal(gate({ ticker: "X", isInBssRange: true }).signals.allBooleansGood, false);
});

test("margin seeding requires the FULL feed thesis (thesisCount >= thesisMax)", () => {
  const p = (extra: Partial<SecretSourcePosition>) =>
    ({ ticker: "X", ...extra }) as SecretSourcePosition;

  assert.equal(shouldSeedMarginFromBooleans(p({ thesisCount: 4, thesisMax: 4 })), true);
  assert.equal(shouldSeedMarginFromBooleans(p({ thesisCount: 3, thesisMax: 4 })), false);
  // the bar tracks the feed if its flag set grows: 4/5 is no longer everything
  assert.equal(shouldSeedMarginFromBooleans(p({ thesisCount: 4, thesisMax: 5 })), false);
  assert.equal(shouldSeedMarginFromBooleans(p({ thesisCount: 5, thesisMax: 5 })), true);
  // missing/invalid rollup = no seed — unknown thesis is not conviction
  assert.equal(shouldSeedMarginFromBooleans(p({ thesisCount: 4 })), false);
  assert.equal(shouldSeedMarginFromBooleans(p({ isClearedToBuy: true, willBuy: true })), false);
  assert.equal(shouldSeedMarginFromBooleans(undefined), false);
});

// ── Add-governor (dark-launch) ──────────────────────────────────────────────
const P = (extra: Partial<SecretSourcePosition>) => ({ ticker: "X", ...extra }) as SecretSourcePosition;

test("getGovernorMult: prefers the feed's full governorMult over the plateau fallback", () => {
  // feed sent the Alpaca-computed mult → use it verbatim, ignoring plateauScore
  assert.equal(getGovernorMult(P({ governorMult: 0.6, plateauScore: 90 })), 0.6);
  assert.equal(getGovernorMult(P({ governorMult: 1, plateauScore: 5 })), 1);
  // clamps to <= 1 (the governor only ever throttles)
  assert.equal(getGovernorMult(P({ governorMult: 1.4 })), 1);
});

test("getGovernorMult: falls back to the plateau-only ramp when the feed omits governorMult", () => {
  // no governorMult → plateau ramp (knife plateau 5 → floor)
  assert.equal(getGovernorMult(P({ plateauScore: 5 })), getPlateauGovernorMult(P({ plateauScore: 5 })));
  // neither present → never penalize
  assert.equal(getGovernorMult(undefined), 1);
  assert.equal(getGovernorMult(P({})), 1);
  assert.equal(getGovernorMult(P({ governorMult: NaN, plateauScore: 70 })), 1);
});

test("plateau fallback: absent plateauScore never penalizes; knife→floor, based→full", () => {
  const floor = 0.4; // STRATEGY_PLATEAU_GOVERNOR_KNIFE_FLOOR default
  assert.equal(getPlateauGovernorMult(undefined), 1);
  assert.equal(getPlateauGovernorMult(P({ plateauScore: NaN })), 1);
  assert.ok(Math.abs(getPlateauGovernorMult(P({ plateauScore: 10 })) - floor) < 1e-9);
  assert.equal(getPlateauGovernorMult(P({ plateauScore: 65 })), 1);
  const mid = getPlateauGovernorMult(P({ plateauScore: 50 }));
  assert.ok(Math.abs(mid - (floor + (1 - floor) * 0.5)) < 1e-9);
});

test("computePositionGate SURFACES governorMult but never applies it (account-aware downstream)", () => {
  // The gate is shared by both accounts; the governor is applied per-account in
  // run-cycle-context / seed paths, so the raw maxTargetPct must be untouched here.
  const result = gate({ ticker: "X", isQualityToBuy: true, percentOfBalance: 80, governorMult: 0.4 });
  assert.equal(result.governorMult, 0.4); // observed
  assert.ok(result.maxTargetPct >= getSingleYesMaxTargetPct()); // never reduced in the gate
});

test("governorFactorFor: MARGIN hard-blocks below MIN (returns 0), tapers above", () => {
  const min = getMarginGovernorMin(); // 0.6 default
  assert.equal(governorFactorFor(0.4, "margin"), 0); // knife below the line → block
  assert.equal(governorFactorFor(min - 0.001, "margin"), 0);
  assert.equal(governorFactorFor(min, "margin"), min); // at the line → taper (not block)
  assert.equal(governorFactorFor(0.8, "margin"), 0.8);
  assert.equal(governorFactorFor(1, "margin"), 1);
});

test("governorFactorForEnabled: 1 (no-op) when off, account-aware factor when on", () => {
  const prev = process.env.STRATEGY_GOVERNOR_ENABLED;
  try {
    delete process.env.STRATEGY_GOVERNOR_ENABLED;
    assert.equal(governorFactorForEnabled(0.4, "margin"), 1); // off → no-op
    assert.equal(governorFactorForEnabled(0.4, "cash"), 1);
    process.env.STRATEGY_GOVERNOR_ENABLED = "true";
    assert.equal(governorFactorForEnabled(0.4, "margin"), 0); // on → margin hard-block
    assert.equal(governorFactorForEnabled(0.1, "cash"), getCashGovernorFloor()); // on → cash floor
  } finally {
    if (prev === undefined) delete process.env.STRATEGY_GOVERNOR_ENABLED;
    else process.env.STRATEGY_GOVERNOR_ENABLED = prev;
  }
});

test("governorFactorFor: CASH soft-floors (never blocks)", () => {
  const floor = getCashGovernorFloor(); // 0.35 default
  assert.equal(governorFactorFor(0.1, "cash"), floor); // deep knife still buys a probe, never 0
  assert.equal(governorFactorFor(0, "cash"), floor);
  assert.equal(governorFactorFor(0.5, "cash"), 0.5); // above the floor → passes through
  assert.equal(governorFactorFor(1, "cash"), 1);
  // cash is strictly freer than margin on the same knife
  assert.ok(governorFactorFor(0.4, "cash") > governorFactorFor(0.4, "margin"));
});
