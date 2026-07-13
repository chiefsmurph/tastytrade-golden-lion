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

test("basic-only stock yes lands on the basic tier (plus boolean boost)", () => {
  // isQualityToBuy makes basicStockYes true AND adds 1pt to the score → +1 boost on top of tier.
  const result = gate({ ticker: "X", isQualityToBuy: true });
  assert.equal(result.signals.basicStockYes, true);
  assert.equal(result.signals.strongStockYes, false);
  assert.equal(result.signals.goodBooleanScore, 1);
  assert.ok(Math.abs(result.maxTargetPct - (getBasicYesMaxTargetPct() + BOOST)) < 1e-9);
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
  // isQualityToBuy adds 1pt to score → +BOOST on top of the strong tier.
  const result = gate({ ticker: "X", isQualityToBuy: true, percentOfBalance: 80 }, -0.5);
  assert.ok(Math.abs(result.maxTargetPct - (getStrongYesMaxTargetPct() + BOOST)) < 1e-9);
});

test("cross-account YES + basic stock YES escalates to the both tier", () => {
  // isQualityToBuy adds 1pt to score → +BOOST on top of the both tier.
  const result = gate({ ticker: "X", isQualityToBuy: true }, -0.5);
  assert.equal(result.signals.strongStockYes, false);
  assert.ok(Math.abs(result.maxTargetPct - (getBothYesMaxTargetPct() + BOOST)) < 1e-9);
});

test("each good boolean adds a fixed boost on top of the tier", () => {
  // willBuy = 2 points; base has no stock-yes so tier is 0, boost = 2 × 0.03.
  const result = gate({ ticker: "X", willBuy: true });
  assert.equal(result.signals.goodBooleanScore, 2);
  assert.ok(Math.abs(result.maxTargetPct - 2 * BOOST) < 1e-9);
});

test("isBuyEligible=false suppresses willBuy contribution so liquidation doesn't crater score", () => {
  // With isBuyEligible absent: willBuy counts normally (2pts).
  const withoutFlag = gate({ ticker: "X", willBuy: true });
  assert.equal(withoutFlag.signals.goodBooleanScore, 2);

  // With isBuyEligible=false: willBuy is skipped entirely (0pts), score stays from health booleans only.
  const liquidating = gate({ ticker: "X", willBuy: true, isBuyEligible: false });
  assert.equal(liquidating.signals.goodBooleanScore, 0);

  // Health booleans still score normally even when isBuyEligible=false.
  const healthyWhileLiquidating = gate({
    ticker: "X",
    willBuy: true,
    isBuyEligible: false,
    isAboveMinSin: true,
    isAboveMinSis: true,
  });
  assert.equal(healthyWhileLiquidating.signals.goodBooleanScore, 2);
});

test("daytrade points cap at 2", () => {
  const result = gate({ ticker: "X", daytradeScore: -350 });
  assert.equal(result.signals.goodBooleanScore, 2);
});

test("new thesis flags isInBssRange and isAboveMinPsWordPerc each score 1pt", () => {
  const result = gate({ ticker: "X", isInBssRange: true, isAboveMinPsWordPerc: true });
  assert.equal(result.signals.goodBooleanScore, 2);
});

test("isQualityToBuy scores 1pt regardless of isBuyEligible state", () => {
  const eligible = gate({ ticker: "X", isQualityToBuy: true, isBuyEligible: true });
  assert.equal(eligible.signals.goodBooleanScore, 1);

  const liquidating = gate({ ticker: "X", isQualityToBuy: true, isBuyEligible: false });
  assert.equal(liquidating.signals.goodBooleanScore, 1);
});

// ── Feed-consolidated thesis (buyFraction / thesisCount, 2026-07-12) ─────────
// When present these supersede the legacy per-flag count; rescaled onto the
// 0–THESIS_MAX(+2) point scale so every downstream bar stays unchanged.

test("buyFraction maps onto the legacy point scale at the endpoints", () => {
  // full thesis (no willBuy) → THESIS_MAX (11)
  assert.equal(gate({ ticker: "X", buyFraction: 1.0 }).signals.goodBooleanScore, 11);
  // full thesis + willBuy icing → THESIS_MAX + 2 (13)
  assert.equal(gate({ ticker: "X", buyFraction: 1.25 }).signals.goodBooleanScore, 13);
  // zero
  assert.equal(gate({ ticker: "X", buyFraction: 0 }).signals.goodBooleanScore, 0);
});

test("buyFraction quarter steps land where the legacy bars expect", () => {
  // 3/4 feed flags → 8 pts (passes deep-loss ≥6 and multiplier ≥7)
  assert.equal(gate({ ticker: "X", buyFraction: 0.75 }).signals.goodBooleanScore, 8);
  // 2/4 feed flags → 6 pts (deep-loss just passes; dip boost ≥4 passes)
  assert.equal(gate({ ticker: "X", buyFraction: 0.5 }).signals.goodBooleanScore, 6);
  // 1/4 feed flags → 3 pts (multiplier ≥3 tier; dip boost ≥4 fails)
  assert.equal(gate({ ticker: "X", buyFraction: 0.25 }).signals.goodBooleanScore, 3);
});

test("buyFraction supersedes legacy flags when both are present", () => {
  // Legacy flags say 2 pts; feed rollup says full thesis — feed wins.
  const result = gate({
    ticker: "X",
    buyFraction: 1.0,
    isInBssRange: true,
    isAboveMinPsWordPerc: true,
  });
  assert.equal(result.signals.goodBooleanScore, 11);
});

test("legacy per-flag path still works when buyFraction is absent", () => {
  const result = gate({ ticker: "X", isInBssRange: true, isAboveMinPsWordPerc: true });
  assert.equal(result.signals.goodBooleanScore, 2);
});

test("allBooleansGood follows buyFraction >= 1.0 when present, legacy flags otherwise", () => {
  assert.equal(gate({ ticker: "X", buyFraction: 1.0 }).signals.allBooleansGood, true);
  assert.equal(gate({ ticker: "X", buyFraction: 0.75 }).signals.allBooleansGood, false);
  // absent buyFraction → legacy every-flag check (2 of 9 → false)
  assert.equal(
    gate({ ticker: "X", isInBssRange: true, isAboveMinPsWordPerc: true }).signals.allBooleansGood,
    false,
  );
});

test("margin seeding uses feed thesisCount >= 4 when present, legacy merged count otherwise", () => {
  const p = (extra: Partial<SecretSourcePosition>) =>
    ({ ticker: "X", ...extra }) as SecretSourcePosition;

  assert.equal(shouldSeedMarginFromBooleans(p({ thesisCount: 4 })), true);
  assert.equal(shouldSeedMarginFromBooleans(p({ thesisCount: 3 })), false);
  // thesisCount absent -> legacy merged path (4 legacy signals = 4 merged points)
  assert.equal(
    shouldSeedMarginFromBooleans(
      p({ isQualityToBuy: true, isAboveMinSin: true, isAboveMinStab: true, isClearedToBuy: true }),
    ),
    true,
  );
  assert.equal(shouldSeedMarginFromBooleans(undefined), false);
});
