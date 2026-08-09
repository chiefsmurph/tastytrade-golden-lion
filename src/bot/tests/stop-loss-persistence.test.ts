import test from "node:test";
import assert from "node:assert/strict";

import { evaluateTradingStrategy } from "~/strategy/evaluate-trading-strategy";

// STRATEGY_STOP_LOSS_PERSIST_CYCLES — the intraday bid stop must see its trigger
// hold across N consecutive evaluations of the same group before it closes.
//
// The measurement behind it (2026-07-17 → 08-07): 5 of the 5 stops with full-day
// quote history fired on ONE cycle out of the 26-100 cycles the position was held,
// on days whose median bid return was -10% to -23%; and 15 of 21 stops fired in the
// first or last 30 minutes, where the median spread was 57% vs 24.5% midday. The bad
// triggers are single-print artifacts, so one more observation removes them.

interface Quote {
  ask: number;
  bid: number;
  weightedAverageFill: number;
}

function metricsFor(quote: Quote, hours = 9, minutes = 30) {
  const currentTime = new Date();
  currentTime.setHours(hours, minutes, 0, 0);
  return {
    currentAskPrice: quote.ask,
    currentBidPrice: quote.bid,
    currentTime,
    // Well past the 10-minute cooldown, which short-circuits before the stop.
    lastActionTime: new Date(currentTime.getTime() - 45 * 60 * 1000),
    weightedAverageFill: quote.weightedAverageFill,
  };
}

function applyEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const prior = Object.fromEntries(
    Object.keys(vars).map((key) => [key, process.env[key]]),
  );
  applyEnv(vars);
  try {
    return run();
  } finally {
    applyEnv(prior);
  }
}

const DEFAULTS = {
  STRATEGY_EOD_STOP_LOSS_PCT: undefined,
  STRATEGY_INTRADAY_STOP_LOSS_PCT: undefined,
  STRATEGY_STOP_LOSS_MID_CONFIRM_PCT: undefined,
  STRATEGY_STOP_LOSS_PERSIST_BYPASS_PCT: undefined,
  STRATEGY_STOP_LOSS_PERSIST_CYCLES: undefined,
  STRATEGY_STOP_LOSS_REQUIRE_MID_CONFIRM: undefined,
};

// CLSK 2026-07-28 cash: bid -40.17% / mid -36.75%, realized -37.61%. Clears the
// bid floor AND the midpoint confirmation, so persistence is the only thing left
// standing between it and a close.
const REAL_STOP: Quote = { weightedAverageFill: 1.17, bid: 0.7, ask: 0.78 };

// bid -50% / mid -25%: the midpoint confirms the stop but is nowhere near the
// collapse bypass floor. This is the case the bypass must NOT swallow.
const DEEP_BID_SHALLOW_MID: Quote = { weightedAverageFill: 1.0, bid: 0.5, ask: 1.0 };

// bid -60% / mid -55%: both sides of the book agree the contract has collapsed.
const COLLAPSE: Quote = { weightedAverageFill: 1.0, bid: 0.4, ask: 0.5 };

const OPENING_CYCLE = { priorConsecutiveTriggers: 0 };
const ONE_PRIOR = { priorConsecutiveTriggers: 1 };

test("no persistence context ⇒ the gate is inert (execution re-check must not undo a confirmed stop)", () => {
  withEnv(DEFAULTS, () => {
    const strategy = evaluateTradingStrategy(metricsFor(REAL_STOP), "cash");
    assert.equal(strategy.action, "CLOSE_POSITION");
    assert.equal(strategy.isUrgentClose, true);
  });
});

test("a position's FIRST cycle cannot stop — there is no predecessor to confirm it", () => {
  withEnv(DEFAULTS, () => {
    const strategy = evaluateTradingStrategy(
      metricsFor(REAL_STOP),
      "cash",
      undefined,
      OPENING_CYCLE,
    );
    assert.equal(strategy.action, "MANAGE_ALLOCATION");
    assert.equal(strategy.suppressAdds, true, "a stop in progress must not be averaged into");
    assert.notEqual(strategy.isUrgentClose, true);
    assert.match(strategy.reason, /1 of 2 consecutive cycles/);
  });
});

