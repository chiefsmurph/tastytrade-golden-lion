import test from "node:test";
import assert from "node:assert/strict";
import { extractFillsFromOrder } from "../get-closed-positions-today";

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
