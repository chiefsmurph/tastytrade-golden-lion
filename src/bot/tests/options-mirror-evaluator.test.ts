import test from "node:test";
import assert from "node:assert/strict";

import { evaluateCashOpt, evaluateMarginOpt, logOptionsMirrorEval } from "~/strategy/secret/options-mirror-evaluator";
import type { SecretRegime, SecretSourcePosition } from "~/strategy/secret/types";

function pos(extra: Partial<SecretSourcePosition>): SecretSourcePosition {
  return { ticker: "TST", ...extra };
}

function regime(extra: Partial<SecretRegime> = {}): SecretRegime {
  return { min: 120, scannedTotalZ: 1.0, crashRegime: false, currentMinBuyWeight: 100, ...extra };
}

// ── MARGIN ────────────────────────────────────────────────────────────────────

test("margin: willBuy=false fails gate", () => {
  const r = evaluateMarginOpt(pos({ willBuy: false }), regime());
  assert.equal(r.gatePass, false);
  assert.match(r.gateFailReason!, /willBuy/);
  assert.equal(r.wouldBuy, false);
});

test("margin: min ≥ 300 fails gate", () => {
  const r = evaluateMarginOpt(pos({ willBuy: true, rangePos: 30, daytradeScore: 50 }), regime({ min: 300 }));
  assert.equal(r.gatePass, false);
  assert.match(r.gateFailReason!, /min=300/);
});

test("margin: rangePos > 65 fails gate", () => {
  const r = evaluateMarginOpt(pos({ willBuy: true, rangePos: 70, daytradeScore: 50 }), regime());
  assert.equal(r.gatePass, false);
  assert.match(r.gateFailReason!, /rangePos/);
});

test("margin: daytradeScore ≤ -150 fails gate", () => {
  const r = evaluateMarginOpt(pos({ willBuy: true, rangePos: 30, daytradeScore: -150 }), regime());
  assert.equal(r.gatePass, false);
  assert.match(r.gateFailReason!, /daytradeScore/);
});

test("margin: all gates pass → score computed, would-buy when ≥ 0.45", () => {
  const r = evaluateMarginOpt(
    pos({
      willBuy: true,
      rangePos: 20,
      daytradeScore: 200,
      buyWeight: 250,
      tsc: 3,
      fiveMinuteRSI: 55,
      minOld: 10,
      currentPrice: 5.0,
      trueHigh: 6.0,
    }),
    regime({ min: 60, currentMinBuyWeight: 100 }),
  );
  assert.equal(r.gatePass, true);
  assert.ok(r.score !== null && r.score >= 0 && r.score <= 1);
  assert.ok(r.components !== null);
});

test("margin: OTM strike capped at trueHigh", () => {
  const r = evaluateMarginOpt(
    pos({ willBuy: true, rangePos: 10, daytradeScore: 50, currentPrice: 10.0, trueHigh: 10.5 }),
    regime(),
  );
  assert.equal(r.gatePass, true);
  assert.ok(r.strikeOtm !== null && r.strikeOtm <= 10.5);
});

test("margin: missing currentPrice → strikeOtm null", () => {
  const r = evaluateMarginOpt(
    pos({ willBuy: true, rangePos: 10, daytradeScore: 50 }),
    regime(),
  );
  assert.equal(r.strikeOtm, null);
});

test("margin: null regime → missing bwExcess and time gate skipped", () => {
  const r = evaluateMarginOpt(
    pos({ willBuy: true, rangePos: 30, daytradeScore: 50 }),
    null,
  );
  assert.equal(r.gatePass, true);
  assert.equal(r.components?.bwExcess, 0);
});

// ── CASH ──────────────────────────────────────────────────────────────────────

test("cash: holdScore null fails gate", () => {
  const r = evaluateCashOpt(pos({ isOvernightEligible: true }), regime());
  assert.equal(r.gatePass, false);
  assert.match(r.gateFailReason!, /holdScore=null/);
});

test("cash: holdScore < 0.45 fails gate", () => {
  const r = evaluateCashOpt(pos({ holdScore: 0.3, isOvernightEligible: true }), regime());
  assert.equal(r.gatePass, false);
  assert.match(r.gateFailReason!, /holdScore=0\.3 \(<0\.45\)/);
});

