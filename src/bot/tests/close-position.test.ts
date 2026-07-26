import test from "node:test";
import assert from "node:assert/strict";

import { closePosition, shouldSkipClosePositionForMorningSpread } from "../actions/close-position";
import type { PositionGroupEvaluation } from "../evaluate-position";

function buildEvaluation(
  currentTime: string,
  overrides: Partial<PositionGroupEvaluation> = {},
): PositionGroupEvaluation {
  return {
    currentReturn: 0.02,
    executionTargets: undefined,
    groupKey: "AAPL::call",
    metrics: {
      currentAskPrice: 1.08,
      currentBidPrice: 1.00,
      currentTime: new Date(currentTime),
      lastActionTime: new Date("2026-06-25T05:30:00"),
      weightedAverageFill: 1,
    },
    positionSnapshots: [
      {
        currentAskPrice: 1.08,
        currentBidPrice: 1.00,
        lastActionTime: new Date("2026-06-25T05:30:00"),
        position: {
          "account-number": "ACC-1",
          "instrument-type": "Option",
          quantity: 1,
          symbol: "AAPL   260619C00100000",
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
        symbol: "AAPL   260619C00100000",
      },
    ] as PositionGroupEvaluation["positions"],
    strategy: {
      action: "CLOSE_POSITION",
      reason: "test",
    },
    underlyingSymbol: "AAPL",
    ...overrides,
  };
}

test("shouldSkipClosePositionForMorningSpread skips wide spreads early in the morning", () => {
  const evaluation = buildEvaluation("2026-06-25T06:30:00", {
    metrics: {
      currentAskPrice: 1.12,
      currentBidPrice: 1.00,
      currentTime: new Date("2026-06-25T06:30:00"),
      lastActionTime: new Date("2026-06-25T05:30:00"),
      weightedAverageFill: 1,
    },
  });

  const result = shouldSkipClosePositionForMorningSpread(evaluation);

  assert.equal(result.shouldSkip, true);
  assert.match(result.skippedReason ?? "", /Morning spread gate active/);
});

test("shouldSkipClosePositionForMorningSpread relaxes the threshold later in the morning", () => {
  const evaluation = buildEvaluation("2026-06-25T06:45:00", {
    metrics: {
      currentAskPrice: 1.08,
      currentBidPrice: 1.00,
      currentTime: new Date("2026-06-25T06:45:00"),
      lastActionTime: new Date("2026-06-25T05:30:00"),
      weightedAverageFill: 1,
    },
  });

  const result = shouldSkipClosePositionForMorningSpread(evaluation);

  assert.equal(result.shouldSkip, false);
});

test("shouldSkipClosePositionForMorningSpread allows a strong bid through the gate", () => {
  const evaluation = buildEvaluation("2026-06-25T06:30:00", {
    metrics: {
      currentAskPrice: 1.55,
      currentBidPrice: 1.45,
      currentTime: new Date("2026-06-25T06:30:00"),
      lastActionTime: new Date("2026-06-25T05:30:00"),
      weightedAverageFill: 1,
    },
  });

  const result = shouldSkipClosePositionForMorningSpread(evaluation);

  assert.equal(result.shouldSkip, false);
});

test("shouldSkipClosePositionForMorningSpread still gates a losing wide-spread close mid-morning (LCID 2026-07-02)", () => {
  // Production shape: fill 0.61, bid 0.42 / ask 0.56 → 28.57% spread, -31% bid return at 07:46
  const evaluation = buildEvaluation("2026-06-25T07:46:00", {
    metrics: {
      currentAskPrice: 0.56,
      currentBidPrice: 0.42,
      currentTime: new Date("2026-06-25T07:46:00"),
      lastActionTime: new Date("2026-06-25T05:30:00"),
      weightedAverageFill: 0.61,
    },
  });

  const result = shouldSkipClosePositionForMorningSpread(evaluation);

  assert.equal(result.shouldSkip, true);
  assert.match(result.skippedReason ?? "", /Morning spread gate active/);
});

test("shouldSkipClosePositionForMorningSpread never blocks closes at or after 12:55 EOD liquidation", () => {
  // Production shape from margin.ndjson: 55%+ spread blocked the 12:55 liquidation
  const evaluation = buildEvaluation("2026-06-25T12:55:00", {
    metrics: {
      currentAskPrice: 1.77,
      currentBidPrice: 1.00,
      currentTime: new Date("2026-06-25T12:55:00"),
      lastActionTime: new Date("2026-06-25T05:30:00"),
      weightedAverageFill: 1.55,
    },
  });

  const result = shouldSkipClosePositionForMorningSpread(evaluation);

  assert.equal(result.shouldSkip, false);
});

test("closePosition places EOD orders even when the spread is wide", async () => {
  const evaluation = buildEvaluation("2026-06-25T12:56:00", {
    metrics: {
      currentAskPrice: 1.77,
      currentBidPrice: 1.00,
      currentTime: new Date("2026-06-25T12:56:00"),
      lastActionTime: new Date("2026-06-25T05:30:00"),
      weightedAverageFill: 1.55,
    },
  });

  let createOrderCalls = 0;
  const results = await closePosition("ACC-1", evaluation, {
    createOrder: async () => {
      createOrderCalls += 1;
      return { order: { id: "1" } } as never;
    },
    checkOrderFilled: async () => true,
  });

  assert.equal(createOrderCalls, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.placedOrder, true);
});

test("closePosition records a skip (does not throw) when order placement is rejected", async () => {
  // Regression: a stale/phantom position produced a 422 on the sell-to-close that was
  // uncaught and crashed the whole cash cycle. A placement rejection must degrade to a
  // placedOrder:false skip, not a throw, and must not decrement/claim a close.
  const evaluation = buildEvaluation("2026-06-25T12:56:00", {
    metrics: {
      currentAskPrice: 1.77,
      currentBidPrice: 1.0,
      currentTime: new Date("2026-06-25T12:56:00"),
      lastActionTime: new Date("2026-06-25T05:30:00"),
      weightedAverageFill: 1.55,
    },
  });

  let createOrderCalls = 0;
  const results = await closePosition("ACC-1", evaluation, {
    createOrder: async () => {
      createOrderCalls += 1;
      throw new Error("Request failed with status code 422");
    },
    checkOrderFilled: async () => true,
  });

  assert.equal(createOrderCalls, 1); // rejected on first attempt -> stops chasing
  assert.equal(results.length, 1);
  assert.equal(results[0]?.placedOrder, false);
  assert.match(results[0]?.skippedReason ?? "", /rejected/);
});

test("closePosition skips all order placement when the morning gate is active", async () => {
  const evaluation = buildEvaluation("2026-06-25T06:30:00", {
    metrics: {
      currentAskPrice: 1.12,
      currentBidPrice: 1.00,
      currentTime: new Date("2026-06-25T06:30:00"),
      lastActionTime: new Date("2026-06-25T05:30:00"),
      weightedAverageFill: 1,
    },
  });

  let createOrderCalls = 0;
  const results = await closePosition("ACC-1", evaluation, {
    createOrder: async () => {
      createOrderCalls += 1;
      return {} as never;
    },
  });

  assert.equal(createOrderCalls, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.placedOrder, false);
  assert.match(results[0]?.skippedReason ?? "", /Morning spread gate active/);
});

test("closePosition forceThroughSpreadGate bypasses the morning gate (manual bailout)", async () => {
  // Mirrors the stranded-EOSE case: a wide-spread group whose current action is
  // MANAGE_ALLOCATION (so the execution-time flip re-check is not in play), which
  // the morning gate would normally block. An operator close (bot:closePosition)
  // sets forceThroughSpreadGate to flatten it anyway.
  const evaluation = buildEvaluation("2026-06-25T06:30:00", {
    metrics: {
      currentAskPrice: 1.12,
      currentBidPrice: 1.00,
      currentTime: new Date("2026-06-25T06:30:00"),
      lastActionTime: new Date("2026-06-25T05:30:00"),
      weightedAverageFill: 1,
    },
    strategy: { action: "MANAGE_ALLOCATION", reason: "test" },
  });

  let createOrderCalls = 0;
  const results = await closePosition("ACC-1", evaluation, {
    forceThroughSpreadGate: true,
    createOrder: async () => {
      createOrderCalls += 1;
      return { order: { id: "1" } } as never;
    },
    checkOrderFilled: async () => true,
  });

  assert.equal(createOrderCalls, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.placedOrder, true);
});

test("closePosition chases sell-to-close from midpoint down to bid", async () => {
  // Fill 1.6 vs bid 1.0 → -37.5%: the stop trigger holds at execution-time
  // prices, so the re-check confirms the close and the chase proceeds.
  const evaluation = buildEvaluation("2026-06-25T09:30:00", {
    metrics: {
      currentAskPrice: 1.2,
      currentBidPrice: 1,
      currentTime: new Date("2026-06-25T09:30:00"),
      lastActionTime: new Date("2026-06-25T05:30:00"),
      weightedAverageFill: 1.6,
    },
    positionSnapshots: [
      {
        currentAskPrice: 1.2,
        currentBidPrice: 1,
        lastActionTime: new Date("2026-06-25T05:30:00"),
        position: {
          "account-number": "ACC-1",
          "instrument-type": "Option",
          quantity: 1,
          symbol: "AAPL   260619C00100000",
        },
        quantityWeight: 1,
        weightedAverageFill: 1.6,
      },
    ],
  });

  const submittedPrices: string[] = [];
  const cancelledOrderIds: number[] = [];

  const results = await closePosition("ACC-1", evaluation, {
    createOrder: async (_accountNumber, order) => {
      submittedPrices.push(String((order as { price?: string }).price ?? ""));
      return {
        order: {
          id: String(submittedPrices.length),
        },
      } as never;
    },
    cancelOrder: async (_accountNumber, orderId) => {
      cancelledOrderIds.push(orderId);
      return {} as never;
    },
    checkOrderFilled: async () => false,
    tickIntervalMs: 1,
    maxTickMoves: 2,
  });

  // Sell chase now starts HIGH (ask 1.20) and walks down to the bid (1.00) over
  // maxTickMoves=2 → tick 0.10: 1.20, 1.10, 1.00. (Was mid-start 1.10/1.05/1.00.)
  assert.deepEqual(submittedPrices, ["1.20", "1.10", "1.00"]);
  assert.deepEqual(cancelledOrderIds, ["1", "2"].map(Number));
  assert.equal(results.length, 1);
  assert.equal(results[0]?.placedOrder, true);
});

test("closePosition stops chasing when a cancel cannot be confirmed (no double-sell)", async () => {
  const evaluation = buildEvaluation("2026-06-25T09:30:00", {
    metrics: {
      currentAskPrice: 1.2,
      currentBidPrice: 1,
      currentTime: new Date("2026-06-25T09:30:00"),
      lastActionTime: new Date("2026-06-25T05:30:00"),
      weightedAverageFill: 1.6,
    },
    positionSnapshots: [
      {
        currentAskPrice: 1.2,
        currentBidPrice: 1,
        lastActionTime: new Date("2026-06-25T05:30:00"),
        position: {
          "account-number": "ACC-1",
          "instrument-type": "Option",
          quantity: 1,
          symbol: "AAPL   260619C00100000",
        },
        quantityWeight: 1,
        weightedAverageFill: 1.6,
      },
    ],
  });

  const submittedPrices: string[] = [];

  const results = await closePosition("ACC-1", evaluation, {
    createOrder: async (_accountNumber, order) => {
      submittedPrices.push(String((order as { price?: string }).price ?? ""));
      return { order: { id: String(submittedPrices.length) } } as never;
    },
    cancelOrder: async () => {
      throw new Error("cancel rejected");
    },
    checkOrderFilled: async () => false,
    tickIntervalMs: 1,
    maxTickMoves: 2,
  });

  // One order placed at the ask (start-high sell chase); the failed cancel must
  // break the chase before a second sell goes live against the still-working first.
  assert.deepEqual(submittedPrices, ["1.20"]);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.placedOrder, true);
});

