import test from "node:test";
import assert from "node:assert/strict";

import { evaluateTradingStrategy } from "~/strategy/evaluate-trading-strategy";
import { EXIT_GATE_DECISION_TOKEN } from "~/strategy/exit-decision-log";
import { localTimeAt, minutesBefore } from "./test-clock";

// EXIT_GATE_DECISION — the exit rebuild (§6b mid confirmation, §6c mid take-profit,
// §6d persistence) shipped into two files that emitted nothing at all, so a week of
// live stops could not be told apart from a week of price gaps. These tests pin the
// contract an operator reads the log against:
//
//   - a line exists for EVERY stop verdict, fired or withheld, and names the gate;
//   - both prices and both floors are on the line, so the mid-confirm verdict can be
//     re-derived by hand rather than trusted;
//   - the persistence streak is reported as observed-of-required, already inclusive
//     of the current cycle (never `+ 1` — see StopPersistenceContext);
//   - a take-profit says which basis fired it;
//   - and silence means exactly one thing: the bid never crossed the floor.
//
// Clock is pinned via test-clock (AGENTS.md non-negotiable 7): the engine reads
// time-of-day off the LOCAL clock, and the dynamic take-profit target is a function
// of it — at 09:30 local the target is 25%.

// The §6b/§6c/§6d knobs read straight from process.env, so pin them to "absent" =
// in-code defaults. One assignment each, no shared mutable env harness.
for (const key of [
  "STRATEGY_EOD_STOP_LOSS_PCT",
  "STRATEGY_INTRADAY_STOP_LOSS_PCT",
  "STRATEGY_STOP_LOSS_MID_CONFIRM_PCT",
  "STRATEGY_STOP_LOSS_PERSIST_BYPASS_PCT",
  "STRATEGY_STOP_LOSS_PERSIST_CYCLES",
  "STRATEGY_STOP_LOSS_REQUIRE_MID_CONFIRM",
  "STRATEGY_TAKE_PROFIT_ALLOW_MID",
  "STRATEGY_TAKE_PROFIT_MID_MARGIN_PCT",
]) {
  delete process.env[key];
}

const NINE_THIRTY = localTimeAt(9, 30);

interface Quote {
  ask: number;
  bid: number;
  weightedAverageFill: number;
}

function metricsFor(quote: Quote, minutesSinceLastAction = 45) {
  return {
    currentAskPrice: quote.ask,
    currentBidPrice: quote.bid,
    currentTime: NINE_THIRTY,
    groupKey: "CLSK::call",
    lastActionTime: minutesBefore(NINE_THIRTY, minutesSinceLastAction),
    weightedAverageFill: quote.weightedAverageFill,
  };
}

type LogLine = Record<string, unknown>;

/** Collect only this feature's lines; everything else still reaches the console. */
function captureExitGateLines(run: () => void): LogLine[] {
  const originalLog = console.log;
  const lines: LogLine[] = [];
  console.log = ((...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && first.includes(EXIT_GATE_DECISION_TOKEN)) {
      lines.push(JSON.parse(first) as LogLine);
      return;
    }
    (originalLog as (...a: unknown[]) => void)(...args);
  }) as typeof console.log;
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return lines;
}

function onlyLine(run: () => void): LogLine {
  const lines = captureExitGateLines(run);
  assert.equal(lines.length, 1, `expected exactly one ${EXIT_GATE_DECISION_TOKEN} line`);
  return lines[0];
}

// --- real quotes from the run ledger, same fixtures the §6b/§6d suites use ---

/** CLSK 2026-07-28 cash: bid -40.17% / mid -36.75%. Both floors cleared. */
const REAL_STOP: Quote = { weightedAverageFill: 1.17, bid: 0.7, ask: 0.78 };
/** IOVA 2026-08-03 cash: bid -53.33% against a +7.33% mid. Closed for a PROFIT. */
const PHANTOM_STOP: Quote = { weightedAverageFill: 0.53571429, bid: 0.25, ask: 0.9 };
/** Both sides of the book agree the contract collapsed: bid -60% / mid -55%. */
const COLLAPSE: Quote = { weightedAverageFill: 1.0, bid: 0.4, ask: 0.5 };
/** Nowhere near either floor. */
const HEALTHY: Quote = { weightedAverageFill: 1.0, bid: 0.95, ask: 1.05 };

