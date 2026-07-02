import test from "node:test";
import assert from "node:assert/strict";

import { closePosition, shouldSkipClosePositionForMorningSpread } from "../actions/close-position";
import type { PositionGroupEvaluation } from "../evaluate-position";
import type { ExecutionTargets } from "~/strategy/evaluate-trading-strategy";

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

const closingTargets: ExecutionTargets = {
  askWeight: 0.1,
  bidWeight: 0.7,
  midWeight: 0.2,
  targetAccountExposure: 0.4,
  targetDTE: 30,
};

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
  const results = await closePosition("ACC-1", evaluation, closingTargets, {
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

test("closePosition chases sell-to-close from midpoint down to bid", async () => {
  const evaluation = buildEvaluation("2026-06-25T09:30:00", {
    metrics: {
      currentAskPrice: 1.2,
      currentBidPrice: 1,
      currentTime: new Date("2026-06-25T09:30:00"),
      lastActionTime: new Date("2026-06-25T05:30:00"),
      weightedAverageFill: 1,
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
        weightedAverageFill: 1,
      },
    ],
  });

  const submittedPrices: string[] = [];
  const cancelledOrderIds: number[] = [];

  const results = await closePosition("ACC-1", evaluation, closingTargets, {
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

  assert.deepEqual(submittedPrices, ["1.10", "1.05", "1.00"]);
  assert.deepEqual(cancelledOrderIds, ["1", "2"].map(Number));
  assert.equal(results.length, 1);
  assert.equal(results[0]?.placedOrder, true);
});