test("closePosition skips the close when the strategy flips to MANAGE_ALLOCATION at execution-time prices", async () => {
  // Stop-loss fired at cycle start, but by execution the position has
  // recovered to -5% (fill 1.0, bid 0.95) — no circuit breaker holds at these
  // prices, so the stale trigger must not sell the position.
  const evaluation = buildEvaluation("2026-06-25T09:30:00", {
    metrics: {
      currentAskPrice: 1.05,
      currentBidPrice: 0.95,
      currentTime: new Date("2026-06-25T09:30:00"),
      lastActionTime: new Date("2026-06-25T05:30:00"),
      weightedAverageFill: 1,
    },
    positionSnapshots: [
      {
        currentAskPrice: 1.05,
        currentBidPrice: 0.95,
        lastActionTime: new Date("2026-06-25T05:30:00"),
        position: {
          "account-number": "ACC-1",
          "instrument-type": "Option",
          quantity: 1,
          symbol: "AAPL   260619C00100000",
        },
        quantityWeight: 1,
        weightedAverageFill: 1,
      },
    ],
    strategy: {
      action: "CLOSE_POSITION",
      reason: "Hit absolute loss limit (-30.00% <= -30%) - stop loss triggered",
    },
  });

  let createOrderCalls = 0;
  const results = await closePosition("ACC-1", evaluation, {
    createOrder: async () => {
      createOrderCalls += 1;
      return { order: { id: "1" } } as never;
    },
    checkOrderFilled: async () => true,
  });

  assert.equal(createOrderCalls, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.placedOrder, false);
  assert.match(
    results[0]?.skippedReason ?? "",
    /strategy flipped to MANAGE_ALLOCATION at execution time/,
  );
});

