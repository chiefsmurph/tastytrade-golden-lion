import test from "node:test";
import assert from "node:assert/strict";
import {
  computePositionGate,
  getBasicYesMaxTargetPct,
  getBothYesMaxTargetPct,
  getSingleYesMaxTargetPct,
  getStrongYesMaxTargetPct,
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

test("basic-only stock yes lands on the basic tier (plus boolean boost)", () => {
  // qualityToBuy makes basicStockYes true; no booleans set → score contributes qualityToBuy? no,
  // qualityToBuy isn't a counted boolean, so score 0, boost 0.
  const result = gate({ ticker: "X", qualityToBuy: true });
  assert.equal(result.signals.basicStockYes, true);
  assert.equal(result.signals.strongStockYes, false);
  assert.ok(Math.abs(result.maxTargetPct - getBasicYesMaxTargetPct()) < 1e-9);
});

test("strong stock yes (qualityToBuy + high pct) uses the single-yes tier", () => {
  const result = gate({ ticker: "X", qualityToBuy: true, percentOfBalance: 80 });
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
  const result = gate({ ticker: "X", qualityToBuy: true, percentOfBalance: 80 }, -0.5);
  assert.equal(result.maxTargetPct, getStrongYesMaxTargetPct());
});

test("cross-account YES + basic stock YES escalates to the both tier", () => {
  const result = gate({ ticker: "X", qualityToBuy: true }, -0.5);
  assert.equal(result.signals.strongStockYes, false);
  assert.equal(result.maxTargetPct, getBothYesMaxTargetPct());
});

test("each good boolean adds a fixed boost on top of the tier", () => {
  // willBuy = 2 points; base has no stock-yes so tier is 0, boost = 2 × 0.03.
  const result = gate({ ticker: "X", willBuy: true });
  assert.equal(result.signals.goodBooleanScore, 2);
  assert.ok(Math.abs(result.maxTargetPct - 2 * BOOST) < 1e-9);
});
