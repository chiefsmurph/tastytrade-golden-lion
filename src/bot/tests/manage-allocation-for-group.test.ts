import test from "node:test";
import assert from "node:assert/strict";

import {
  manageAllocationForGroup,
  isTooCloseToAccumulationCutoff,
  type AllocationBudget,
  type ManageAllocationDependencies,
} from "../actions/manage-allocation";
import type { PositionGroupEvaluation } from "../evaluate-position";
import type { ExecutionTargets } from "~/strategy/evaluate-trading-strategy";

const baseTargets: ExecutionTargets = {
  targetDTE: 21,
  targetAccountExposure: 0.5,
  bidWeight: 0.34,
  midWeight: 0.33,
  askWeight: 0.33,
};

const fullBudget: AllocationBudget = {
  buyingPowerRemaining: 100000,
  portfolioExposure: 0,
  totalCapital: 100000,
};

function buildEvaluation(
  targets: ExecutionTargets | undefined,
  currentTime: Date = new Date(),
): PositionGroupEvaluation {
  return {
    currentReturn: 0,
    executionTargets: targets,
    groupKey: "LCID::call",
    metrics: {
      currentAskPrice: 1.2,
      currentBidPrice: 1.0,
      currentTime,
      lastActionTime: currentTime,
      weightedAverageFill: 1,
    },
    positionSnapshots: [
      {
        currentAskPrice: 1.2,
        currentBidPrice: 1.0,
        lastActionTime: new Date(),
        position: {
          "account-number": "ACC-1",
          "instrument-type": "Option",
          quantity: 1,
          symbol: "LCID  250117C00010000",
        },
        quantityWeight: 1,
        weightedAverageFill: 1,
      },
    ],
    positions: [
      {
        "account-number": "ACC-1",
        "instrument-type": "Option",
        quantity: 1,
        symbol: "LCID  250117C00010000",
      },
    ] as PositionGroupEvaluation["positions"],
    strategy: { action: "MANAGE_ALLOCATION", reason: "test" },
    underlyingSymbol: "LCID",
  } as PositionGroupEvaluation;
}

// Health gate fails when the summary reports no healthy target DTEs.
const failingHealthDeps: ManageAllocationDependencies = {
  getOptionHealth: (async () => ({ summary: { healthyTargets: [] } })) as never,
};

test("manageAllocationForGroup skips when execution targets are missing", async () => {
  const result = await manageAllocationForGroup(
    "ACC-1",
    buildEvaluation(undefined),
    fullBudget,
  );
  assert.equal(result.placedOrder, false);
  assert.equal(result.skippedReason, "execution targets missing");
  assert.deepEqual(result.routeOrders, []);
});

test("manageAllocationForGroup skips when target exposure is zero", async () => {
  const result = await manageAllocationForGroup(
    "ACC-1",
    buildEvaluation({ ...baseTargets, targetAccountExposure: 0 }),
    fullBudget,
  );
  assert.equal(result.skippedReason, "target exposure is zero");
});

test("manageAllocationForGroup skips when no buying power remains", async () => {
  const result = await manageAllocationForGroup(
    "ACC-1",
    buildEvaluation(baseTargets),
    { ...fullBudget, buyingPowerRemaining: 0 },
  );
  assert.equal(result.skippedReason, "no remaining exposure or buying power");
});

test("manageAllocationForGroup skips when portfolio is already at target exposure", async () => {
  const result = await manageAllocationForGroup(
    "ACC-1",
    buildEvaluation(baseTargets),
    { ...fullBudget, portfolioExposure: 100000 },
  );
  assert.equal(result.skippedReason, "no remaining exposure or buying power");
});

test("manageAllocationForGroup skips when the option health gate fails", async () => {
  const result = await manageAllocationForGroup(
    "ACC-1",
    buildEvaluation(baseTargets),
    fullBudget,
    1,
    {},
    failingHealthDeps,
  );
  assert.equal(result.placedOrder, false);
  assert.match(result.skippedReason ?? "", /option health gate failed/);
});

const bigBudget: AllocationBudget = {
  buyingPowerRemaining: 10_000_000,
  portfolioExposure: 0,
  totalCapital: 10_000_000,
};

// Health summary whose healthy DTEs cover every checkpoint, so the gate passes.
const healthyTargets = Array.from({ length: 400 }, (_, i) => i);

