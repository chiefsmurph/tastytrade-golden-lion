import test from "node:test";
import assert from "node:assert/strict";
import { closePosition } from "../actions/close-position";
import type { PositionGroupEvaluation } from "../evaluate-position";

// STRATEGY_CLOSE_TICK_INTERVAL_MS — how long each rung of the close chase rests
// before conceding a tick.
//
// The ladder is bounded by TICK GRANULARITY, not by MAX_CLOSE_TICK_MOVES: a typical
// 10c spread with a 5c minimum tick fits only two moves, so "chase for longer" can
// only mean "dwell for longer". Observed 2026-08-03: EOSE ask 0.930 / mid 0.880 /
// bid 0.830 chased in 2 moves and 63 seconds at the 30s default.
//
// The value is bounded because the chase BLOCKS the cycle and overnight reductions
// run sequentially, so an over-large dwell stalls everything behind it.

function makeEvaluation(bid: number, ask: number): PositionGroupEvaluation {
  const snapshot = {
    position: {
      symbol: "EOSE  260821C00003000",
      "underlying-symbol": "EOSE",
      quantity: 1,
      "quantity-direction": "Long",
    },
    currentBidPrice: bid,
    currentAskPrice: ask,
  };
  return {
    groupKey: "EOSE::call",
    underlyingSymbol: "EOSE",
    positions: [snapshot.position],
    positionSnapshots: [snapshot],
    metrics: {
      currentBidPrice: bid,
      currentAskPrice: ask,
      weightedAverageFill: 0.65,
      currentTime: new Date("2026-08-03T17:00:00.000Z"),
      lastActionTime: new Date("2026-08-03T16:00:00.000Z"),
    },
    strategy: "CLOSE_POSITION",
    currentReturn: 0.15,
  } as unknown as PositionGroupEvaluation;
}

/** Runs a never-filling chase and records the dwell requested at each rung. */
async function observedDwells(envValue: string | undefined, urgent = false) {
  const prior = process.env.STRATEGY_CLOSE_TICK_INTERVAL_MS;
  if (envValue === undefined) delete process.env.STRATEGY_CLOSE_TICK_INTERVAL_MS;
  else process.env.STRATEGY_CLOSE_TICK_INTERVAL_MS = envValue;

  const waits: number[] = [];
  let nextId = 1;
  try {
    await closePosition("ACC-1", makeEvaluation(0.83, 0.93), {
      // the timeout handed to the fill-poller IS the dwell for that rung
      checkOrderFilled: async (_a, _o, timeoutMs) => {
        waits.push(timeoutMs);
        return false;
      },
      createOrder: (async () => ({
        order: { id: String(nextId++), status: "Received" },
      })) as never,
      cancelOrder: (async () => ({})) as never,
      tickChaseEnabled: true,
      maxTickMoves: 10,
      isUrgentClose: urgent,
      forceThroughSpreadGate: true,
      accountType: "cash",
      getRegime: () => ({ crashRegime: false }),
    });
  } finally {
    if (prior === undefined) delete process.env.STRATEGY_CLOSE_TICK_INTERVAL_MS;
    else process.env.STRATEGY_CLOSE_TICK_INTERVAL_MS = prior;
  }
  return waits;
}

test("unset -> 30s default (behaviour unchanged)", async () => {
  const waits = await observedDwells(undefined);
  assert.ok(waits.length > 0, "expected the chase to poll at least once");
  assert.ok(waits.every((w) => w === 30_000), `expected all 30000, got ${waits}`);
});

test("blank -> falls back to the default, not 0", async () => {
  // A present-but-blank env var must mean "use the in-code default". Parsing it as 0
  // would make every rung expire instantly and collapse the ladder — the exact
  // failure mode the LIVE_ORDER_STATUSES bug produced.
  const waits = await observedDwells("");
  assert.ok(waits.every((w) => w === 30_000), `expected all 30000, got ${waits}`);
});

test("60s is honoured", async () => {
  const waits = await observedDwells("60000");
  assert.ok(waits.every((w) => w === 60_000), `expected all 60000, got ${waits}`);
});

test("out-of-range values are rejected in favour of the default", async () => {
  for (const bad of ["0", "-5000", "999999", "abc"]) {
    const waits = await observedDwells(bad);
    assert.ok(
      waits.every((w) => w === 30_000),
      `"${bad}" should fall back to 30000, got ${waits}`,
    );
  }
});

test("the ladder is only 2 moves on a 10c spread — dwell is the only lever", async () => {
  // ask 0.93 / bid 0.83, minTick 0.05 => rungs at 0.93, 0.88, 0.83.
  // Confirms raising maxTickMoves cannot lengthen the chase.
  const waits = await observedDwells("30000");
  assert.ok(
    waits.length <= 3,
    `expected at most 3 rungs from tick granularity, got ${waits.length}`,
  );
});
