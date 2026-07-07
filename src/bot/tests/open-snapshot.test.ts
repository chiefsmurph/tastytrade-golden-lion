import test from "node:test";
import assert from "node:assert/strict";

import {
  isOpenSnapshotTime,
  computeOvernightGroupPnl,
  pairGroupWithPriorClose,
  buildOpenSnapshotInput,
  parseOpenSnapshotsNewestFirst,
  MARKET_OPEN_MINUTE,
  OPEN_SNAPSHOT_CUTOFF_MINUTE,
} from "~/bot/open-snapshot";
import type { RunGroupReturn } from "~/bot/run-history";
import type { DayReportEntry, DayReportGroup } from "~/bot/day-report-store";
import type { TastytradeAccountBalance } from "~/core/types";

const BALANCES = {
  "net-liquidating-value": "5000",
  "derivative-buying-power": "1200",
  "cash-balance": "800",
} as unknown as TastytradeAccountBalance;

// v6 strategy #12 — overnight-hold P&L snapshot. These tests cover the pure
// helpers: the morning time gate and the open-vs-prior-close pairing math.
// PDT is UTC-7 (July); build explicit instants so assertions hold regardless
// of the test machine's local timezone.
function atPdt(time: string): Date {
  return new Date(`2026-07-07T${time}:00-07:00`);
}

function makeRunGroup(overrides: Partial<RunGroupReturn>): RunGroupReturn {
  return {
    askReturnPct: 0,
    bidReturnPct: 0,
    positionGate: null,
    currentReturnPct: 0,
    side: "call",
    buyWeight: null,
    daytradeScore: null,
    returnPerc: null,
    superRecScore: null,
    totalCostBasis: 0,
    totalUnrealizedReturnAsk: 0,
    totalUnrealizedReturnBid: 0,
    underlyingPriceAtCycleTime: null,
    underlyingSymbol: "RUM",
    weightedAverageFill: 0,
    ...overrides,
  };
}

function makeReportGroup(overrides: Partial<DayReportGroup>): DayReportGroup {
  return {
    underlyingSymbol: "RUM",
    side: "call",
    bidReturnPct: 0,
    askReturnPct: 0,
    midReturnPct: 0,
    totalUnrealizedReturnBid: 0,
    totalUnrealizedReturnAsk: 0,
    totalUnrealizedReturnMid: 0,
    totalCostBasis: 0,
    ...overrides,
  };
}

function makeReport(groups: DayReportGroup[]): DayReportEntry {
  return {
    id: "prior",
    accountNumber: "TEST",
    date: "2026-07-06",
    timestamp: "2026-07-06T20:55:00.000Z",
    netLiquidatingValue: 0,
    totalCapital: 0,
    derivativeBuyingPower: 0,
    cashBalance: 0,
    groups,
    summary: {
      openPositionCount: groups.length,
      totalUnrealizedReturnBid: 0,
      totalUnrealizedReturnAsk: 0,
      totalUnrealizedReturnMid: 0,
      totalCostBasis: 0,
    },
  };
}

test("isOpenSnapshotTime is open only in the morning window", () => {
  // Before the 6:30 AM PT open: closed.
  assert.equal(isOpenSnapshotTime(atPdt("06:00")), false);
  // At the open and through the morning: open.
  assert.equal(isOpenSnapshotTime(atPdt("06:30")), true);
  assert.equal(isOpenSnapshotTime(atPdt("07:15")), true);
  assert.equal(isOpenSnapshotTime(atPdt("09:59")), true);
  // At the 10:00 AM PT cutoff and after (mid-day restart): closed.
  assert.equal(isOpenSnapshotTime(atPdt("10:00")), false);
  assert.equal(isOpenSnapshotTime(atPdt("12:30")), false);

  // Window boundaries match the documented minute constants.
  assert.equal(MARKET_OPEN_MINUTE, 390);
  assert.equal(OPEN_SNAPSHOT_CUTOFF_MINUTE, 600);
});

