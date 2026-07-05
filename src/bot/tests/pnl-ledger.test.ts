import test from "node:test";
import assert from "node:assert/strict";

import { buildPnlLedgerEntries, classifyCloseDecision } from "../pnl-ledger";
import type { RunCloseOrder, RunGroupReturn, RunStrategyDecision } from "../run-history";

// OCC: "AAPL  " (6-char root) + 260619 (2026-06-19 expiration) + C + strike
const OCC_SYMBOL = "AAPL  260619C00100000";

function buildGroup(overrides: Partial<RunGroupReturn> = {}): RunGroupReturn {
  return {
    askReturnPct: 0.05,
    bidReturnPct: -0.05,
    positionGate: null,
    currentReturnPct: 0,
    side: "call",
    buyWeight: null,
    daytradeScore: null,
    returnPerc: null,
    superRecScore: null,
    totalCostBasis: 200,
    totalUnrealizedReturnAsk: 0,
    totalUnrealizedReturnBid: 0,
    underlyingPriceAtCycleTime: null,
    underlyingSymbol: "AAPL",
    weightedAverageFill: 1.0,
    ...overrides,
  };
}

function buildCloseOrder(overrides: Partial<RunCloseOrder> = {}): RunCloseOrder {
  return {
    // 16:30 UTC = 09:30 PDT on 2026-06-10 → dteAtClose vs 06-19 expiration = 9
    fills: [{ fillId: "f1", fillPrice: 1.2, filledAt: "2026-06-10T16:30:00Z", quantity: 2 }],
    orderId: "42",
    placedOrder: true,
    price: 1.2,
    skippedReason: null,
    status: "Filled",
    symbol: OCC_SYMBOL,
    underlyingSymbol: "AAPL",
    ...overrides,
  };
}

function buildDecision(reason: string): RunStrategyDecision {
  return {
    currentReturnPct: 0,
    strategyAction: "CLOSE_POSITION",
    reason,
    underlyingSymbol: "AAPL",
  };
}

function build(overrides: Partial<Parameters<typeof buildPnlLedgerEntries>[0]> = {}) {
  return buildPnlLedgerEntries({
    accountNumber: "ACC-1",
    accountType: "margin",
    cycleCloseOrders: [buildCloseOrder()],
    overnightCloseOrders: [],
    groups: [buildGroup()],
    strategyDecisions: [
      buildDecision("Profit target reached (12.00% >= 10.00%) - close position and lock in gains"),
    ],
    openedAtByUnderlying: new Map([["AAPL", "2026-06-05T14:00:00Z"]]),
    ...overrides,
  });
}

test("classifyCloseDecision maps the strategy reason strings", () => {
  assert.equal(classifyCloseDecision("Profit target reached (12.00% >= 10.00%) - ..."), "take-profit");
  assert.equal(classifyCloseDecision("Hit absolute loss limit (-31.00% <= -30%) - stop loss triggered"), "stop-loss");
  assert.equal(classifyCloseDecision("Market closed or closing - liquidate all positions immediately"), "eod-liquidation");
  assert.equal(classifyCloseDecision("End-of-day risk management (-11.00% <= -10%) - ..."), "eod-stop");
  assert.equal(classifyCloseDecision("something else entirely"), "other");
});

test("take-profit round trip: P&L math, attribution, timing fields", () => {
  const entries = build();
  assert.equal(entries.length, 1);
  const entry = entries[0]!;

  assert.equal(entry.decisionType, "take-profit");
  assert.equal(entry.isUrgentClose, false);
  assert.equal(entry.quantityClosed, 2);
  assert.equal(entry.avgCloseFillPrice, 1.2);
  assert.equal(entry.weightedAverageOpenFill, 1.0);
  // (1.2 - 1.0) * 2 contracts * 100 multiplier
  assert.ok(Math.abs((entry.realizedPnlDollars ?? 0) - 40) < 1e-9);
  assert.ok(Math.abs((entry.realizedPnlPct ?? 0) - 0.2) < 1e-9);

  assert.equal(entry.closedAt, "2026-06-10T16:30:00Z");
  assert.equal(entry.closeHourPst, 9);
  assert.equal(entry.dteAtClose, 9); // 06-10 → 06-19
  assert.equal(entry.dteAtEntry, 14); // 06-05 → 06-19
  assert.equal(entry.positionAgeDays, 5); // 06-05 → 06-10
  assert.equal(entry.side, "call");
  assert.equal(entry.accountType, "margin");
  // Reserved entry-side fields stay null until entry-side recording lands
  assert.equal(entry.entrySpreadPct, null);
  assert.equal(entry.gateScoreAtEntry, null);
});

