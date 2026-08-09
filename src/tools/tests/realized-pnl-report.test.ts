import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRealizedPnlReport,
  classifyLegKind,
  formatRealizedPnlReport,
  normalizeOptionRoot,
  type LedgerRow,
} from "../realized-pnl-report";

// REGRESSION — 2026-08-08. The realized-P&L tool understated realized loss by
// roughly 3× over 2026-07-17→08-07. Two independent analyses nearly shipped the
// wrong conclusion off it. Causes, each covered below:
//   1. expired-worthless contracts never matched a close and were dropped
//   2. `value` (pre-commission) was used instead of `net-value`
// Plus two shapes hit in practice: an OCC root rename mid-position, and manual
// equity round-trips sitting in the same ledger.

/** Nullable-number reads, kept out of the test bodies so each stays branchless. */
const num = (value: number | null | undefined): number => value ?? 0;
const near = (actual: number, expected: number, epsilon = 1e-9): boolean =>
  Math.abs(actual - expected) < epsilon;

const OPEN_ROW: LedgerRow = {
  symbol: "AAPL  260619C00100000",
  "underlying-symbol": "AAPL",
  "instrument-type": "Equity Option",
  "transaction-type": "Trade",
  "transaction-sub-type": "Buy to Open",
  action: "Buy to Open",
  quantity: 2,
  price: 1.0,
  value: 200,
  "value-effect": "Debit",
  "net-value": 202,
  "net-value-effect": "Debit",
  "executed-at": "2026-07-20T14:30:00Z",
};

const CLOSE_ROW: LedgerRow = {
  symbol: "AAPL  260619C00100000",
  "underlying-symbol": "AAPL",
  "instrument-type": "Equity Option",
  "transaction-type": "Trade",
  "transaction-sub-type": "Sell to Close",
  action: "Sell to Close",
  quantity: 2,
  price: 1.2,
  value: 240,
  "value-effect": "Credit",
  "net-value": 239.76,
  "net-value-effect": "Credit",
  "executed-at": "2026-07-22T16:30:00Z",
};

// ── Defect 1a: expirations ──────────────────────────────────────────────────
// Arrives as Receive Deliver / Expiration with no `action` and no matching
// Sell-to-Close. The old filter+matcher left the open leg dangling in the FIFO
// map and printed nothing at all, so a −100% outcome simply vanished.
const EXPIRATION_ROW: LedgerRow = {
  symbol: "WEN   260717C00012000",
  "underlying-symbol": "WEN",
  "instrument-type": "Equity Option",
  "transaction-type": "Receive Deliver",
  "transaction-sub-type": "Expiration",
  description: "Removal of 5 WEN 07/17/26 Call 12.00 due to expiration.",
  quantity: 5,
  value: 0,
  "value-effect": "None",
  "net-value": 0,
  "net-value-effect": "None",
  "executed-at": "2026-07-17T20:00:00Z",
};

const EXPIRED_OPEN_ROW: LedgerRow = {
  ...OPEN_ROW,
  symbol: "WEN   260717C00012000",
  "underlying-symbol": "WEN",
  quantity: 5,
  value: 500,
  "net-value": 505,
  "executed-at": "2026-07-15T14:30:00Z",
};

test("an expiration with no matching close is a realized -100%, not a dropped row", () => {
  const report = buildRealizedPnlReport([EXPIRED_OPEN_ROW, EXPIRATION_ROW]);

  assert.equal(report.trips.length, 1, "the expired contract must produce a round trip");
  const trip = report.trips[0]!;
  assert.equal(trip.outcome, "expired");
  assert.equal(trip.underlying, "WEN");
  assert.equal(trip.quantity, 5);
  assert.equal(trip.netProceeds, 0);
  assert.equal(trip.netCost, 505);
  assert.equal(report.totals.netReturnPct, -100);

  // And nothing is left dangling.
  assert.equal(report.reconciliation.stillOpen.length, 0);
  assert.equal(report.reconciliation.expirationLegs, 1);
  assert.equal(report.reconciliation.trips, 1);
});

test("an expiration is not silently swallowed when it lands with real closes", () => {
  // The blended number is what gets quoted. With the expiration dropped it read
  // a small gain; with it included the window is deeply negative.
  const withExpiry = buildRealizedPnlReport([
    OPEN_ROW,
    CLOSE_ROW,
    EXPIRED_OPEN_ROW,
    EXPIRATION_ROW,
  ]);
  const withoutExpiry = buildRealizedPnlReport([OPEN_ROW, CLOSE_ROW]);

  assert.equal(withExpiry.trips.length, 2);
  assert.equal(withoutExpiry.trips.length, 1);
  assert.ok(num(withoutExpiry.totals.netReturnPct) > 0, "the closed trip alone is a gain");
  assert.ok(
    num(withExpiry.totals.netReturnPct) < -50,
    "including the expiration must swing the window deeply negative",
  );
});