function candidateDeps(
  overrides: Partial<ManageAllocationDependencies> = {},
): ManageAllocationDependencies {
  return {
    getOptionHealth: (async () => ({ summary: { healthyTargets } })) as never,
    getAccountType: (async () => "cash") as never,
    getTopCandidate: (async () => ({
      symbol: "LCID  270115C00010000",
      quoteSymbol: ".LCID270115C10",
      dte: 21,
      minDTE: 14,
      maxDTE: 30,
      preferredDTE: 21,
      usedDteFallback: false,
    })) as never,
    getBidAsk: (async () => ({ bid: 1.0, ask: 1.2 })) as never,
    placeOrders: (async (_acct: string, _sym: string, routeOrders: unknown[]) =>
      routeOrders.map((r) => ({
        ...(r as object),
        placedOrder: true,
        orderResponse: { order: { id: "1" } },
      }))) as never,
    ...overrides,
  };
}

test("manageAllocationForGroup returns a dry-run plan without placing orders", async () => {
  let placed = false;
  const deps = candidateDeps({
    placeOrders: (async () => {
      placed = true;
      return [];
    }) as never,
  });
  const result = await manageAllocationForGroup(
    "ACC-1",
    buildEvaluation(baseTargets),
    bigBudget,
    1,
    { dryRun: true },
    deps,
  );
  assert.equal(result.skippedReason, "dry-run plan");
  assert.equal(result.placedOrder, false);
  assert.ok((result.quantity ?? 0) >= 1, "dry-run should size at least one contract");
  assert.equal(placed, false, "dry-run must not place orders");
});

test("manageAllocationForGroup places orders on the happy path", async () => {
  const result = await manageAllocationForGroup(
    "ACC-1",
    buildEvaluation(baseTargets),
    bigBudget,
    1,
    {},
    candidateDeps(),
  );
  assert.equal(result.placedOrder, true);
  assert.equal(result.candidateSymbol, "LCID  270115C00010000");
  assert.ok((result.quantity ?? 0) >= 1);
});

test("manageAllocationForGroup skips when there is no candidate and no held fallback", async () => {
  const result = await manageAllocationForGroup(
    "ACC-1",
    buildEvaluation(baseTargets),
    bigBudget,
    1,
    {},
    candidateDeps({
      getTopCandidate: (async () => ({ symbol: undefined, skippedByIvGate: false })) as never,
    }),
  );
  assert.equal(result.skippedReason, "no option candidate found");
});

// Margin ITM fallback: OTM pick fails on spread → retry with ITM selector.
// A stateful getTopCandidate returns the failed OTM on the first call and a
// tradeable ITM strike on the second (strikeTarget: "itm").
function itmFallbackDeps(
  itmCandidate: unknown,
  overrides: Partial<ManageAllocationDependencies> = {},
): ManageAllocationDependencies {
  let call = 0;
  return candidateDeps({
    getAccountType: (async () => "margin") as never,
    getTopCandidate: (async (
      _sym: string,
      _side: string,
      _dte: number,
      opts?: { strikeTarget?: string },
    ) => {
      call += 1;
      if (opts?.strikeTarget === "itm") return itmCandidate;
      // OTM first pass: dead-quoted, fails the spread gate.
      return {
        symbol: undefined,
        skippedByIvGate: false,
        skippedReason: "all candidate spreads exceeded max allowed spread (10.00%)",
      };
    }) as never,
    ...overrides,
  });
}

test("margin ITM fallback: retries ITM and buys when eligible + OTM fails on spread", async () => {
  const result = await manageAllocationForGroup(
    "ACC-1",
    buildEvaluation({ ...baseTargets, marginItmFallbackEligible: true }),
    bigBudget,
    1,
    { accountMarginOrCash: "margin" },
    itmFallbackDeps({
      symbol: "ERIC  260717C00008000",
      quoteSymbol: ".ERIC260717C8",
      dte: 3,
      spreadPct: 0.07,
      usedDteFallback: true,
    }),
  );
  assert.equal(result.placedOrder, true);
  assert.equal(result.candidateSymbol, "ERIC  260717C00008000");
});

test("margin ITM fallback: does NOT retry when marginItmFallbackEligible is not set", async () => {
  const result = await manageAllocationForGroup(
    "ACC-1",
    buildEvaluation(baseTargets),
    bigBudget,
    1,
    { accountMarginOrCash: "margin" },
    itmFallbackDeps({ symbol: "ERIC  260717C00008000", dte: 3 }),
  );
  // No ITM retry → the ITM candidate is never selected (falls through to the
  // held-contract fallback / skip instead).
  assert.notEqual(result.candidateSymbol, "ERIC  260717C00008000");
});

