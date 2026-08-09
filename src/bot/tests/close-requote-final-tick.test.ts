import test from "node:test";
import assert from "node:assert/strict";

import { closePosition } from "../actions/close-position";
import type { PositionGroupEvaluation } from "../evaluate-position";

// STRATEGY_CLOSE_REQUOTE_BEFORE_FINAL_TICK — re-quote once, immediately before the
// chase posts its last rung, and price that rung off the live quote.
//
// Both fixtures are REAL closes from the run ledger (2026-07-06 → 2026-08-07), each
// one of the 7 (of 80) that filled BELOW the bid quoted at the deciding cycle. The
// bid/ask are reconstructed from the recorded weightedAverageOpenFill and the
// bidReturnPctAtCycle / askReturnPctAtCycle, so the ladders below are the ones the
// live engine actually posted. Their median spread was 14.2% — nothing about these is
// a wide-spread problem, so no spread gate could have caught them.
//
// What the assertions are: the exact sequence of limit prices sent to the broker.
// That is the observable — the whole failure was a chase resting on a price the
// market had left.

type PositionOverrides = Record<string, unknown>;

function makeEvaluation(opts: {
  action: "CLOSE_POSITION" | "MANAGE_ALLOCATION";
  ask: number;
  bid: number;
  hours: number;
  minutes: number;
  position?: PositionOverrides;
  symbol: string;
  underlying: string;
  weightedAverageFill: number;
}): PositionGroupEvaluation {
  const currentTime = new Date();
  currentTime.setHours(opts.hours, opts.minutes, 0, 0);
  const position = {
    symbol: opts.symbol,
    "underlying-symbol": opts.underlying,
    quantity: 1,
    "quantity-direction": "Long",
    ...opts.position,
  };
  return {
    groupKey: `${opts.underlying}::call`,
    underlyingSymbol: opts.underlying,
    positions: [position],
    positionSnapshots: [
      {
        position,
        currentBidPrice: opts.bid,
        currentAskPrice: opts.ask,
        weightedAverageFill: opts.weightedAverageFill,
        quantityWeight: 100,
        lastActionTime: new Date(currentTime.getTime() - 45 * 60 * 1000),
      },
    ],
    metrics: {
      currentBidPrice: opts.bid,
      currentAskPrice: opts.ask,
      weightedAverageFill: opts.weightedAverageFill,
      currentTime,
      lastActionTime: new Date(currentTime.getTime() - 45 * 60 * 1000),
    },
    strategy: { action: opts.action, reason: "ledger fixture" },
    currentReturn: (opts.bid - opts.weightedAverageFill) / opts.weightedAverageFill,
  } as unknown as PositionGroupEvaluation;
}

// ERIC 2026-07-15 cash overnight-reduction. Cycle quote 0.350 / 0.4176 (17.6%
// spread) on a 0.4088 basis; it eventually filled at 0.200. Non-urgent, and
// strategy.action is MANAGE_ALLOCATION because an overnight reduction is an
// exposure-driven close, not a stop — which is also what exempts it from the
// execution-time recovery re-check.
const ERIC = {
  action: "MANAGE_ALLOCATION" as const,
  ask: 0.4176,
  bid: 0.35,
  hours: 7,
  minutes: 42,
  symbol: "ERIC  260717C00010000",
  underlying: "ERIC",
  weightedAverageFill: 0.4088235294117647,
};

// WEN 2026-07-08 cash stop-loss, urgent. Cycle quote 0.900 / 1.150 on a 1.375
// basis (bid -34.55%); one leg filled 1.10, the other 0.80 — below the quoted bid.
// A -34.55% bid return re-evaluates to CLOSE_POSITION at every minute of the
// trading day, so the execution-time re-check (which reads the wall clock) cannot
// make this case time-dependent.
const WEN = {
  action: "CLOSE_POSITION" as const,
  ask: 1.15,
  bid: 0.9,
  hours: 8,
  minutes: 1,
  symbol: "WEN   260724C00006500",
  underlying: "WEN",
  weightedAverageFill: 1.375,
};

interface ChaseResult {
  ladder: string[];
  quoteCalls: Array<{ symbol: string; timeoutMs: number }>;
}