test("classifyLegKind recognises the Receive Deliver termination shapes", () => {
  assert.equal(classifyLegKind(EXPIRATION_ROW), "expiration");
  assert.equal(
    classifyLegKind({ "transaction-type": "Receive Deliver", "transaction-sub-type": "Assignment" }),
    "expiration",
  );
  assert.equal(
    classifyLegKind({ "transaction-type": "Receive Deliver", "transaction-sub-type": "Exercise" }),
    "expiration",
  );
  // An expiration row with only a description still terminates the lot.
  assert.equal(
    classifyLegKind({ "transaction-type": "Receive Deliver", description: "… due to expiration." }),
    "expiration",
  );
  assert.equal(classifyLegKind(OPEN_ROW), "open");
  assert.equal(classifyLegKind(CLOSE_ROW), "close");
});

test("a quantity-less expiration removes the whole remaining position", () => {
  const report = buildRealizedPnlReport([
    EXPIRED_OPEN_ROW,
    { ...EXPIRATION_ROW, quantity: 0 },
  ]);
  assert.equal(report.trips.length, 1);
  assert.equal(report.trips[0]!.quantity, 5);
  assert.equal(report.reconciliation.stillOpen.length, 0);
});

// ── Defect 1b: commissions ──────────────────────────────────────────────────
test("a commission-bearing round trip carries both gross and net cash", () => {
  const trip = buildRealizedPnlReport([OPEN_ROW, CLOSE_ROW]).trips[0]!;
  // $1/contract to open, $0.12/contract to close.
  assert.equal(trip.grossCost, 200);
  assert.equal(trip.netCost, 202);
  assert.equal(trip.grossProceeds, 240);
  assert.ok(near(trip.netProceeds, 239.76));
});

test("fee drag is reported separately and always makes the net return worse", () => {
  const t = buildRealizedPnlReport([OPEN_ROW, CLOSE_ROW]).totals;
  assert.notEqual(t.grossPnl, t.netPnl);
  assert.ok(near(t.fees, 2.24));
  // 40/200 = +20.0% gross vs 37.76/202 = +18.69% net — 1.11pp of fee drag.
  assert.ok(near(num(t.grossReturnPct), 20));
  assert.ok(near(num(t.netReturnPct), 18.693069, 1e-4));
  assert.ok(near(num(t.feeDragPp), 1.108911, 1e-4));
  assert.ok(num(t.netReturnPct) < num(t.grossReturnPct), "fees must reduce the net return");
});

test("fees are allocated pro-rata across a partial close", () => {
  const report = buildRealizedPnlReport([
    OPEN_ROW, // 2 contracts, net cost 202
    { ...CLOSE_ROW, quantity: 1, value: 120, "net-value": 119.88 },
  ]);
  assert.equal(report.trips.length, 1);
  assert.equal(report.trips[0]!.netCost, 101);
  assert.equal(report.reconciliation.stillOpen.length, 1);
  assert.equal(report.reconciliation.stillOpen[0]!.quantity, 1);
});

test("a row without net-value falls back to value rather than pricing at zero", () => {
  const report = buildRealizedPnlReport([
    { ...OPEN_ROW, "net-value": undefined, "net-value-effect": undefined },
    { ...CLOSE_ROW, "net-value": undefined, "net-value-effect": undefined },
  ]);
  assert.equal(report.trips[0]!.netCost, 200);
  assert.equal(report.trips[0]!.netProceeds, 240);
  assert.equal(report.totals.fees, 0);
});

// ── Symbol changes ──────────────────────────────────────────────────────────
test("normalizeOptionRoot strips the corporate-action suffix", () => {
  assert.equal(normalizeOptionRoot("EOSE1 "), "EOSE");
  assert.equal(normalizeOptionRoot("EOSE  "), "EOSE");
  assert.equal(normalizeOptionRoot("AAPL  "), "AAPL");
});

test("a symbol change between open and close still pairs the round trip", () => {
  const open: LedgerRow = {
    ...OPEN_ROW,
    symbol: "EOSE  260918C00006000",
    "underlying-symbol": "EOSE",
    "executed-at": "2026-07-21T14:30:00Z",
  };
  const close: LedgerRow = {
    ...CLOSE_ROW,
    symbol: "EOSE1 260918C00006000",
    "underlying-symbol": "EOSE1",
    "executed-at": "2026-07-30T16:30:00Z",
  };

  const report = buildRealizedPnlReport([open, close]);
  assert.equal(report.trips.length, 1, "renamed contract must still pair with its open");
  assert.equal(report.trips[0]!.quantity, 2);
  assert.equal(report.reconciliation.stillOpen.length, 0);
  assert.equal(report.reconciliation.closesWithoutOpen.length, 0);
});

test("different contracts on the same root are not merged by the rename rule", () => {
  const report = buildRealizedPnlReport([
    OPEN_ROW,
    { ...CLOSE_ROW, symbol: "AAPL  260619C00110000" }, // different strike
  ]);
  assert.equal(report.trips.length, 0);
  assert.equal(report.reconciliation.stillOpen.length, 1);
  assert.equal(report.reconciliation.closesWithoutOpen.length, 1);
});

