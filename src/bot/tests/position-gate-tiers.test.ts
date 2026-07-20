import test from "node:test";
import assert from "node:assert/strict";
import {
  computePositionGate,
  getBasicYesMaxTargetPct,
  getBothYesMaxTargetPct,
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
