import test from "node:test";
import assert from "node:assert/strict";

import { computePerLegReturnBreakdown } from "../per-leg-returns";
import type { PositionQuoteSnapshot } from "../evaluate-position";

function snap(
  symbol: string,
  weightedAverageFill: number,
  currentBidPrice: number,
  quantityWeight = 1,
): PositionQuoteSnapshot {
  return {
    currentAskPrice: currentBidPrice,
    currentBidPrice,
    lastActionTime: new Date(),
    position: {
      "account-number": "A",
      "instrument-type": "Option",
      quantity: 1,
      symbol,
    },
    quantityWeight,
    weightedAverageFill,
  } as PositionQuoteSnapshot;
}

test("computePerLegReturnBreakdown splits return by expiration and measures the spread", () => {
  const result = computePerLegReturnBreakdown([
    snap("LCID  260717C00006000", 1.0, 1.2), // July: +20%
    snap("LCID  260815C00006000", 1.0, 0.8), // August: -20%
  ]);

  assert.equal(result.spansMultipleExpirations, true);
  assert.equal(result.legs.length, 2);
  // Sorted by expiration → July leg first.
  assert.ok(Math.abs(result.legs[0].returnPct - 0.2) < 1e-9);
  assert.ok(Math.abs(result.legs[1].returnPct + 0.2) < 1e-9);
  assert.ok(Math.abs(result.returnSpreadPct - 0.4) < 1e-9);
});

test("computePerLegReturnBreakdown aggregates same-expiration legs by quantity weight", () => {
  const result = computePerLegReturnBreakdown([
    snap("LCID  260717C00006000", 1.0, 1.2, 1),
    snap("LCID  260717C00007000", 1.0, 0.8, 1), // same expiration, opposite return
  ]);

  assert.equal(result.spansMultipleExpirations, false);
  assert.equal(result.legs.length, 1);
  // Weighted: cost 2.0, bid 2.0 → 0% blended within the single expiration.
  assert.ok(Math.abs(result.legs[0].returnPct) < 1e-9);
  assert.equal(result.returnSpreadPct, 0);
});