test("pairGroupWithPriorClose handles paired, unpaired, and zero-basis cases", () => {
  const group = makeRunGroup({ totalCostBasis: 100, totalUnrealizedReturnBid: 50 });

  // Unpaired (no prior group) => null P&L, open value still computed.
  const unpaired = pairGroupWithPriorClose(group, undefined);
  assert.equal(unpaired.pairedWithPriorClose, false);
  assert.equal(unpaired.openBidValue, 150);
  assert.equal(unpaired.overnightPnlDollars, null);
  assert.equal(unpaired.overnightPnlPct, null);

  // Paired against a normal prior close.
  const paired = pairGroupWithPriorClose(
    group,
    makeReportGroup({ totalCostBasis: 100, totalUnrealizedReturnBid: 20 }),
  );
  assert.equal(paired.overnightPnlDollars, 30);
  assert.equal(paired.overnightPnlPct, 30 / 120);

  // Prior close bid value of exactly 0 => dollars computed, pct guarded to null.
  const zeroBasis = pairGroupWithPriorClose(
    group,
    makeReportGroup({ totalCostBasis: 0, totalUnrealizedReturnBid: 0 }),
  );
  assert.equal(zeroBasis.priorCloseBidValue, 0);
  assert.equal(zeroBasis.overnightPnlDollars, 150);
  assert.equal(zeroBasis.overnightPnlPct, null);
});

test("overnight P&L pairs a held group present in both snapshots", () => {
  // Prior close: cost 100 + unrealized bid +20 => close bid value 120.
  const prior = makeReport([
    makeReportGroup({ totalCostBasis: 100, totalUnrealizedReturnBid: 20 }),
  ]);
  // Today open: cost 100 + unrealized bid +50 => open bid value 150.
  const runGroups = [
    makeRunGroup({ totalCostBasis: 100, totalUnrealizedReturnBid: 50 }),
  ];

  const [pnl] = computeOvernightGroupPnl(runGroups, prior);
  assert.equal(pnl.pairedWithPriorClose, true);
  assert.equal(pnl.openBidValue, 150);
  assert.equal(pnl.priorCloseBidValue, 120);
  // Overnight gain: 150 − 120 = +30 (+25% of 120).
  assert.equal(pnl.overnightPnlDollars, 30);
  assert.equal(pnl.overnightPnlPct, 30 / 120);
});

test("overnight P&L is null when the group has no prior-close match", () => {
  // Prior report holds only WULF::call; today holds RUM::call (no match).
  const prior = makeReport([
    makeReportGroup({ underlyingSymbol: "WULF", totalCostBasis: 80, totalUnrealizedReturnBid: 0 }),
  ]);
  const runGroups = [
    makeRunGroup({ underlyingSymbol: "RUM", totalCostBasis: 100, totalUnrealizedReturnBid: 10 }),
  ];

  const [pnl] = computeOvernightGroupPnl(runGroups, prior);
  assert.equal(pnl.pairedWithPriorClose, false);
  assert.equal(pnl.openBidValue, 110);
  assert.equal(pnl.priorCloseBidValue, null);
  assert.equal(pnl.overnightPnlDollars, null);
  assert.equal(pnl.overnightPnlPct, null);
});

test("side is part of the pairing key", () => {
  // Prior close held RUM::put; today holds RUM::call — different side, no match.
  const prior = makeReport([
    makeReportGroup({ side: "put", totalCostBasis: 100, totalUnrealizedReturnBid: 5 }),
  ]);
  const runGroups = [makeRunGroup({ side: "call", totalCostBasis: 100 })];

  const [pnl] = computeOvernightGroupPnl(runGroups, prior);
  assert.equal(pnl.pairedWithPriorClose, false);
  assert.equal(pnl.overnightPnlDollars, null);
});