test("cash: !isOvernightEligible fails gate", () => {
  const r = evaluateCashOpt(pos({ holdScore: 0.6, isOvernightEligible: false }), regime());
  assert.equal(r.gatePass, false);
  assert.match(r.gateFailReason!, /!isOvernightEligible/);
});

test("cash: crashRegime fails gate", () => {
  const r = evaluateCashOpt(
    pos({ holdScore: 0.6, isOvernightEligible: true, manualThesisCount: 3 }),
    regime({ crashRegime: true }),
  );
  assert.equal(r.gatePass, false);
  assert.match(r.gateFailReason!, /crashRegime/);
});

test("cash: thesis soft floor: manualThesisCount ≥ 2 satisfies it", () => {
  const r = evaluateCashOpt(
    pos({ holdScore: 0.6, isOvernightEligible: true, manualThesisCount: 2, rangePos: 30 }),
    regime(),
  );
  assert.equal(r.gatePass, true);
});

test("cash: thesis soft floor: buyFraction ≥ 0.6 satisfies it", () => {
  const r = evaluateCashOpt(
    pos({ holdScore: 0.6, isOvernightEligible: true, buyFraction: 0.6, rangePos: 30 }),
    regime(),
  );
  assert.equal(r.gatePass, true);
});

test("cash: thesis soft floor both null → gate fail", () => {
  const r = evaluateCashOpt(
    pos({ holdScore: 0.6, isOvernightEligible: true }),
    regime(),
  );
  assert.equal(r.gatePass, false);
  assert.match(r.gateFailReason!, /thesis soft floor/);
});

test("cash: failsDayHighGate blocks entry", () => {
  const r = evaluateCashOpt(
    pos({ holdScore: 0.6, isOvernightEligible: true, manualThesisCount: 3, failsDayHighGate: true }),
    regime(),
  );
  assert.equal(r.gatePass, false);
  assert.match(r.gateFailReason!, /failsDayHighGate/);
});

test("cash: rangePos > 55 fails gate", () => {
  const r = evaluateCashOpt(
    pos({ holdScore: 0.6, isOvernightEligible: true, manualThesisCount: 3, rangePos: 60 }),
    regime(),
  );
  assert.equal(r.gatePass, false);
  assert.match(r.gateFailReason!, /rangePos=60/);
});

test("cash: all gates pass → score computed", () => {
  const r = evaluateCashOpt(
    pos({
      holdScore: 0.65,
      isOvernightEligible: true,
      manualThesisCount: 5,
      buyFraction: 0.8,
      rangePos: 25,
      bounceStabilizationScore: 42,
      currentPrice: 4.0,
      trueLow: 3.5,
    }),
    regime({ scannedTotalZ: 1.5 }),
  );
  assert.equal(r.gatePass, true);
  assert.ok(r.score !== null && r.score >= 0 && r.score <= 1);
  assert.ok(r.components !== null);
});

test("cash: ITM strike floored at trueLow", () => {
  const r = evaluateCashOpt(
    pos({
      holdScore: 0.7,
      isOvernightEligible: true,
      manualThesisCount: 4,
      rangePos: 20,
      currentPrice: 5.0,
      trueLow: 4.95,
    }),
    regime(),
  );
  assert.ok(r.strikeItm !== null && r.strikeItm >= 4.95);
});

test("cash: would-buy true when score ≥ 0.55", () => {
  const r = evaluateCashOpt(
    pos({
      holdScore: 0.80,
      isOvernightEligible: true,
      manualThesisCount: 8,
      buyFraction: 1.0,
      rangePos: 5,
      bounceStabilizationScore: 55,
    }),
    regime({ scannedTotalZ: 2.5 }),
  );
  assert.ok(r.score !== null && r.score >= 0.55);
  assert.equal(r.wouldBuy, true);
});

// ── LOG ───────────────────────────────────────────────────────────────────────

test("logOptionsMirrorEval: does not throw on empty positions", () => {
  assert.doesNotThrow(() => logOptionsMirrorEval([], null));
});

test("logOptionsMirrorEval: does not throw on mixed positions", () => {
  const positions: SecretSourcePosition[] = [
    pos({ willBuy: false }),
    pos({ holdScore: 0.7, isOvernightEligible: true, manualThesisCount: 3, rangePos: 20 }),
  ];
  assert.doesNotThrow(() => logOptionsMirrorEval(positions, regime()));
});
