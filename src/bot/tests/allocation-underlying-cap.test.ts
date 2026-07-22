import test from "node:test";
import assert from "node:assert/strict";

import {
  clampRouteOrdersToMaxTotalQuantity,
  manageAllocationForGroup,
  type AllocationBudget,
  type AllocationRouteResult,
  type ManageAllocationDependencies,
} from "../actions/manage-allocation";
import { getGroupContractCount } from "../actions/order-utils";
import {
  getMaxUnderlyingContracts,
  getMaxUnderlyingNotional,
} from "~/strategy/risk-limits";
import type { PositionGroupEvaluation } from "../evaluate-position";
import type { ExecutionTargets } from "~/strategy/evaluate-trading-strategy";

// Assign each entry into process.env, deleting keys whose value is undefined.
function setEnv(entries: Iterable<[string, string | undefined]>): void {
  for (const [key, value] of entries) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

// The dev .env can leak into tests through the tastytrade-client import chain,
// so every test pins the env keys it depends on and restores them after. The
// callback is awaited so async bodies keep the pinned env past their first
// suspension point.
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = Object.keys(vars).map(
    (key) => [key, process.env[key]] as [string, string | undefined],
  );
  setEnv(Object.entries(vars));
  try {
    return await fn();
  } finally {
    setEnv(previous);
  }
}

const CAP_ENV_UNSET = {
  STRATEGY_MAX_UNDERLYING_CONTRACTS: undefined,
  STRATEGY_MAX_UNDERLYING_NOTIONAL: undefined,
  STRATEGY_MAX_ALLOCATION_BUY_POSITION_MULTIPLE: undefined,
  STRATEGY_CASH_MAX_BUY_EXPOSURE_PCT: "0.05",
};

test("underlying cap getters are off (Infinity) unless set to a positive value", async () => {
  for (const raw of [undefined, "", "   ", "0", "-5", "garbage"]) {
    await withEnv(
      {
        STRATEGY_MAX_UNDERLYING_CONTRACTS: raw,
        STRATEGY_MAX_UNDERLYING_NOTIONAL: raw,
      },
      () => {
        assert.equal(
          getMaxUnderlyingContracts(),
          Infinity,
          `contracts cap should be off for ${JSON.stringify(raw)}`,
        );
        assert.equal(
          getMaxUnderlyingNotional(),
          Infinity,
          `notional cap should be off for ${JSON.stringify(raw)}`,
        );
      },
    );
  }

  await withEnv(
    {
      STRATEGY_MAX_UNDERLYING_CONTRACTS: "15",
      STRATEGY_MAX_UNDERLYING_NOTIONAL: "800.50",
    },
    () => {
      assert.equal(getMaxUnderlyingContracts(), 15);
      assert.equal(getMaxUnderlyingNotional(), 800.5);
    },
  );
});

test("getGroupContractCount sums absolute contract quantities, ignoring the multiplier", () => {
  const snapshots = [
    { position: { quantity: 10, symbol: "A" }, quantityWeight: 1000 },
    { position: { quantity: "5", symbol: "B" }, quantityWeight: 500 },
    { position: { quantity: -2, symbol: "C" }, quantityWeight: 200 },
    { position: { quantity: "not-a-number", symbol: "D" }, quantityWeight: 0 },
  ] as never;
  assert.equal(getGroupContractCount(snapshots), 17);
  assert.equal(getGroupContractCount([]), 0);
});

function buildSizedRoutes(): AllocationRouteResult[] {
  return [
    {
      estimatedOrderValue: 100,
      limitPrice: 1.0,
      placedOrder: false,
      quantity: 1,
      route: "bid",
      weight: 0.2,
    },
    {
      estimatedOrderValue: 330,
      limitPrice: 1.1,
      placedOrder: false,
      quantity: 3,
      route: "mid",
      weight: 0.3,
    },
    {
      estimatedOrderValue: 480,
      limitPrice: 1.2,
      placedOrder: false,
      quantity: 4,
      route: "ask",
      weight: 0.5,
    },
  ];
}

test("clampRouteOrdersToMaxTotalQuantity is a no-op when the cap is unset or already satisfied", () => {
  const untouched = clampRouteOrdersToMaxTotalQuantity(buildSizedRoutes(), Infinity);
  assert.deepEqual(
    untouched.map((r) => r.quantity),
    [1, 3, 4],
  );

  // Exactly at the cap: nothing to trim.
  const atCap = clampRouteOrdersToMaxTotalQuantity(buildSizedRoutes(), 8);
  assert.deepEqual(
    atCap.map((r) => r.quantity),
    [1, 3, 4],
  );
});

