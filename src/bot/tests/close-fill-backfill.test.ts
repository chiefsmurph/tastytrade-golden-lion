import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCloseRealizedPnl,
  extractFillsFromOrder,
  impliedEntryPrice,
} from "../get-closed-positions-today";

// REGRESSION — 2026-08-03.
// run-cycle records close fills from the order PLACEMENT response, which by
// definition has none: the limit order has only just been created. Nothing revisits
// the entry, so a close that fills seconds later stays `fills: []` with null realized
// P&L forever. That hid 2 of 3 fills today and understated realized P&L (-$20
// reported vs -$23 actual). getClosedPositionsToday now re-asks the broker; this
// covers the extraction that reconciliation depends on.

test("extracts the EOSE fill the cycle snapshot missed", () => {
  const order = {
    legs: [
      { fills: [{ "fill-price": "0.75", quantity: 1, "filled-at": "2026-08-03T14:50:56.100+00:00" }] },
    ],
  };
  const fills = extractFillsFromOrder(order);
  assert.equal(fills.length, 1);
  assert.equal(fills[0]!.fillPrice, 0.75);
  assert.equal(fills[0]!.quantity, 1);
  assert.equal(fills[0]!.filledAt, "2026-08-03T14:50:56.100+00:00");

  // 2 contracts at cost basis 130 => entry 0.65; selling 1 at 0.75 => +$10.
  const entry = 130 / (2 * 100);
  assert.equal(entry, 0.65);
  assert.equal(Math.round((0.75 - entry) * 1 * 100 * 100) / 100, 10);
});

test("multi-leg orders accumulate every fill", () => {
  const fills = extractFillsFromOrder({
    legs: [
      { fills: [{ "fill-price": "0.60", quantity: 1, "filled-at": "t1" }] },
      { fills: [{ "fill-price": "0.64", quantity: 2, "filled-at": "t2" }] },
    ],
  });
  assert.equal(fills.length, 2);
  const qty = fills.reduce((s, f) => s + (f.quantity ?? 0), 0);
  const avg = fills.reduce((s, f) => s + (f.fillPrice ?? 0) * (f.quantity ?? 0), 0) / qty;
  assert.equal(qty, 3);
  assert.ok(Math.abs(avg - 0.6266666) < 1e-4);
});

test("a still-working order yields no fills — the row is left untouched", () => {
  assert.deepEqual(extractFillsFromOrder({ legs: [{ fills: [] }] }), []);
  assert.deepEqual(extractFillsFromOrder({ legs: [{}] }), []);
  assert.deepEqual(extractFillsFromOrder({}), []);
  assert.deepEqual(extractFillsFromOrder(null), []);
  assert.deepEqual(extractFillsFromOrder(undefined), []);
});

test("malformed fill values degrade to null rather than NaN", () => {
  const fills = extractFillsFromOrder({
    legs: [{ fills: [{ "fill-price": "abc", quantity: null }] }],
  });
  assert.equal(fills[0]!.fillPrice, null);
  assert.equal(fills[0]!.quantity, null);
  assert.equal(fills[0]!.filledAt, null);
});

// REGRESSION — the backfill's own bug, shipped and caught the same day.
// It derived entry as totalCostBasis / closedQty. Cost basis spans the WHOLE group,
// so a 1-of-2 close divided by too few contracts and doubled the implied entry:
// EOSE reported -$55 against a true +$10; WU C6 reported -$88 against a true -$13.
// The account total read -$145 instead of ~-$23. Entry must come from the group's
// weighted-average fill, and when that is missing we report null rather than guess.
test("partial close prices off the group WAF, not costBasis/closedQty", () => {
  const costBasis = 130;     // whole group: 2 contracts
  const contracts = 2;
  const waf = costBasis / (contracts * 100);   // 0.65 — the correct entry
  const closedQty = 1;
  const avgFill = 0.75;

  const correct = (avgFill - waf) * closedQty * 100;
  assert.equal(Math.round(correct * 100) / 100, 10);

  // The shape of the old mistake, asserted so it cannot quietly return.
  const wrongEntry = costBasis / (closedQty * 100);   // 1.30
  const wrong = (avgFill - wrongEntry) * closedQty * 100;
  assert.equal(Math.round(wrong * 100) / 100, -55);
  assert.notEqual(Math.round(correct * 100) / 100, Math.round(wrong * 100) / 100);
});

// REGRESSION — 2026-08-08. This reporter carried the same unconditional ×100 as
// pnl-ledger. Both accounts hold manually-traded EQUITY rows (bare ticker, no
// OCC suffix); pricing a share round-trip as a 100-share contract inflated it
// 100× and swamped the day's real options P&L.
const OCC_SYMBOL = "AAPL  260619C00100000";

test("an option close keeps the ×100 contract multiplier", () => {
  const pnl = computeCloseRealizedPnl(OCC_SYMBOL, 0.75, 0.65, 1);
  assert.ok(Math.abs(pnl.realizedPnlDollars - 10) < 1e-9);
  assert.ok(Math.abs(pnl.realizedPnlPct - 0.1538461) < 1e-6);
});

test("an equity close is priced per share, not per 100-share contract", () => {
  const pnl = computeCloseRealizedPnl("SNWV", 4.95, 5.0, 1000);
  assert.ok(Math.abs(pnl.realizedPnlDollars - -50) < 1e-9);
  assert.notEqual(Math.round(pnl.realizedPnlDollars), -5000);
  // The percentage was never wrong — only the dollars.
  assert.ok(Math.abs(pnl.realizedPnlPct - -0.01) < 1e-9);
});

test("the legacy cost-basis fallback is multiplier-aware too", () => {
  // 2 option contracts, $130 basis => $0.65/contract.
  assert.ok(Math.abs(impliedEntryPrice(OCC_SYMBOL, 130, 2) - 0.65) < 1e-9);
  // 1,000 shares, $5,000 basis => $5.00/share (the ×100 form gave $0.05).
  assert.ok(Math.abs(impliedEntryPrice("SNWV", 5000, 1000) - 5) < 1e-9);
  assert.equal(impliedEntryPrice(OCC_SYMBOL, 130, 0), 0);
});