const REQUOTE_VAR = "STRATEGY_CLOSE_REQUOTE_BEFORE_FINAL_TICK";
// Fix 1 is a separate switch; keep it off so these ladders stay attributable.
const MID_CONFIRM_VAR = "STRATEGY_STOP_LOSS_REQUIRE_MID_CONFIRM";

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const prior = Object.fromEntries(
    Object.keys(vars).map((key) => [key, process.env[key]]),
  );
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(vars);
  try {
    return await run();
  } finally {
    apply(prior);
  }
}

async function runChase(opts: {
  fixture: typeof ERIC | typeof WEN;
  getBidAsk?: (
    symbol: string,
    timeoutMs: number,
  ) => Promise<{ ask?: number; bid?: number } | null>;
  position?: PositionOverrides;
  requote: boolean;
  urgent: boolean;
}): Promise<ChaseResult> {
  const ladder: string[] = [];
  const quoteCalls: ChaseResult["quoteCalls"] = [];
  let nextId = 1;

  await withEnv(
    {
      [REQUOTE_VAR]: opts.requote ? "true" : "false",
      [MID_CONFIRM_VAR]: undefined,
    },
    () =>
      closePosition(
        "5WU18519",
        makeEvaluation({ ...opts.fixture, position: opts.position }),
        {
          // never fills, so the chase walks its full ladder and every rung is visible
          checkOrderFilled: async () => false,
          createOrder: (async (_acct: string, payload: { price?: string }) => {
            ladder.push(String(payload?.price));
            return { order: { id: String(nextId++), status: "Received" } };
          }) as never,
          cancelOrder: (async () => ({})) as never,
          getBidAsk: async (symbol: string, timeoutMs: number) => {
            quoteCalls.push({ symbol, timeoutMs });
            return opts.getBidAsk ? opts.getBidAsk(symbol, timeoutMs) : null;
          },
          tickChaseEnabled: true,
          tickIntervalMs: 1,
          urgentTickIntervalMs: 1,
          maxTickMoves: 10,
          isUrgentClose: opts.urgent,
          forceThroughSpreadGate: true,
          accountType: "cash",
          getRegime: () => ({ crashRegime: false }),
        },
      ),
  );

  // Invariant on every case, not just the ones that assert a ladder. The unusable
  // quotes below (null, {}, NaN) reach the edge maths as a 0/0 book, and the guards
  // that stop that becoming a real edge are individually redundant — collectively
  // they are the only thing between a dropped quote and a sell posted at 0.00.
  for (const rung of ladder) {
    assert.ok(
      Number(rung) > 0,
      `chase posted a non-positive limit price: ${JSON.stringify(ladder)}`,
    );
  }
  return { ladder, quoteCalls };
}

// The ladders the engine posts today, off the cycle-start snapshot alone.
const ERIC_STALE_LADDER = ["0.42", "0.37", "0.35"];
const WEN_STALE_LADDER = ["1.13", "1.08", "1.02", "0.97", "0.92", "0.90"];

test("pref absent entirely: the cycle-start ladder, and no quote call at all", async () => {
  // runChase writes an explicit "false"; this covers the var never being set.
  await withEnv({ [REQUOTE_VAR]: undefined, [MID_CONFIRM_VAR]: undefined }, async () => {
    const ladder: string[] = [];
    let quoteCalls = 0;
    await closePosition("5WU18519", makeEvaluation(ERIC), {
      checkOrderFilled: async () => false,
      createOrder: (async (_acct: string, payload: { price?: string }) => {
        ladder.push(String(payload?.price));
        return { order: { id: "1", status: "Received" } };
      }) as never,
      cancelOrder: (async () => ({})) as never,
      getBidAsk: async () => {
        quoteCalls += 1;
        return { ask: 0.26, bid: 0.2 };
      },
      tickChaseEnabled: true,
      tickIntervalMs: 1,
      maxTickMoves: 10,
      forceThroughSpreadGate: true,
      accountType: "cash",
      getRegime: () => ({ crashRegime: false }),
    });
    assert.deepEqual(ladder, ERIC_STALE_LADDER);
    assert.equal(quoteCalls, 0, "an unset pref must not cost a broker call");
  });
});