const OPENING_CYCLE = { observedConsecutiveCycles: 1 };
const ONE_PRIOR = { observedConsecutiveCycles: 2 };

test("a stop WITHHELD by mid confirmation logs both prices, both floors, and the streak", () => {
  let action = "";
  const line = onlyLine(() => {
    action = evaluateTradingStrategy(
      metricsFor(PHANTOM_STOP),
      "cash",
      undefined,
      OPENING_CYCLE,
    ).action;
  });

  assert.equal(action, "MANAGE_ALLOCATION", "behaviour must be unchanged");
  assert.equal(line.token, EXIT_GATE_DECISION_TOKEN);
  assert.equal(line.gate, "intraday-stop");
  assert.equal(line.decision, "WITHHELD");
  assert.equal(line.withheldBy, "mid-confirm");
  assert.equal(line.groupKey, "CLSK::call");
  assert.equal(line.accountType, "cash");
  // Both prices and both floors, so the verdict is re-derivable by hand.
  assert.equal(line.bidReturnPct, -53.33);
  assert.equal(line.midReturnPct, 7.33);
  assert.equal(line.bidFloorPct, -30);
  assert.equal(line.midFloorPct, -20);
  assert.equal(line.midConfirmed, false);
  assert.equal(line.midConfirmEnabled, true);
  assert.equal(line.bid, 0.25);
  assert.equal(line.ask, 0.9);
  assert.equal(line.mid, 0.575);
  // The streak is reported even though the mid gate short-circuited before it.
  assert.equal(line.observedCycles, 1);
  assert.equal(line.requiredCycles, 2);
  // A mid deferral does NOT hold the trigger, so the streak resets after this.
  assert.equal(line.stopTriggerHeld, false);
});

test("a stop WITHHELD by persistence names the streak it is waiting on", () => {
  const line = onlyLine(() => {
    evaluateTradingStrategy(metricsFor(REAL_STOP), "cash", undefined, OPENING_CYCLE);
  });

  assert.equal(line.decision, "WITHHELD");
  assert.equal(line.withheldBy, "persistence");
  assert.equal(line.midConfirmed, true, "the midpoint agreed; only persistence held it");
  assert.equal(line.observedCycles, 1);
  assert.equal(line.requiredCycles, 2);
  assert.equal(line.persistenceActive, true);
  // This one DOES hold the trigger — next cycle reaches 2 of 2.
  assert.equal(line.stopTriggerHeld, true);
  assert.match(String(line.reason), /awaiting confirmation/);
});

test("a stop that FIRES says so, on the same line shape", () => {
  let strategy;
  const line = onlyLine(() => {
    strategy = evaluateTradingStrategy(
      metricsFor(REAL_STOP),
      "cash",
      undefined,
      ONE_PRIOR,
    );
  });

  assert.equal(strategy!.action, "CLOSE_POSITION");
  assert.equal(line.decision, "FIRED");
  assert.equal(line.withheldBy, null);
  assert.equal(line.observedCycles, 2);
  assert.equal(line.requiredCycles, 2);
  assert.equal(line.collapseBypassed, false);
  assert.equal(line.bidReturnPct, -40.17);
  assert.equal(line.midReturnPct, -36.75);
});

test("the collapse bypass is visible as a distinct field, not inferred from the reason", () => {
  const line = onlyLine(() => {
    evaluateTradingStrategy(metricsFor(COLLAPSE), "cash", undefined, OPENING_CYCLE);
  });

  assert.equal(line.decision, "FIRED");
  assert.equal(line.collapseBypassed, true);
  assert.equal(line.observedCycles, 1, "fired on cycle 1 of 2 — that IS the bypass");
});