test("clampRouteOrdersToMaxTotalQuantity trims the largest route first (ties: lowest weight) and recomputes value", () => {
  const clamped = clampRouteOrdersToMaxTotalQuantity(buildSizedRoutes(), 5);
  // 8 → 5: ask 4→3 (largest), then mid/ask tie at 3 → mid trims (lower weight),
  // then ask 3→2 (largest again).
  assert.deepEqual(
    clamped.map((r) => r.quantity),
    [1, 2, 2],
  );
  assert.equal(
    clamped.reduce((sum, r) => sum + r.quantity, 0),
    5,
  );
  for (const routeOrder of clamped) {
    assert.equal(
      routeOrder.estimatedOrderValue,
      routeOrder.quantity * routeOrder.limitPrice * 100,
      `${routeOrder.route} estimatedOrderValue must track the trimmed quantity`,
    );
  }
});

test("clampRouteOrdersToMaxTotalQuantity zeroes everything at cap 0", () => {
  const clamped = clampRouteOrdersToMaxTotalQuantity(buildSizedRoutes(), 0);
  assert.deepEqual(
    clamped.map((r) => r.quantity),
    [0, 0, 0],
  );
  assert.deepEqual(
    clamped.map((r) => r.estimatedOrderValue),
    [0, 0, 0],
  );
});

// --- End-to-end through manageAllocationForGroup -------------------------

const baseTargets: ExecutionTargets = {
  targetDTE: 21,
  targetAccountExposure: 0.5,
  bidWeight: 0.34,
  midWeight: 0.33,
  askWeight: 0.33,
};

const bigBudget: AllocationBudget = {
  buyingPowerRemaining: 1_000_000,
  portfolioExposure: 0,
  totalCapital: 1_000_000,
};

// A group holding `heldContracts` WEN calls at production-like units
// (quantityWeight = contracts × 100, so market value = bid × contracts × 100).
function buildHolding(
  heldContracts: number,
  bid = 1.0,
  ask = 1.2,
): PositionGroupEvaluation {
  const position = {
    "account-number": "ACC-1",
    "instrument-type": "Equity Option",
    quantity: heldContracts,
    symbol: "WEN   260710C00005000",
  };
  return {
    currentReturn: 0,
    executionTargets: baseTargets,
    groupKey: "WEN::call",
    metrics: {
      currentAskPrice: ask,
      currentBidPrice: bid,
      currentTime: new Date(),
      lastActionTime: new Date(),
      weightedAverageFill: 1,
    },
    positionSnapshots: [
      {
        currentAskPrice: ask,
        currentBidPrice: bid,
        lastActionTime: new Date(),
        position,
        quantityWeight: heldContracts * 100,
        weightedAverageFill: 1,
      },
    ],
    positions: [position] as PositionGroupEvaluation["positions"],
    strategy: { action: "MANAGE_ALLOCATION", reason: "test" },
    underlyingSymbol: "WEN",
  } as PositionGroupEvaluation;
}

const healthyTargets = Array.from({ length: 400 }, (_, i) => i);