// ── Equity rows ─────────────────────────────────────────────────────────────
test("manual equity round-trips never pollute the options P&L", () => {
  const equityBuy: LedgerRow = {
    symbol: "SNWV",
    "underlying-symbol": "SNWV",
    "instrument-type": "Equity",
    "transaction-type": "Trade",
    "transaction-sub-type": "Buy to Open",
    quantity: 1000,
    value: 5000,
    "value-effect": "Debit",
    "net-value": 5000,
    "net-value-effect": "Debit",
    "executed-at": "2026-07-18T14:30:00Z",
  };
  const equitySell: LedgerRow = {
    ...equityBuy,
    "transaction-sub-type": "Sell to Close",
    value: 4000,
    "value-effect": "Credit",
    "net-value": 3999,
    "net-value-effect": "Credit",
    "executed-at": "2026-07-19T14:30:00Z",
  };

  const optionsOnly = buildRealizedPnlReport([OPEN_ROW, CLOSE_ROW]);
  const mixed = buildRealizedPnlReport([OPEN_ROW, equityBuy, CLOSE_ROW, equitySell]);

  assert.equal(mixed.trips.length, 1, "only the option round trip counts");
  assert.equal(mixed.totals.netReturnPct, optionsOnly.totals.netReturnPct);
  assert.equal(mixed.totals.netCost, optionsOnly.totals.netCost);

  // …but they are reported, in their own bucket.
  assert.equal(mixed.equity.rowCount, 2);
  assert.deepEqual(mixed.equity.symbols, ["SNWV"]);
  assert.ok(near(mixed.equity.netCashFlow, -1001));
});

test("money-movement rows are skipped rather than treated as trades", () => {
  const report = buildRealizedPnlReport([
    { "transaction-type": "Money Movement", "transaction-sub-type": "Credit Interest", value: 3, "value-effect": "Credit" },
    OPEN_ROW,
    CLOSE_ROW,
  ]);
  assert.equal(report.trips.length, 1);
  assert.equal(report.reconciliation.skippedRows, 1);
  assert.equal(report.equity.rowCount, 0);
});

// ── Reconciliation ──────────────────────────────────────────────────────────
test("every open leg reaches a terminal state and the counts balance", () => {
  const stillOpenRow: LedgerRow = {
    ...OPEN_ROW,
    symbol: "RUM   260821C00009000",
    "underlying-symbol": "RUM",
    "executed-at": "2026-08-01T14:30:00Z",
  };
  const preWindowClose: LedgerRow = {
    ...CLOSE_ROW,
    symbol: "TSLA  260619C00300000",
    "underlying-symbol": "TSLA",
    "executed-at": "2026-07-18T16:30:00Z",
  };

  const report = buildRealizedPnlReport([
    OPEN_ROW,
    CLOSE_ROW,
    EXPIRED_OPEN_ROW,
    EXPIRATION_ROW,
    stillOpenRow,
    preWindowClose,
  ]);
  const r = report.reconciliation;

  assert.equal(r.rowsExamined, 6);
  assert.equal(r.openLegs, 3);
  assert.equal(r.closeLegs, 2);
  assert.equal(r.expirationLegs, 1);
  assert.equal(r.trips, 2);
  assert.equal(r.stillOpen.length, 1);
  assert.equal(r.stillOpen[0]!.underlying, "RUM");
  assert.equal(r.closesWithoutOpen.length, 1);
  assert.equal(r.closesWithoutOpen[0]!.underlying, "TSLA");

  // Contract-level conservation: opened contracts = matched + still open.
  const openedContracts = 2 + 5 + 2;
  const matched = report.trips.reduce((s, t) => s + t.quantity, 0);
  const dangling = r.stillOpen.reduce((s, l) => s + l.quantity, 0);
  assert.equal(matched + dangling, openedContracts);
});

test("the printed report surfaces reconciliation, fees and dangling legs", () => {
  const lines = formatRealizedPnlReport(
    buildRealizedPnlReport([OPEN_ROW, CLOSE_ROW, EXPIRED_OPEN_ROW, EXPIRATION_ROW]),
  ).join("\n");

  assert.match(lines, /reconciliation: rows 4 \| opens 2 \| closes 1 \| expirations 1 \| trips 2/);
  assert.match(lines, /gross \(pre-fee\)/);
  assert.match(lines, /fee/i);
  assert.match(lines, /Expiration/);
});

test("an all-expired window reports -100% instead of an empty report", () => {
  const report = buildRealizedPnlReport([EXPIRED_OPEN_ROW, EXPIRATION_ROW]);
  const lines = formatRealizedPnlReport(report).join("\n");
  assert.doesNotMatch(lines, /no round trips closed/);
  assert.match(lines, /-100\.0%/);
});

test("an empty ledger degrades to an explicit empty report", () => {
  const report = buildRealizedPnlReport([]);
  assert.equal(report.trips.length, 0);
  assert.equal(report.totals.netReturnPct, null);
  assert.match(formatRealizedPnlReport(report).join("\n"), /no round trips closed/);
});