test("an execution-time re-check is distinguishable: persistenceActive is false", () => {
  const line = onlyLine(() => {
    // No persistence context — the closePosition re-check and the chain probe both
    // run this way, and §6d is deliberately inert there.
    evaluateTradingStrategy(metricsFor(REAL_STOP), "cash");
  });

  assert.equal(line.decision, "FIRED");
  assert.equal(line.persistenceActive, false);
});

test("a cooldown standing in front of a live stop is logged, not silent", () => {
  let strategy;
  const line = onlyLine(() => {
    strategy = evaluateTradingStrategy(
      metricsFor(REAL_STOP, 5),
      "cash",
      undefined,
      OPENING_CYCLE,
    );
  });

  assert.match(strategy!.reason, /Still in cooldown period/);
  assert.equal(line.decision, "WITHHELD");
  assert.equal(line.withheldBy, "cooldown");
  assert.equal(line.bidReturnPct, -40.17);
  // The cooldown path never sets stopTriggerHeld, so the streak resets here too.
  assert.equal(line.stopTriggerHeld, false);
});

test("an ordinary cooldown on a healthy position stays silent", () => {
  const lines = captureExitGateLines(() => {
    evaluateTradingStrategy(metricsFor(HEALTHY, 5), "cash", undefined, OPENING_CYCLE);
  });
  assert.deepEqual(lines, []);
});

test("silence means the bid never crossed — a healthy position logs nothing", () => {
  const lines = captureExitGateLines(() => {
    evaluateTradingStrategy(metricsFor(HEALTHY), "cash", undefined, OPENING_CYCLE);
  });
  assert.deepEqual(lines, []);
});

// --- take-profit: which basis fired it, and at what target ---

test("a BID take-profit names the bid basis and the target it cleared", () => {
  let strategy;
  const line = onlyLine(() => {
    strategy = evaluateTradingStrategy(
      metricsFor({ weightedAverageFill: 1.0, bid: 1.3, ask: 1.35 }),
      "cash",
    );
  });

  assert.equal(strategy!.action, "CLOSE_POSITION");
  assert.equal(line.gate, "take-profit");
  assert.equal(line.decision, "FIRED");
  assert.equal(line.basis, "bid");
  assert.equal(line.bidReturnPct, 30);
  assert.equal(line.targetPct, 25, "09:30 local on the dynamic schedule");
  assert.equal(line.closeFraction, null);
});

test("a MID take-profit names the mid basis and the target-plus-margin it cleared", () => {
  let strategy;
  const line = onlyLine(() => {
    strategy = evaluateTradingStrategy(
      metricsFor({ weightedAverageFill: 1.0, bid: 1.05, ask: 1.6 }),
      "cash",
    );
  });

  assert.equal(strategy!.action, "CLOSE_POSITION");
  assert.equal(line.decision, "FIRED");
  assert.equal(line.basis, "mid");
  assert.equal(line.bidReturnPct, 5);
  assert.equal(line.midReturnPct, 32.5);
  assert.equal(line.targetPct, 25);
  assert.equal(line.midTargetPct, 30, "target + the 5pp mid margin");
  assert.equal(line.midMarginPp, 5);
});

test("a mid take-profit blocked by the breakeven invariant is logged as WITHHELD", () => {
  let strategy;
  const line = onlyLine(() => {
    strategy = evaluateTradingStrategy(
      metricsFor({ weightedAverageFill: 1.0, bid: 0.9, ask: 1.75 }),
      "cash",
    );
  });

  // Unchanged behaviour: it simply does not close.
  assert.equal(strategy!.action, "MANAGE_ALLOCATION");
  assert.equal(line.gate, "take-profit");
  assert.equal(line.decision, "WITHHELD");
  assert.equal(line.withheldBy, "bid-below-breakeven");
  assert.equal(line.basis, null);
  assert.equal(line.bidReturnPct, -10);
  assert.equal(line.midReturnPct, 32.5);
});