test("the second consecutive trigger closes", () => {
  withEnv(DEFAULTS, () => {
    const strategy = evaluateTradingStrategy(
      metricsFor(REAL_STOP),
      "cash",
      undefined,
      ONE_PRIOR,
    );
    assert.equal(strategy.action, "CLOSE_POSITION");
    assert.equal(strategy.isUrgentClose, true);
    assert.match(strategy.reason, /stop loss triggered/);
  });
});

test("both the deferral and the close report the trigger as held; a mid-disputed one does not", () => {
  withEnv(DEFAULTS, () => {
    assert.equal(
      evaluateTradingStrategy(metricsFor(REAL_STOP), "cash", undefined, OPENING_CYCLE)
        .stopTriggerHeld,
      true,
      "the deferral is what lets the streak advance",
    );
    assert.equal(
      evaluateTradingStrategy(metricsFor(REAL_STOP), "cash", undefined, ONE_PRIOR)
        .stopTriggerHeld,
      true,
    );
    // IOVA 2026-08-03: bid -53.3% against a +7.3% midpoint. The mid confirmation
    // rejects it, so the trigger did NOT hold and no streak may accumulate — a
    // phantom bid must not be able to arm a stop over several cycles.
    const phantom = { weightedAverageFill: 0.53571429, bid: 0.25, ask: 0.9 };
    const disputed = evaluateTradingStrategy(
      metricsFor(phantom),
      "cash",
      undefined,
      ONE_PRIOR,
    );
    assert.equal(disputed.action, "MANAGE_ALLOCATION");
    assert.notEqual(disputed.stopTriggerHeld, true);
    assert.match(disputed.reason, /mid confirmation/);
  });
});

test("STRATEGY_STOP_LOSS_PERSIST_CYCLES=1 restores the pre-change fire-on-first-print stop", () => {
  withEnv({ ...DEFAULTS, STRATEGY_STOP_LOSS_PERSIST_CYCLES: "1" }, () => {
    const strategy = evaluateTradingStrategy(
      metricsFor(REAL_STOP),
      "cash",
      undefined,
      OPENING_CYCLE,
    );
    assert.equal(strategy.action, "CLOSE_POSITION");
    assert.equal(strategy.isUrgentClose, true);
  });
});

test("STRATEGY_STOP_LOSS_PERSIST_CYCLES=3 needs three, and blank/invalid falls back to 2", () => {
  withEnv({ ...DEFAULTS, STRATEGY_STOP_LOSS_PERSIST_CYCLES: "3" }, () => {
    assert.equal(
      evaluateTradingStrategy(metricsFor(REAL_STOP), "cash", undefined, ONE_PRIOR).action,
      "MANAGE_ALLOCATION",
    );
    assert.equal(
      evaluateTradingStrategy(metricsFor(REAL_STOP), "cash", undefined, {
        priorConsecutiveTriggers: 2,
      }).action,
      "CLOSE_POSITION",
    );
  });
  for (const bad of ["", "   ", "garbage", "0", "-4"]) {
    withEnv({ ...DEFAULTS, STRATEGY_STOP_LOSS_PERSIST_CYCLES: bad }, () => {
      assert.equal(
        evaluateTradingStrategy(metricsFor(REAL_STOP), "cash", undefined, OPENING_CYCLE)
          .action,
        "MANAGE_ALLOCATION",
        `"${bad}" must resolve to the in-code default of 2, never to 0/NaN`,
      );
    });
  }
});

test("collapse bypass: bid AND mid both past the bypass floor exit on the first cycle", () => {
  withEnv(DEFAULTS, () => {
    const strategy = evaluateTradingStrategy(
      metricsFor(COLLAPSE),
      "cash",
      undefined,
      OPENING_CYCLE,
    );
    assert.equal(strategy.action, "CLOSE_POSITION");
    assert.equal(strategy.isUrgentClose, true);
    assert.match(strategy.reason, /collapse bypass/);
  });
});