// Helper: build a Date at a specific HH:MM in local time (matches how
// getTimeInMinutes interprets currentTime throughout the strategy engine).
function localTimeAt(hours: number, minutes: number, seconds = 0): Date {
  const d = new Date();
  d.setHours(hours, minutes, seconds, 0);
  return d;
}

// isTooCloseToAccumulationCutoff unit tests

test("isTooCloseToAccumulationCutoff: margin — well before cutoff returns false", () => {
  // 12:20 PM PT, cutoff 12:30 PM, 4-min interval → buffer = 8 min
  // 12:30 - 8 = 12:22, and 12:20 < 12:22 → not too close
  const time = localTimeAt(12, 20);
  assert.equal(isTooCloseToAccumulationCutoff(time, "margin", 4 * 60 * 1000), false);
});

test("isTooCloseToAccumulationCutoff: margin — within buffer returns true", () => {
  // 12:25 PM PT, cutoff 12:30, buffer = 8 min → threshold at 12:22 → 12:25 > 12:22
  const time = localTimeAt(12, 25);
  assert.equal(isTooCloseToAccumulationCutoff(time, "margin", 4 * 60 * 1000), true);
});

test("isTooCloseToAccumulationCutoff: margin — exactly at cutoff returns true", () => {
  const time = localTimeAt(12, 30, 17); // 12:30:17 — the JOBY scenario
  assert.equal(isTooCloseToAccumulationCutoff(time, "margin", 4 * 60 * 1000), true);
});

test("isTooCloseToAccumulationCutoff: cash — well before cutoff returns false", () => {
  // 12:50 PM PT, cutoff 1:00 PM, buffer = 8 min → threshold at 12:52 → 12:50 < 12:52
  const time = localTimeAt(12, 50);
  assert.equal(isTooCloseToAccumulationCutoff(time, "cash", 4 * 60 * 1000), false);
});

test("isTooCloseToAccumulationCutoff: cash — within buffer returns true", () => {
  // 12:55 PM PT, cutoff 1:00 PM, buffer = 8 min → threshold at 12:52 → 12:55 > 12:52
  const time = localTimeAt(12, 55);
  assert.equal(isTooCloseToAccumulationCutoff(time, "cash", 4 * 60 * 1000), true);
});

test("manageAllocationForGroup skips when too close to accumulation cutoff", async () => {
  // Simulate 12:25 PM for a margin account (within 2×4-min = 8-min buffer of 12:30 cutoff).
  // BOT_RUN_INTERVAL_MS defaults to 4 min; override via the injected runIntervalMs in
  // isTooCloseToAccumulationCutoff by setting the env var momentarily.
  const savedEnv = process.env.BOT_RUN_INTERVAL_MS;
  process.env.BOT_RUN_INTERVAL_MS = String(4 * 60 * 1000);

  try {
    const tooLate = localTimeAt(12, 25); // within 8-min buffer of 12:30 margin cutoff
    const result = await manageAllocationForGroup(
      "ACC-1",
      buildEvaluation(baseTargets, tooLate),
      bigBudget,
      1,
      { accountMarginOrCash: "margin" },
      candidateDeps(),
    );
    assert.equal(result.placedOrder, false);
    assert.match(
      result.skippedReason ?? "",
      /too close to accumulation cutoff/,
    );
  } finally {
    if (savedEnv === undefined) {
      delete process.env.BOT_RUN_INTERVAL_MS;
    } else {
      process.env.BOT_RUN_INTERVAL_MS = savedEnv;
    }
  }
});

test("manageAllocationForGroup does NOT skip when well before accumulation cutoff", async () => {
  const savedEnv = process.env.BOT_RUN_INTERVAL_MS;
  process.env.BOT_RUN_INTERVAL_MS = String(4 * 60 * 1000);

  try {
    const earlyTime = localTimeAt(10, 0); // 10:00 AM — nowhere near any cutoff
    const result = await manageAllocationForGroup(
      "ACC-1",
      buildEvaluation(baseTargets, earlyTime),
      bigBudget,
      1,
      { accountMarginOrCash: "margin" },
      candidateDeps(),
    );
    // Should have placed an order (guard did not fire)
    assert.equal(result.placedOrder, true);
  } finally {
    if (savedEnv === undefined) {
      delete process.env.BOT_RUN_INTERVAL_MS;
    } else {
      process.env.BOT_RUN_INTERVAL_MS = savedEnv;
    }
  }
});
