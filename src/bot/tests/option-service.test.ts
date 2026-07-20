import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeVolumesIntoChain,
  OPEN_INTEREST_FIELD_NAMES,
  extractStreamerSymbols,
  allRequiredCovered,
  createEarlyExitController,
} from "~/core/option-service";
import type { TastytradeOptionChain, TastytradeStrikeWithVolumes } from "~/core/types";

// Deterministic fake clock + timer queue for the early-exit controller.
function makeFakeClock() {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();
  return {
    now: () => current,
    setTimer: ((fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { fireAt: current + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
    clearTimer: ((h: ReturnType<typeof setTimeout>) => {
      timers.delete(h as unknown as number);
    }) as (h: ReturnType<typeof setTimeout>) => void,
    advance(ms: number) {
      current += ms;
      for (const [id, t] of [...timers.entries()].sort(
        (a, b) => a[1].fireAt - b[1].fireAt,
      )) {
        if (t.fireAt <= current) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function miniChain(): TastytradeOptionChain {
  return {
    "underlying-symbol": "MARA",
    expirations: [
      {
        "expiration-date": "2026-08-07",
        "days-to-expiration": 35,
        strikes: [
          {
            "strike-price": "12.0",
            call: "MARA  260807C00012000",
            put: "MARA  260807P00012000",
            "call-streamer-symbol": ".MARA260807C12",
            "put-streamer-symbol": ".MARA260807P12",
          },
        ],
      },
    ],
  } as unknown as TastytradeOptionChain;
}

function firstStrike(chain: unknown): TastytradeStrikeWithVolumes {
  return (chain as { expirations: { strikes: TastytradeStrikeWithVolumes[] }[] })
    .expirations[0].strikes[0];
}

test("volume merge writes callVolume/putVolume", () => {
  const merged = mergeVolumesIntoChain(miniChain(), {
    ".MARA260807C12": 500,
    ".MARA260807P12": 75,
  });
  const strike = firstStrike(merged);
  assert.equal(strike.callVolume, 500);
  assert.equal(strike.putVolume, 75);
  assert.equal(strike.callOpenInterest, undefined);
});

test("open-interest merge writes its own fields and leaves volume untouched", () => {
  const withVolumes = mergeVolumesIntoChain(miniChain(), {
    ".MARA260807C12": 500,
  });
  const merged = mergeVolumesIntoChain(
    withVolumes,
    { ".MARA260807C12": 1200, ".MARA260807P12": 340 },
    OPEN_INTEREST_FIELD_NAMES,
  );
  const strike = firstStrike(merged);
  assert.equal(strike.callVolume, 500);
  assert.equal(strike.callOpenInterest, 1200);
  assert.equal(strike.putOpenInterest, 340);
  assert.equal(strike.putVolume, undefined);
});

test("extractStreamerSymbols pulls call/put streamer symbols out of a chain", () => {
  const syms = extractStreamerSymbols(miniChain());
  assert.deepEqual(
    syms.sort(),
    [".MARA260807C12", ".MARA260807P12"].sort(),
  );
});

test("extractStreamerSymbols returns [] for junk input", () => {
  assert.deepEqual(extractStreamerSymbols(null), []);
  assert.deepEqual(extractStreamerSymbols({ foo: "bar" }), []);
});

test("allRequiredCovered: empty required set never satisfies (waits full budget)", () => {
  assert.equal(allRequiredCovered([], new Set([".A"])), false);
});

test("allRequiredCovered: true only once EVERY required symbol is present", () => {
  assert.equal(allRequiredCovered([".A", ".B"], new Set([".A"])), false);
  assert.equal(allRequiredCovered([".A", ".B"], new Set([".A", ".B"])), true);
});

test("early-exit controller: caps at sampleMs when nothing is covered", async () => {
  const clock = makeFakeClock();
  const ctl = createEarlyExitController({
    sampleMs: 7000,
    requiredSymbols: [".A"],
    minSettleMs: 1000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  let done = false;
  ctl.done.then(() => {
    done = true;
  });

  clock.advance(6999);
  await flush();
  assert.equal(done, false, "not resolved before the cap");

  clock.advance(1);
  await flush();
  assert.equal(done, true, "resolves exactly at the cap");
});

test("early-exit controller: exits early once all required covered past the floor", async () => {
  const clock = makeFakeClock();
  const ctl = createEarlyExitController({
    sampleMs: 7000,
    requiredSymbols: [".A", ".B"],
    minSettleMs: 1000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  let done = false;
  ctl.done.then(() => {
    done = true;
  });

  ctl.markCovered(".A");
  clock.advance(500); // still before the settle floor
  ctl.markCovered(".B"); // all covered, but floor not elapsed yet
  await flush();
  assert.equal(done, false, "must respect the settle floor even when fully covered");

  clock.advance(600); // now at 1100ms — floor timer fires and sees full coverage
  await flush();
  assert.equal(done, true, "early-exits after the floor once fully covered");
});

test("early-exit controller: empty required set waits the full cap despite coverage", async () => {
  const clock = makeFakeClock();
  const ctl = createEarlyExitController({
    sampleMs: 5000,
    requiredSymbols: [],
    minSettleMs: 1000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  let done = false;
  ctl.done.then(() => {
    done = true;
  });

  ctl.markCovered(".A");
  clock.advance(4999);
  await flush();
  assert.equal(done, false, "no early-exit target -> waits the cap");

  clock.advance(1);
  await flush();
  assert.equal(done, true);
});