test("pref off: WEN's urgent ladder ends on the stale bid the market had left", async () => {
  const wen = await runChase({ fixture: WEN, requote: false, urgent: true });
  assert.deepEqual(wen.ladder, WEN_STALE_LADDER);
  assert.equal(wen.ladder.at(-1), "0.90", "rests on the cycle bid");
  assert.equal(wen.quoteCalls.length, 0);
});

test("pref on: ERIC's last rung reaches the live bid it actually filled at", async () => {
  const eric = await runChase({
    fixture: ERIC,
    requote: false,
    urgent: false,
  });
  assert.deepEqual(eric.ladder, ERIC_STALE_LADDER, "control");

  const fresh = await runChase({
    fixture: ERIC,
    requote: true,
    urgent: false,
    // the market by the time the chase reached its last rung
    getBidAsk: async () => ({ ask: 0.26, bid: 0.2 }),
  });
  assert.equal(
    fresh.ladder.at(-1),
    "0.20",
    "the final rung must be the live bid, which is where this close actually filled",
  );
  assert.deepEqual(
    fresh.ladder.slice(0, 2),
    ERIC_STALE_LADDER.slice(0, 2),
    "the rungs before the last one are unchanged — this only re-prices the end of the walk",
  );
  assert.equal(fresh.quoteCalls.length, 1, "exactly one extra broker quote per leg");
});

test("pref on: WEN's urgent chase follows the market down to 0.80", async () => {
  const fresh = await runChase({
    fixture: WEN,
    requote: true,
    urgent: true,
    getBidAsk: async () => ({ ask: 0.9, bid: 0.8 }),
  });
  assert.equal(fresh.ladder.at(-1), "0.80", "the price this leg actually filled at");
  assert.deepEqual(
    fresh.ladder.slice(0, 5),
    WEN_STALE_LADDER.slice(0, 5),
    "unchanged until the rung that would have landed on the stale bid",
  );
  assert.ok(
    fresh.ladder.length <= 11,
    `chase must stay inside its move budget, got ${fresh.ladder.length} rungs`,
  );
});

test("pref on: the quote is pulled on the dxLink STREAMER symbol, not the OCC symbol", async () => {
  const fresh = await runChase({
    fixture: ERIC,
    requote: true,
    urgent: false,
    position: { "streamer-symbol": ".ERIC260717C10" },
    getBidAsk: async () => ({ ask: 0.26, bid: 0.2 }),
  });
  assert.deepEqual(
    fresh.quoteCalls.map((call) => call.symbol),
    [".ERIC260717C10"],
    "an OCC-symbol lookup returns no quote at all",
  );
  assert.ok(fresh.quoteCalls[0].timeoutMs > 0);
});

test("pref on: a sell edge may only move DOWN — a rallied quote never retracts a concession", async () => {
  const fresh = await runChase({
    fixture: WEN,
    requote: true,
    urgent: true,
    // market rallied well above the stale bid
    getBidAsk: async () => ({ ask: 1.4, bid: 1.3 }),
  });
  assert.deepEqual(
    fresh.ladder,
    WEN_STALE_LADDER,
    "raising a resting sell mid-chase risks the unfilled hard-risk close the urgent path exists to prevent",
  );
  assert.equal(fresh.quoteCalls.length, 1, "it still asked — it just declined to act");
});

test("pref on: an unusable or failed quote leaves the ladder exactly as today", async () => {
  for (const [label, getBidAsk] of [
    ["null quote", async () => null],
    ["empty quote", async () => ({})],
    ["zero bid and ask", async () => ({ ask: 0, bid: 0 })],
    ["non-numeric", async () => ({ ask: Number.NaN, bid: Number.NaN })],
    [
      "throws",
      async () => {
        throw new Error("dxlink timeout");
      },
    ],
  ] as Array<[string, () => Promise<{ ask?: number; bid?: number } | null>]>) {
    const fresh = await runChase({
      fixture: WEN,
      requote: true,
      urgent: true,
      getBidAsk,
    });
    assert.deepEqual(fresh.ladder, WEN_STALE_LADDER, label);
  }
});
