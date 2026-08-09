import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildPnlLedgerEntries,
  classifyCloseDecision,
  getPnlLedger,
  repairLegacyContractScaling,
  type PnlLedgerEntry,
} from "../pnl-ledger";
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
    entryContextByUnderlying: new Map([["AAPL", { openedAt: "2026-06-05T14:00:00Z" }]]),
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
  // Entry-side fields are null when the registry carried no entry context
  // (the default build passes openedAt only).
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
          governorMult: 1,
          strongStockYesPctThreshold: 30,
          basicStockYesPctThreshold: 25,
        },
      }),
    ],
  });
  assert.equal(entries[0]!.gateScoreAtClose, 6);
  assert.equal(entries[0]!.gateMaxTargetPctAtClose, 0.25);
});

test("missing registry openedAt leaves entry-relative fields null but keeps DTE at close", () => {
  const entries = build({ entryContextByUnderlying: new Map() });
  const entry = entries[0]!;
  assert.equal(entry.dteAtEntry, null);
  assert.equal(entry.positionAgeDays, null);
  assert.equal(entry.dteAtClose, 9);
  assert.equal(entry.entrySpreadPct, null);
  assert.equal(entry.gateScoreAtEntry, null);
});

// v8 #13: entry spread + gate score captured at open (in the registry) are
// copied onto the close-side row via entryContextByUnderlying.
test("copies registry entry spread and gate score onto the ledger row", () => {
  const entries = build({
    entryContextByUnderlying: new Map([
      ["AAPL", { openedAt: "2026-06-05T14:00:00Z", entrySpreadPct: 0.18, gateScoreAtEntry: 6 }],
    ]),
  });
  const entry = entries[0]!;
  assert.ok(Math.abs((entry.entrySpreadPct ?? 0) - 0.18) < 1e-9);
  assert.equal(entry.gateScoreAtEntry, 6);
  // openedAt from the same context still drives the entry/age DTE math
  assert.equal(entry.dteAtEntry, 14);
  assert.equal(entry.positionAgeDays, 5);
});

test("entry enrichment is independent of the close-side gate score", () => {
  // A wide entry spread with a strong gate at entry, closed while the current
  // gate score reads differently — both sides are recorded separately.
  const entries = build({
    groups: [
      buildGroup({
        positionGate: {
          signals: {
            crossAccountYes: true,
            basicStockYes: false,
            strongStockYes: false,
            goodBooleanScore: 3,
            allBooleansGood: false,
          },
          maxTargetPct: 0.1,
          governorMult: 1,
          strongStockYesPctThreshold: 30,
          basicStockYesPctThreshold: 25,
        },
      }),
    ],
    entryContextByUnderlying: new Map([
      ["AAPL", { openedAt: "2026-06-05T14:00:00Z", entrySpreadPct: 0.2, gateScoreAtEntry: 8 }],
    ]),
  });
  const entry = entries[0]!;
  assert.equal(entry.gateScoreAtEntry, 8);
  assert.equal(entry.gateScoreAtClose, 3);
  assert.ok(Math.abs((entry.entrySpreadPct ?? 0) - 0.2) < 1e-9);
});

// v8 #9: the 12:50 clock liquidation and the −10% post-cutoff price stop must
// resolve to distinct decisionTypes so P&L can attribute "flattened by the
// clock" separately from "given back to a stop". Both remain urgent closes.
test("clock liquidation and post-cutoff price stop are distinct urgent decisionTypes", () => {
  const clock = build({
    strategyDecisions: [buildDecision("Market closed or closing - liquidate all positions immediately")],
  })[0]!;
  const priceStop = build({
    strategyDecisions: [
      buildDecision("End-of-day risk management (-11.00% <= -10%) - close losing positions before market close"),
    ],
  })[0]!;

  assert.equal(clock.decisionType, "eod-liquidation");
  assert.equal(priceStop.decisionType, "eod-stop");
  assert.notEqual(clock.decisionType, priceStop.decisionType);
  assert.equal(clock.isUrgentClose, true);
  assert.equal(priceStop.isUrgentClose, true);
});

// ── REGRESSION 2026-08-08: the unconditional ×100 contract multiplier ────────
// The margin account carries manually-traded EQUITY rows (a bare ticker, no OCC
// suffix, side "none") alongside options. The ledger multiplied those by 100
// too. Three rows in the 07-17→08-07 window were inflated 100×, and the window
// total read roughly 20× its true magnitude — enough to invert the read on
// which account was losing money.
const EQUITY_SYMBOL = "SNWV";

function buildEquityLedger(overrides: Partial<Parameters<typeof buildPnlLedgerEntries>[0]> = {}) {
  return buildPnlLedgerEntries({
    accountNumber: "ACC-1",
    accountType: "margin",
    cycleCloseOrders: [
      buildCloseOrder({
        symbol: EQUITY_SYMBOL,
        underlyingSymbol: EQUITY_SYMBOL,
        // 1,000 shares sold at 4.95 against a 5.00 basis => -$50, not -$5,000.
        fills: [{ fillId: "f1", fillPrice: 4.95, filledAt: "2026-08-05T16:30:00Z", quantity: 1000 }],
      }),
    ],
    overnightCloseOrders: [],
    groups: [
      buildGroup({
        side: "none",
        underlyingSymbol: EQUITY_SYMBOL,
        weightedAverageFill: 5.0,
        totalCostBasis: 5000,
      }),
    ],
    strategyDecisions: [],
    entryContextByUnderlying: new Map(),
    ...overrides,
  });
}

