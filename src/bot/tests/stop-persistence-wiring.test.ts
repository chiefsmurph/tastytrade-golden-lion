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
    "updated-at": "2026-08-08T12:00:00Z",
  } as unknown as CurrentPosition;
}

function cycleTime(index: number): Date {
  const time = new Date(2026, 7, 8);
  time.setHours(9, 30, 0, 0);
  return new Date(time.getTime() + index * CYCLE_MS);
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
