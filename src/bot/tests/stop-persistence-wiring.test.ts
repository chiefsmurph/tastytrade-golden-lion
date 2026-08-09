import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import tastytradeApi from "~/core/tastytrade-client";
import type { CurrentPosition } from "~/core/types";
import { evaluatePositionGroup } from "~/bot/evaluate-position";

// The seam between the strategy engine (stateless) and the persisted streak.
// Everything else about persistence is unit-tested either side of this file; what
// only shows up here is whether one cycle's verdict actually reaches the next one,
// and whether the two accounts stay apart while it does.

const CYCLE_MS = 4 * 60 * 1000;

// ONE TIME BASE, and it is LOCAL — `cycleTime` below builds the simulated cycle
// clock in local time because the engine reads time-of-day off getHours(), and
// evaluate-position turns `updated-at` straight into metrics.lastActionTime. The
// `"2026-08-08T12:00:00Z"` literal this replaced was read as 05:00 in PT but
// 15:00 in MSK and 21:00 in JST, i.e. AFTER the simulated 09:30 cycle: elapsed
// went negative, the engine short-circuited on "Still in cooldown period
// (-330.0 min < 10 min)", and every stop assertion in this file failed with the
// strategy parked on MANAGE_ALLOCATION in any zone east of UTC.
//
// 08:00 keeps the last action a comfortable 90 minutes before cycle 0, so the
// 10-minute cooldown is never what this file is measuring.
const POSITION_UPDATED_AT = "2026-08-08T08:00:00";
const FIRST_CYCLE_AT = new Date(2026, 7, 8, 9, 30, 0, 0);

function positionFor(underlying: string, averageOpenPrice: number): CurrentPosition {
  return {
    "account-number": "TEST",
    "average-open-price": averageOpenPrice,
    "instrument-type": "Equity Option",
    multiplier: 100,
    quantity: 3,
    "streamer-symbol": `.${underlying}260814C12`,
    symbol: `${underlying}  260814C00012000`,
    "underlying-symbol": underlying,
    "updated-at": POSITION_UPDATED_AT,
  } as unknown as CurrentPosition;
}

function cycleTime(index: number): Date {
  return new Date(FIRST_CYCLE_AT.getTime() + index * CYCLE_MS);
}