test("overnight P&L is null for every group when there is no prior report", () => {
  const runGroups = [
    makeRunGroup({ underlyingSymbol: "RUM", totalCostBasis: 100, totalUnrealizedReturnBid: 10 }),
    makeRunGroup({ underlyingSymbol: "WULF", totalCostBasis: 200, totalUnrealizedReturnBid: -5 }),
  ];

  const results = computeOvernightGroupPnl(runGroups, null);
  assert.equal(results.length, 2);
  for (const pnl of results) {
    assert.equal(pnl.pairedWithPriorClose, false);
    assert.equal(pnl.priorCloseBidValue, null);
    assert.equal(pnl.overnightPnlDollars, null);
  }
  // Open bid values are still computed from today's held positions.
  assert.equal(results[0].openBidValue, 110);
  assert.equal(results[1].openBidValue, 195);
});

test("buildOpenSnapshotInput pairs against a strictly-earlier prior report", () => {
  const prior = makeReport([
    makeReportGroup({ totalCostBasis: 100, totalUnrealizedReturnBid: 20 }),
  ]);
  const runGroups = [
    makeRunGroup({ totalCostBasis: 100, totalUnrealizedReturnBid: 50 }),
  ];

  const input = buildOpenSnapshotInput("TEST", BALANCES, runGroups, 5000, prior);
  assert.equal(input.accountNumber, "TEST");
  assert.equal(input.netLiquidatingValue, 5000);
  assert.equal(input.derivativeBuyingPower, 1200);
  assert.equal(input.cashBalance, 800);
  assert.equal(input.pairedWithPriorClose, true);
  assert.equal(input.priorCloseDate, "2026-07-06");
  assert.equal(input.summary.openPositionCount, 1);
  assert.equal(input.summary.pairedGroupCount, 1);
  assert.equal(input.summary.totalOvernightPnlDollars, 30);
});

test("buildOpenSnapshotInput does not pair against a same-day report", () => {
  // A report already dated today is this morning's own write, not a prior
  // close — it must not be treated as the prior-close baseline.
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });
  const sameDay = makeReport([
    makeReportGroup({ totalCostBasis: 100, totalUnrealizedReturnBid: 20 }),
  ]);
  sameDay.date = today;
  const runGroups = [makeRunGroup({ totalCostBasis: 100, totalUnrealizedReturnBid: 50 })];

  const input = buildOpenSnapshotInput("TEST", BALANCES, runGroups, 5000, sameDay);
  assert.equal(input.pairedWithPriorClose, false);
  assert.equal(input.priorCloseDate, null);
  assert.equal(input.summary.pairedGroupCount, 0);
  assert.equal(input.summary.totalOvernightPnlDollars, null);
});

test("buildOpenSnapshotInput yields null overnight total when there is no prior report", () => {
  const runGroups = [makeRunGroup({ totalCostBasis: 100, totalUnrealizedReturnBid: 50 })];
  const input = buildOpenSnapshotInput("TEST", BALANCES, runGroups, 5000, null);
  assert.equal(input.pairedWithPriorClose, false);
  assert.equal(input.priorCloseDate, null);
  assert.equal(input.summary.openPositionCount, 1);
  assert.equal(input.summary.totalOvernightPnlDollars, null);
});

test("parseOpenSnapshotsNewestFirst returns newest-first and skips corrupt lines", () => {
  const raw = [
    JSON.stringify({ id: "a", date: "2026-07-05" }),
    "not-json{",
    "",
    JSON.stringify({ id: "b", date: "2026-07-06" }),
  ].join("\n");

  const entries = parseOpenSnapshotsNewestFirst(raw);
  assert.equal(entries.length, 2);
  // Newest (last line) comes first; the corrupt and blank lines are dropped.
  assert.equal(entries[0].id, "b");
  assert.equal(entries[1].id, "a");

  assert.deepEqual(parseOpenSnapshotsNewestFirst(""), []);
});