function candidateDeps(
  overrides: Partial<ManageAllocationDependencies> = {},
): ManageAllocationDependencies {
  return {
    getOptionHealth: (async () => ({ summary: { healthyTargets } })) as never,
    getAccountType: (async () => "cash") as never,
    getTopCandidate: (async () => ({
      symbol: "WEN   260710C00005000",
      quoteSymbol: ".WEN260710C5",
      dte: 4,
      minDTE: 0,
      maxDTE: 7,
      preferredDTE: 4,
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

async function runAllocation(heldContracts: number) {
  return manageAllocationForGroup(
    "ACC-1",
    buildHolding(heldContracts),
    bigBudget,
    1,
    {},
    candidateDeps(),
  );
}

test("caps unset: sizing is bound only by the existing budget caps (today's behavior)", async () => {
  await withEnv(CAP_ENV_UNSET, async () => {
    const result = await runAllocation(1);
    assert.equal(result.placedOrder, true);
    assert.equal(result.skippedReason, undefined);
    // Per-action cash cap 5% of $1M = $50k at ~$100-120/contract: hundreds of
    // contracts — nothing but the budget caps constrain the add.
    assert.ok(
      (result.quantity ?? 0) > 15,
      `expected an uncapped multi-hundred-contract add, got ${result.quantity}`,
    );
  });
});

test("contract cap skips the group once holdings reach the cap", async () => {
  await withEnv(
    { ...CAP_ENV_UNSET, STRATEGY_MAX_UNDERLYING_CONTRACTS: "15" },
    async () => {
      for (const held of [15, 16]) {
        const result = await runAllocation(held);
        assert.equal(result.placedOrder, false);
        assert.match(
          result.skippedReason ?? "",
          /underlying contract cap reached \(holding \d+ >= max 15\)/,
        );
      }
    },
  );
});

test("contract cap clamps the add exactly at the edge and logs it", async () => {
  await withEnv(
    { ...CAP_ENV_UNSET, STRATEGY_MAX_UNDERLYING_CONTRACTS: "15" },
    async () => {
      const logged: string[] = [];
      const originalLog = console.log;
      console.log = (line?: unknown) => {
        logged.push(String(line));
      };
      try {
        // Holding 14 of a 15-contract cap: the budget wants hundreds, the cap
        // allows exactly one more.
        const result = await runAllocation(14);
        assert.equal(result.placedOrder, true);
        assert.equal(result.quantity, 1);

        const capLines = logged
          .filter((line) => line.includes("allocation-underlying-cap"))
          .map((line) => JSON.parse(line));
        const clampLine = capLines.find((line) => line.action === "clamp-quantity");
        assert.ok(clampLine, "clamping must emit an allocation-underlying-cap log");
        assert.equal(clampLine.clampedQuantity, 1);
        assert.equal(clampLine.heldContracts, 14);
        assert.equal(clampLine.maxUnderlyingContracts, 15);
        assert.ok(clampLine.requestedQuantity > 1);
      } finally {
        console.log = originalLog;
      }
    },
  );
});

test("notional cap bounds total group value (held value + add) and skips at the cap", async () => {
  await withEnv(
    { ...CAP_ENV_UNSET, STRATEGY_MAX_UNDERLYING_NOTIONAL: "800" },
    async () => {
      // 5 contracts at bid 1.00 = $500 held → $300 of headroom.
      const clamped = await runAllocation(5);
      assert.equal(clamped.placedOrder, true);
      const spend = clamped.estimatedOrderValue ?? 0;
      assert.ok(spend > 0, "some headroom remains, so the add must size");
      assert.ok(
        spend <= 300,
        `add must not push group value past the $800 cap (spent $${spend} on $300 headroom)`,
      );

      // 8 contracts at bid 1.00 = $800 held → at the cap: skip, don't add.
      const atCap = await runAllocation(8);
      assert.equal(atCap.placedOrder, false);
      assert.match(
        atCap.skippedReason ?? "",
        /underlying notional cap reached \(position value \$800\.00 >= max \$800\.00\)/,
      );
    },
  );
});

// The 2026-07-06 failure in miniature: with only the buy-position multiple
// set, per-cycle adds compound (each cycle's cap is 3× a base the previous
// cycle just grew). The contract cap bounds the total no matter how many
// cycles run — and because headroom derives only from live holdings, a
// mid-session restart (fresh process, fresh evaluations) cannot re-open it.
async function simulateAccumulation(cycles: number): Promise<{
  held: number;
  peakHeld: number;
  lastSkippedReason?: string;
}> {
  let held = 2;
  let peakHeld = held;
  let lastSkippedReason: string | undefined;

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const result = await runAllocation(held);
    if (result.placedOrder) {
      held += result.quantity ?? 0;
      peakHeld = Math.max(peakHeld, held);
    } else {
      lastSkippedReason = result.skippedReason;
    }
  }

  return { held, peakHeld, lastSkippedReason };
}

test("buy-position multiple alone compounds across cycles (the WEN failure mode)", async () => {
  await withEnv(
    { ...CAP_ENV_UNSET, STRATEGY_MAX_ALLOCATION_BUY_POSITION_MULTIPLE: "3" },
    async () => {
      const { held } = await simulateAccumulation(4);
      assert.ok(
        held > 15,
        `with no absolute cap, compounding adds should blow past 15 contracts (got ${held})`,
      );
    },
  );
});

test("contract cap bounds the compounding series at every step", async () => {
  await withEnv(
    {
      ...CAP_ENV_UNSET,
      STRATEGY_MAX_ALLOCATION_BUY_POSITION_MULTIPLE: "3",
      STRATEGY_MAX_UNDERLYING_CONTRACTS: "15",
    },
    async () => {
      const { held, peakHeld, lastSkippedReason } = await simulateAccumulation(6);
      assert.ok(
        peakHeld <= 15,
        `holdings must never exceed the 15-contract cap (peaked at ${peakHeld})`,
      );
      assert.equal(held, 15, "accumulation converges to exactly the cap");
      assert.match(
        lastSkippedReason ?? "",
        /underlying contract cap reached/,
        "once at the cap, further cycles skip",
      );
    },
  );
});

test("restart safety: headroom derives only from live holdings, so a fresh process cannot re-open accumulation", async () => {
  await withEnv(
    { ...CAP_ENV_UNSET, STRATEGY_MAX_UNDERLYING_CONTRACTS: "15" },
    async () => {
      // 13 contracts were accumulated before an intraday restart. The restarted
      // process rebuilds everything from live broker positions — the cap must
      // see 2 contracts of headroom, not a reset baseline.
      const afterRestart = await runAllocation(13);
      assert.equal(afterRestart.placedOrder, true);
      assert.equal(afterRestart.quantity, 2);

      // And a second identical call gets the same answer: no hidden state was
      // consumed or advanced by the first.
      const again = await runAllocation(13);
      assert.equal(again.quantity, 2);
    },
  );
});