test("closePosition never re-checks EOD liquidations — recovered prices still close at 12:55+", async () => {
  // Same recovered shape that flips the re-check above, but the close was
  // decided in the EOD forced-liquidation window: the clock, not the price,
  // is the trigger, so the order must go out regardless.
  const evaluation = buildEvaluation("2026-06-25T12:56:00", {
    metrics: {
      currentAskPrice: 1.05,
      currentBidPrice: 0.95,
      currentTime: new Date("2026-06-25T12:56:00"),
      lastActionTime: new Date("2026-06-25T05:30:00"),
      weightedAverageFill: 1,
    },
    positionSnapshots: [
      {
        currentAskPrice: 1.05,
        currentBidPrice: 0.95,
        lastActionTime: new Date("2026-06-25T05:30:00"),
        position: {
          "account-number": "ACC-1",
          "instrument-type": "Option",
          quantity: 1,
          symbol: "AAPL   260619C00100000",
        },
        quantityWeight: 1,
        weightedAverageFill: 1,
      },
    ],
    strategy: {
      action: "CLOSE_POSITION",
      reason: "Market closed or closing - liquidate all positions immediately",
    },
  });

  let createOrderCalls = 0;
  const results = await closePosition("ACC-1", evaluation, {
    createOrder: async () => {
      createOrderCalls += 1;
      return { order: { id: "1" } } as never;
    },
    checkOrderFilled: async () => true,
  });

  assert.equal(createOrderCalls, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.placedOrder, true);
});