async function withHarness(
  run: (setQuote: (bid: number, ask: number) => void) => Promise<void>,
): Promise<void> {
  const dir = path.join(
    os.tmpdir(),
    `stop-wiring-${process.pid}-${process.hrtime.bigint()}`,
  );
  const priorDir = process.env.BOT_DATA_DIR;
  const priorInterval = process.env.BOT_RUN_INTERVAL_MS;
  const priorGetBidAsk = tastytradeApi.johnsService.getBidAskForSymbol;
  process.env.BOT_DATA_DIR = dir;
  process.env.BOT_RUN_INTERVAL_MS = String(CYCLE_MS);

  let quote = { ask: 0, bid: 0 };
  tastytradeApi.johnsService.getBidAskForSymbol = (async () =>
    quote) as typeof priorGetBidAsk;

  try {
    await run((bid, ask) => {
      quote = { ask, bid };
    });
  } finally {
    tastytradeApi.johnsService.getBidAskForSymbol = priorGetBidAsk;
    if (priorDir === undefined) delete process.env.BOT_DATA_DIR;
    else process.env.BOT_DATA_DIR = priorDir;
    if (priorInterval === undefined) delete process.env.BOT_RUN_INTERVAL_MS;
    else process.env.BOT_RUN_INTERVAL_MS = priorInterval;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// CLSK 2026-07-28 cash: bid -40.17% / mid -36.75%. Clears both the bid floor and
// the midpoint confirmation, so persistence is the last gate standing.
const STOPPING = { ask: 0.78, bid: 0.7 };
const RECOVERED = { ask: 1.2, bid: 1.1 };
const WAF = 1.17;

/**
 * One evaluation of the CLSK group at the given cycle index. Asserts the group
 * evaluated at all, so a null never reaches an assertion as a silent `undefined`
 * that happens not to equal "CLOSE_POSITION".
 */
async function evaluateAtCycle(cycleIndex: number, accountType = "cash" as const) {
  const evaluation = await evaluatePositionGroup(
    [positionFor("CLSK", WAF)],
    cycleTime(cycleIndex),
    accountType,
  );
  assert.ok(evaluation, `cycle ${cycleIndex} produced no evaluation at all`);
  return evaluation.strategy;
}

// The premise every case below rests on: the engine's 10-minute cooldown check
// runs BEFORE the stop floor, so if `updated-at` and the cycle clock are not on
// the same time base these tests stop measuring persistence and start measuring
// the cooldown — silently, with the strategy parked on MANAGE_ALLOCATION.
test("premise: the fixture's last action is well before cycle 0, in any timezone", () => {
  const elapsedMinutes =
    (cycleTime(0).getTime() - Date.parse(POSITION_UPDATED_AT)) / 60_000;
  assert.ok(
    elapsedMinutes >= 60,
    `updated-at must precede the first cycle by more than the 10-min cooldown; got ${elapsedMinutes} min — is one of them a "...Z" literal?`,
  );
});

test("the first cycle holds, the second closes", async () => {
  await withHarness(async (setQuote) => {
    setQuote(STOPPING.bid, STOPPING.ask);
    const positions = [positionFor("CLSK", WAF)];

    const first = await evaluatePositionGroup(positions, cycleTime(0), "cash");
    assert.equal(first?.groupKey, "CLSK::call");
    assert.equal(first?.strategy.action, "MANAGE_ALLOCATION");
    assert.equal(first?.strategy.suppressAdds, true);

    const second = await evaluatePositionGroup(positions, cycleTime(1), "cash");
    assert.equal(second?.strategy.action, "CLOSE_POSITION");
    assert.equal(second?.strategy.isUrgentClose, true);
  });
});

test("a recovery in between wipes the streak — confirmation must be CONSECUTIVE", async () => {
  await withHarness(async (setQuote) => {
    const positions = [positionFor("CLSK", WAF)];

    setQuote(STOPPING.bid, STOPPING.ask);
    assert.equal(
      (await evaluatePositionGroup(positions, cycleTime(0), "cash"))?.strategy.action,
      "MANAGE_ALLOCATION",
    );

    setQuote(RECOVERED.bid, RECOVERED.ask);
    assert.equal(
      (await evaluatePositionGroup(positions, cycleTime(1), "cash"))?.strategy.action,
      "MANAGE_ALLOCATION",
    );

    setQuote(STOPPING.bid, STOPPING.ask);
    assert.equal(
      (await evaluatePositionGroup(positions, cycleTime(2), "cash"))?.strategy.action,
      "MANAGE_ALLOCATION",
      "the trigger stopped holding, so this is cycle 1 of 2 again",
    );
    assert.equal(
      (await evaluatePositionGroup(positions, cycleTime(3), "cash"))?.strategy.action,
      "CLOSE_POSITION",
    );
  });
});

test("the cash streak does not arm the margin book's stop on the same underlying", async () => {
  await withHarness(async (setQuote) => {
    setQuote(STOPPING.bid, STOPPING.ask);
    const positions = [positionFor("CLSK", WAF)];

    await evaluatePositionGroup(positions, cycleTime(0), "cash");
    assert.equal(
      (await evaluatePositionGroup(positions, cycleTime(1), "margin"))?.strategy.action,
      "MANAGE_ALLOCATION",
      "margin has seen this trigger once, not twice",
    );
    assert.equal(
      (await evaluatePositionGroup(positions, cycleTime(1), "cash"))?.strategy.action,
      "CLOSE_POSITION",
      "...while cash, which has, still closes",
    );
  });
});

test("a re-entry at a different cost basis starts over", async () => {
  await withHarness(async (setQuote) => {
    setQuote(STOPPING.bid, STOPPING.ask);
    await evaluatePositionGroup([positionFor("CLSK", WAF)], cycleTime(0), "cash");

    // Same group key, new position: the old basis was 1.17, this one is 1.05, and
    // 0.70/0.78 is still past the stop against it.
    const reentered = [positionFor("CLSK", 1.05)];
    assert.equal(
      (await evaluatePositionGroup(reentered, cycleTime(1), "cash"))?.strategy.action,
      "MANAGE_ALLOCATION",
    );
  });
});

// THE regression test for the intra-cycle double-count.
//
// getPositionEvaluations runs 5-6 times per cycle — run-cycle-context.ts:339 (the
// one that feeds the executor), :403, :420, run-cycle-seed.ts:159, :294 and
// allocation-budget.ts:41 — and every one of them re-runs this gate on every
// group. The store's write side always debounced correctly and held the streak at
// 1, but the consumer added 1 to it unconditionally, so evaluation #2 of a single
// cycle read 1, computed "2 of 2", and closed. The gate delayed by one EVALUATION
// instead of one CYCLE, i.e. it fired on exactly the single noisy print it exists
// to reject, and it did so while passing 605 tests.
test("repeat evaluations WITHIN one cycle never fire the stop", async () => {
  await withHarness(async (setQuote) => {
    setQuote(STOPPING.bid, STOPPING.ask);

    for (const attempt of [1, 2, 3, 4, 5, 6]) {
      const strategy = await evaluateAtCycle(0);
      // All three have to hold on EVERY repeat, not just the first. suppressAdds,
      // or the allocator averages into a position that is mid-stop (and moves the
      // cost basis the store's re-entry guard keys off). stopTriggerHeld, or
      // recordStopTrigger is called with held=false and deletes the row, wiping
      // the streak from inside the very cycle that is building it.
      assert.deepEqual(
        {
          action: strategy.action,
          stopTriggerHeld: strategy.stopTriggerHeld,
          suppressAdds: strategy.suppressAdds,
        },
        {
          action: "MANAGE_ALLOCATION",
          stopTriggerHeld: true,
          suppressAdds: true,
        },
        `evaluation ${attempt} of the SAME cycle must hold, keep suppressing adds, and keep re-affirming the trigger`,
      );
    }

    // ...and the next DISTINCT cycle still closes. The fix must delay the stop by
    // one cycle, not disable it.
    assert.equal(
      (await evaluateAtCycle(1)).action,
      "CLOSE_POSITION",
      "a genuine 2-cycle stop must still fire",
    );
  });
});

// Six evaluations spread over two cycles are still two cycles.
const TWO_CYCLES_EVALUATED_THRICE = [0, 0, 0, 1, 1, 1];

test("PERSIST_CYCLES=3 needs three DISTINCT cycles, however often each is evaluated", async () => {
  const prior = process.env.STRATEGY_STOP_LOSS_PERSIST_CYCLES;
  process.env.STRATEGY_STOP_LOSS_PERSIST_CYCLES = "3";
  try {
    await withHarness(async (setQuote) => {
      setQuote(STOPPING.bid, STOPPING.ask);

      for (const [attempt, cycleIndex] of TWO_CYCLES_EVALUATED_THRICE.entries()) {
        assert.equal(
          (await evaluateAtCycle(cycleIndex)).action,
          "MANAGE_ALLOCATION",
          `evaluation ${attempt + 1} (cycle ${cycleIndex + 1}): 6 evaluations are still 2 cycles`,
        );
      }

      assert.equal(
        (await evaluateAtCycle(2)).action,
        "CLOSE_POSITION",
        "the third distinct cycle closes",
      );
    });
  } finally {
    if (prior === undefined) delete process.env.STRATEGY_STOP_LOSS_PERSIST_CYCLES;
    else process.env.STRATEGY_STOP_LOSS_PERSIST_CYCLES = prior;
  }
});

test("the streak advances on the CYCLE clock, not the wall clock", async () => {
  // These cycles are 4 minutes apart on the simulated clock but microseconds
  // apart in real time, and the store refuses to advance a streak twice inside
  // getStreakAdvanceMinMs (half a run interval = 2 min here). So a 3-cycle
  // requirement only ever completes if the store is measuring the same clock the
  // engine is. At 2 cycles this is invisible — the second cycle closes off the
  // first cycle's row either way — which is why it takes 3 to pin it.
  const prior = process.env.STRATEGY_STOP_LOSS_PERSIST_CYCLES;
  process.env.STRATEGY_STOP_LOSS_PERSIST_CYCLES = "3";
  try {
    await withHarness(async (setQuote) => {
      setQuote(STOPPING.bid, STOPPING.ask);

      for (const index of [0, 1]) {
        assert.equal(
          (await evaluateAtCycle(index)).action,
          "MANAGE_ALLOCATION",
          `cycle ${index + 1} of 3 must still hold`,
        );
      }
      assert.equal(
        (await evaluateAtCycle(2)).action,
        "CLOSE_POSITION",
        "the third consecutive cycle closes — if this holds, the streak stopped advancing",
      );
    });
  } finally {
    if (prior === undefined) delete process.env.STRATEGY_STOP_LOSS_PERSIST_CYCLES;
    else process.env.STRATEGY_STOP_LOSS_PERSIST_CYCLES = prior;
  }
});

test("an unknown account type leaves the gate inert (today's behaviour)", async () => {
  await withHarness(async (setQuote) => {
    setQuote(STOPPING.bid, STOPPING.ask);
    const evaluation = await evaluatePositionGroup(
      [positionFor("CLSK", WAF)],
      cycleTime(0),
      "unknown",
    );
    assert.equal(evaluation?.strategy.action, "CLOSE_POSITION");
  });
});