test("multi-fill closes use a quantity-weighted average fill price", () => {
  const entries = build({
    cycleCloseOrders: [
      buildCloseOrder({
        fills: [
          { fillId: "f1", fillPrice: 1.2, filledAt: "2026-06-10T16:30:00Z", quantity: 1 },
          { fillId: "f2", fillPrice: 1.0, filledAt: "2026-06-10T16:31:00Z", quantity: 3 },
        ],
      }),
    ],
  });
  // (1.2*1 + 1.0*3) / 4
  assert.ok(Math.abs(entries[0]!.avgCloseFillPrice - 1.05) < 1e-9);
  assert.equal(entries[0]!.quantityClosed, 4);
});

test("stop-loss and EOD decisions are marked urgent", () => {
  for (const reason of [
    "Hit absolute loss limit (-31.00% <= -30%) - stop loss triggered",
    "Market closed or closing - liquidate all positions immediately",
    "End-of-day risk management (-11.00% <= -10%) - close losing positions before market close",
  ]) {
    const entries = build({ strategyDecisions: [buildDecision(reason)] });
    assert.equal(entries[0]!.isUrgentClose, true, reason);
  }
});

test("overnight-reduction closes are attributed by source, not reason string", () => {
  const entries = build({
    cycleCloseOrders: [],
    overnightCloseOrders: [buildCloseOrder()],
    strategyDecisions: [],
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.decisionType, "overnight-reduction");
  assert.equal(entries[0]!.isUrgentClose, false);
});

test("skips unplaced orders and placed orders with no observed fills", () => {
  const entries = build({
    cycleCloseOrders: [
      buildCloseOrder({ placedOrder: false }),
      buildCloseOrder({ fills: [] }),
    ],
  });
  assert.equal(entries.length, 0);
});

test("a filled close with no matching group keeps the trip with null P&L", () => {
  const entries = build({ groups: [] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.realizedPnlDollars, null);
  assert.equal(entries[0]!.realizedPnlPct, null);
  assert.equal(entries[0]!.weightedAverageOpenFill, null);
  // side still inferred from the OCC symbol
  assert.equal(entries[0]!.side, "call");
});

test("reconstructs the cycle-time spread from the group's bid/ask returns", () => {
  // waf 1.0, bid return -5%, ask return +5% → bid 0.95 / ask 1.05 / mid 1.0 → 10%
  const entries = build();
  assert.ok(Math.abs((entries[0]!.spreadPctAtCycle ?? 0) - 0.1) < 1e-9);
});

test("gate score and max target are carried from the group's position gate", () => {
  const entries = build({
    groups: [
      buildGroup({
        positionGate: {
          signals: {
            crossAccountYes: true,
            basicStockYes: false,
            strongStockYes: false,
            goodBooleanScore: 6,
            allBooleansGood: false,
          },
          maxTargetPct: 0.25,
          strongStockYesPctThreshold: 30,
          strongStockYesScoreThreshold: -100,
          basicStockYesPctThreshold: 25,
          basicStockYesScoreThreshold: -40,
        },
      }),
    ],
  });
  assert.equal(entries[0]!.gateScoreAtClose, 6);
  assert.equal(entries[0]!.gateMaxTargetPctAtClose, 0.25);
});

test("missing registry openedAt leaves entry-relative fields null but keeps DTE at close", () => {
  const entries = build({ openedAtByUnderlying: new Map() });
  const entry = entries[0]!;
  assert.equal(entry.dteAtEntry, null);
  assert.equal(entry.positionAgeDays, null);
  assert.equal(entry.dteAtClose, 9);
});