test("collapse bypass needs BOTH sides — a deep bid with a shallow mid still waits", () => {
  withEnv(DEFAULTS, () => {
    const strategy = evaluateTradingStrategy(
      metricsFor(DEEP_BID_SHALLOW_MID),
      "cash",
      undefined,
      OPENING_CYCLE,
    );
    assert.equal(
      strategy.action,
      "MANAGE_ALLOCATION",
      "bid -50% but mid -25%: the book does not agree this is a collapse",
    );
  });
});

test("collapse bypass needs an arguable quote — a one-sided book buys no instant exit", () => {
  withEnv(DEFAULTS, () => {
    // No ask at all: the bid is -60%, but there is no midpoint to corroborate it,
    // and a quote that noisy is the exact thing persistence protects against.
    const strategy = evaluateTradingStrategy(
      metricsFor({ ...COLLAPSE, ask: 0 }),
      "cash",
      undefined,
      OPENING_CYCLE,
    );
    assert.equal(strategy.action, "MANAGE_ALLOCATION");
  });
});

test("STRATEGY_STOP_LOSS_PERSIST_BYPASS_PCT moves the bypass deeper", () => {
  // Default 45% lets the collapse (bid -60% / mid -55%) out immediately; at 60%
  // its midpoint is no longer deep enough and it waits like everything else.
  withEnv({ ...DEFAULTS, STRATEGY_STOP_LOSS_PERSIST_BYPASS_PCT: "60" }, () => {
    assert.equal(
      evaluateTradingStrategy(metricsFor(COLLAPSE), "cash", undefined, OPENING_CYCLE)
        .action,
      "MANAGE_ALLOCATION",
    );
  });
});

test("the bypass cannot be set shallow enough to swallow the ordinary stop", () => {
  // A 20% bypass would sit BELOW the -30% floor it overrides, so every stop would
  // bypass and the gate would be dead weight. Clamped to 1.25x the floor (-37.5%),
  // the shallow-mid case (bid -50% / mid -25%) still has to wait a cycle.
  withEnv({ ...DEFAULTS, STRATEGY_STOP_LOSS_PERSIST_BYPASS_PCT: "20" }, () => {
    assert.equal(
      evaluateTradingStrategy(
        metricsFor(DEEP_BID_SHALLOW_MID),
        "cash",
        undefined,
        OPENING_CYCLE,
      ).action,
      "MANAGE_ALLOCATION",
    );
  });
  // The clamp tracks the floor rather than being a constant: deepen the stop to
  // -50% and the default 45% bypass is pushed out to -62.5%, so the collapse
  // (mid -55%) no longer qualifies for an instant exit.
  withEnv({ ...DEFAULTS, STRATEGY_INTRADAY_STOP_LOSS_PCT: "50" }, () => {
    assert.equal(
      evaluateTradingStrategy(metricsFor(COLLAPSE), "cash", undefined, OPENING_CYCLE)
        .action,
      "MANAGE_ALLOCATION",
    );
  });
});

test("persistence is scoped to the intraday floor — the EOD stop still fires on sight", () => {
  withEnv(DEFAULTS, () => {
    // WEN 2026-07-06 margin: bid -12.29%, evaluated past the 12:30 margin cutoff.
    const wen = { weightedAverageFill: 0.38724138, bid: 0.3397, ask: 0.3914 };
    const strategy = evaluateTradingStrategy(
      metricsFor(wen, 12, 35),
      "margin",
      undefined,
      OPENING_CYCLE,
    );
    assert.equal(strategy.action, "CLOSE_POSITION");
    assert.equal(strategy.isUrgentClose, true);
    assert.match(strategy.reason, /End-of-day risk management/);
  });
});

test("persistence does not gate the margin EOD liquidation", () => {
  withEnv(DEFAULTS, () => {
    const strategy = evaluateTradingStrategy(
      metricsFor(REAL_STOP, 12, 55),
      "margin",
      undefined,
      OPENING_CYCLE,
    );
    assert.equal(strategy.action, "CLOSE_POSITION");
    assert.match(strategy.reason, /liquidate all positions immediately/);
  });
});