test("an equity row in the margin ledger is priced per share, not ×100", () => {
  const entry = buildEquityLedger()[0]!;

  assert.equal(entry.symbol, EQUITY_SYMBOL);
  assert.equal(entry.side, null, "a bare ticker has no option side");
  assert.equal(entry.quantityClosed, 1000);
  // (4.95 - 5.00) * 1000 shares * 1 => -$50. The bug produced -$5,000.
  assert.ok(Math.abs((entry.realizedPnlDollars ?? 0) - -50) < 1e-9);
  assert.notEqual(Math.round(entry.realizedPnlDollars ?? 0), -5000);
  // The percentage was always right — only the dollars were scaled.
  assert.ok(Math.abs((entry.realizedPnlPct ?? 0) - -0.01) < 1e-9);
});

test("a genuine OCC option row still gets the ×100 contract multiplier", () => {
  // Guard the other direction: the multiplier gate must not quietly de-scale a
  // correct option row. (1.2 - 1.0) * 2 contracts * 100 = +$40.
  const entry = build()[0]!;
  assert.equal(entry.symbol, OCC_SYMBOL);
  assert.ok(Math.abs((entry.realizedPnlDollars ?? 0) - 40) < 1e-9);
});

test("a mixed cycle scales each row by its own instrument", () => {
  const entries = buildPnlLedgerEntries({
    accountNumber: "ACC-1",
    accountType: "margin",
    cycleCloseOrders: [
      buildCloseOrder(),
      buildCloseOrder({
        symbol: EQUITY_SYMBOL,
        underlyingSymbol: EQUITY_SYMBOL,
        fills: [{ fillId: "f2", fillPrice: 4.95, filledAt: "2026-08-05T16:30:00Z", quantity: 1000 }],
      }),
    ],
    overnightCloseOrders: [],
    groups: [
      buildGroup(),
      buildGroup({
        side: "none",
        underlyingSymbol: EQUITY_SYMBOL,
        weightedAverageFill: 5.0,
        totalCostBasis: 5000,
      }),
    ],
    strategyDecisions: [],
    entryContextByUnderlying: new Map(),
  });

  const total = entries.reduce((sum, e) => sum + (e.realizedPnlDollars ?? 0), 0);
  // +$40 option, -$50 equity. The bug read this cycle as -$4,960.
  assert.ok(Math.abs(total - -10) < 1e-9);
});

test("repairLegacyContractScaling fixes stored equity rows and leaves options alone", () => {
  const base: PnlLedgerEntry = {
    ...build()[0]!,
    symbol: EQUITY_SYMBOL,
    underlyingSymbol: EQUITY_SYMBOL,
    quantityClosed: 1000,
    avgCloseFillPrice: 4.95,
    weightedAverageOpenFill: 5.0,
    realizedPnlDollars: -5000, // written by the buggy path
  };
  assert.ok(Math.abs((repairLegacyContractScaling(base).realizedPnlDollars ?? 0) - -50) < 1e-9);

  // Already-correct equity row: untouched.
  const fixed = { ...base, realizedPnlDollars: -50 };
  assert.equal(repairLegacyContractScaling(fixed).realizedPnlDollars, -50);

  // A real option row keeps its ×100 dollars.
  const option = build()[0]!;
  assert.equal(repairLegacyContractScaling(option).realizedPnlDollars, option.realizedPnlDollars);

  // A row that does not match the ×100 signature is left exactly as written.
  const unrelated = { ...base, realizedPnlDollars: -1234 };
  assert.equal(repairLegacyContractScaling(unrelated).realizedPnlDollars, -1234);
});

test("getPnlLedger repairs the 100× rows already written to disk", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sl-ledger-"));
  const previousDataDir = process.env.BOT_DATA_DIR;
  process.env.BOT_DATA_DIR = dataDir;
  try {
    const optionRow = build()[0]!;
    const equityRow: PnlLedgerEntry = {
      ...optionRow,
      id: "legacy-1",
      symbol: EQUITY_SYMBOL,
      underlyingSymbol: EQUITY_SYMBOL,
      side: null,
      quantityClosed: 1000,
      avgCloseFillPrice: 4.95,
      weightedAverageOpenFill: 5.0,
      realizedPnlDollars: -5000,
      realizedPnlPct: -0.01,
    };

    await fs.mkdir(path.join(dataDir, "ledger"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "ledger", "ACC-1-margin.ndjson"),
      `${JSON.stringify(optionRow)}\n${JSON.stringify(equityRow)}\n`,
      "utf8",
    );

    const result = (await getPnlLedger(["ACC-1"])) as {
      entryCount: number;
      totalRealizedPnlDollars: number;
    };
    assert.equal(result.entryCount, 2);
    // +$40 option, -$50 repaired equity. Unrepaired this read -$4,960.
    assert.ok(Math.abs(result.totalRealizedPnlDollars - -10) < 1e-9);
  } finally {
    if (previousDataDir === undefined) delete process.env.BOT_DATA_DIR;
    else process.env.BOT_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
