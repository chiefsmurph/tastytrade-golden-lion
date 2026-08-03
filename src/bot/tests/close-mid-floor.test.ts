import test from "node:test";
import assert from "node:assert/strict";
import { closePosition } from "../actions/close-position";
import type { PositionGroupEvaluation } from "../evaluate-position";

// STRATEGY_CLOSE_MID_FLOOR_ENABLED — opt-in floor that stops a NON-URGENT sell chase
// at the midpoint instead of conceding to the bid.
//
// Context (2026-08-03): closes were landing on the bid because the tick-chase never
// waited at a rung. That is fixed separately. This floor is the belt-and-braces
// version — it caps how much of the spread a non-forced close can give away at all.
// It must NEVER apply to a hard-risk close: an unfilled EOD liquidation or stop is a
// far worse outcome than a conceded spread.
//
// These assert the PRICE LADDER the chase posts, which is the observable that
// mattered on the day — the broker showed 0.82 / 0.77 / 0.73 for EOSE, i.e. exactly
// ask / mid / bid.

type Placed = { limitPrice: number };

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

async function runChase(opts: {
  urgent: boolean;
  floorEnabled: boolean;
  // undefined = no feed at all (the optional-feed case)
  regime?: { crashRegime?: boolean } | null;
}) {
  const prior = process.env.STRATEGY_CLOSE_MID_FLOOR_ENABLED;
  process.env.STRATEGY_CLOSE_MID_FLOOR_ENABLED = opts.floorEnabled ? "true" : "false";
  // default to a benign (non-crash) regime so existing cases exercise the floor
  const stub = opts.regime === undefined ? { crashRegime: false } : opts.regime;

  const placed: Placed[] = [];
  let nextId = 1;
  try {
    await closePosition("ACC-1", makeEvaluation(0.73, 0.82), {
      // never fills, so the chase walks its full ladder and we can read every rung
      checkOrderFilled: async () => false,
      createOrder: (async (_acct: string, payload: { price?: number }) => {
        placed.push({ limitPrice: Number(payload?.price) });
        return { order: { id: String(nextId++), status: "Received" } };
      }) as never,
      cancelOrder: (async () => ({})) as never,
      tickChaseEnabled: true,
      tickIntervalMs: 1,
      urgentTickIntervalMs: 1,
      maxTickMoves: 10,
      isUrgentClose: opts.urgent,
      forceThroughSpreadGate: true,
      accountType: "cash",
      getRegime: () => stub,
    });
  } finally {
    if (prior === undefined) delete process.env.STRATEGY_CLOSE_MID_FLOOR_ENABLED;
    else process.env.STRATEGY_CLOSE_MID_FLOOR_ENABLED = prior;

  }
  return placed.map((p) => p.limitPrice).filter((n) => Number.isFinite(n));
}

test("floor OFF (default): a non-urgent sell still walks all the way to the bid", async () => {
  const rungs = await runChase({ urgent: false, floorEnabled: false });
  assert.ok(rungs.length > 0, "expected the chase to post at least one order");
  const lowest = Math.min(...rungs);
  assert.ok(
    Math.abs(lowest - 0.73) < 1e-6,
    `default behaviour must be unchanged — expected to reach the bid 0.73, got ${lowest}`,
  );
});

test("floor ON: a non-urgent sell stops at mid and never reaches the bid", async () => {
  const rungs = await runChase({ urgent: false, floorEnabled: true });
  assert.ok(rungs.length > 0);
  const lowest = Math.min(...rungs);

  // The point of the floor: the bid is never posted.
  assert.ok(
    lowest > 0.73 + 1e-9,
    `must never reach the bid 0.73 — got ${lowest} (rungs ${JSON.stringify(rungs)})`,
  );

  // And it lands ON mid. (bid+ask)/2 is 0.7749999... in float, and the limit price is
  // sent to 2dp, so the posted rung reads 0.77 — one cent of rounding, not a concession.
  const mid = (0.73 + 0.82) / 2;
  assert.ok(
    lowest >= mid - 0.011,
    `expected the floor at mid ~${mid.toFixed(4)} (0.77 after 2dp rounding), got ${lowest}`,
  );
});

test("floor ON but URGENT: still reaches the bid — a hard-risk close must clear", async () => {
  const rungs = await runChase({ urgent: true, floorEnabled: true });
  assert.ok(rungs.length > 0);
  const lowest = Math.min(...rungs);
  assert.ok(
    Math.abs(lowest - 0.73) < 1e-6,
    `urgent closes must ignore the floor and reach the bid 0.73, got ${lowest}`,
  );
});

test("floor ON but CRASH regime: stands down and reaches the bid", async () => {
  const rungs = await runChase({
    urgent: false,
    floorEnabled: true,
    regime: { crashRegime: true },
  });
  const lowest = Math.min(...rungs);
  assert.ok(
    Math.abs(lowest - 0.73) < 1e-6,
    `a crash regime must stand the floor down and clear at the bid, got ${lowest}`,
  );
});

test("floor ON but NO FEED: stands down — never depend on an optional feed to clear", async () => {
  const rungs = await runChase({ urgent: false, floorEnabled: true, regime: null });
  const lowest = Math.min(...rungs);
  assert.ok(
    Math.abs(lowest - 0.73) < 1e-6,
    `absent regime must fail toward today's behaviour (walk to bid), got ${lowest}`,
  );
});

test("floor ON, mild down-regime is NOT a crash: floor still holds at mid", async () => {
  // regimeMarginMult sat at 0.740 median on 2026-08-03. That is an ordinary down
  // tape, not a crash, and is exactly when conceding the spread costs most.
  const rungs = await runChase({
    urgent: false,
    floorEnabled: true,
    regime: { crashRegime: false },
  });
  const lowest = Math.min(...rungs);
  assert.ok(lowest > 0.73 + 1e-9, `should not reach the bid, got ${lowest}`);
});
