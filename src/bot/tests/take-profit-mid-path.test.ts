import test from "node:test";
import assert from "node:assert/strict";

import { classifyCloseDecision } from "~/bot/pnl-ledger";
import { evaluateTradingStrategy } from "~/strategy/evaluate-trading-strategy";

// STRATEGY_TAKE_PROFIT_ALLOW_MID — the dynamic take-profit may fire on the MIDPOINT,
// not only on the bid.
//
// Why: the target reads the same bid the stop does, so the same wide spreads that
// make the stop fire early make the take-profit fire late or never. Over
// 2026-07-17 → 08-07, across 14 symbol-days, 158 cycles sat above the dynamic target
// at the midpoint while the bid had not reached it, against 5 cycles where the bid
// triggered. SGML finished 2026-08-07 at a +22.3% midpoint and never sold.

function metricsFor(
  quote: { ask: number; bid: number; weightedAverageFill: number },
  hours = 12,
  minutes = 30,
) {
  const currentTime = new Date();
  currentTime.setHours(hours, minutes, 0, 0);
  return {
    currentAskPrice: quote.ask,
    currentBidPrice: quote.bid,
    currentTime,
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
  STRATEGY_PARTIAL_SCALE_OUT_ENABLED: undefined,
  STRATEGY_TAKE_PROFIT_ALLOW_MID: undefined,
  STRATEGY_TAKE_PROFIT_MID_MARGIN_PCT: undefined,
};

// 12:30 PM: the dynamic target has decayed to ~9%. Bid +4% is under it; mid +16%
// clears it plus the 5pp margin. This is the shape of the 158 censored cycles.
const MID_WINNER = { weightedAverageFill: 1.0, bid: 1.04, ask: 1.28 };

test("default: a target reached only at the midpoint closes, on an executable bid", () => {
  withEnv(DEFAULTS, () => {
    const strategy = evaluateTradingStrategy(metricsFor(MID_WINNER), "cash");
    assert.equal(strategy.action, "CLOSE_POSITION");
    assert.match(strategy.reason, /^Profit target reached/);
    assert.match(strategy.reason, /mid 16\.00%/);
    assert.equal(
      classifyCloseDecision(strategy.reason),
      "take-profit",
      "the ledger classifies closes by reason prefix — a mid exit is still a take-profit",
    );
    assert.notEqual(
      strategy.isUrgentClose,
      true,
      "a take-profit keeps the slow chase; only hard-risk closes cross to the bid",
    );
  });
});

test("a bid under water can never trigger a take-profit, whatever the midpoint says", () => {
  withEnv(DEFAULTS, () => {
    // IOVA 2026-08-03: a -53.3% bid against a +68% ask. Its midpoint is +7.3%, which
    // clears the late-day target — and the close chase walks DOWN to the bid, so
    // selling on that midpoint would book the loss the phantom quote implies.
    const phantom = { weightedAverageFill: 0.53571429, bid: 0.25, ask: 0.9 };
    assert.equal(
      evaluateTradingStrategy(metricsFor(phantom, 12, 45), "cash").action,
      "MANAGE_ALLOCATION",
    );
    // Even a marginal loss on the bid is refused: a close classified take-profit
    // must not be able to book one.
    const slightlyRed = { weightedAverageFill: 1.0, bid: 0.99, ask: 1.35 };
    assert.equal(
      evaluateTradingStrategy(metricsFor(slightlyRed), "cash").action,
      "MANAGE_ALLOCATION",
    );
  });
});

test("the midpoint must clear the target BY the margin, not merely reach it", () => {
  withEnv(DEFAULTS, () => {
    // 12:30 target ~9%; mid +11% is above it but inside the 5pp margin.
    const shy = { weightedAverageFill: 1.0, bid: 1.02, ask: 1.2 };
    assert.equal(
      evaluateTradingStrategy(metricsFor(shy), "cash").action,
      "MANAGE_ALLOCATION",
    );
  });
  // Drop the margin to zero and the same quote qualifies.
  withEnv({ ...DEFAULTS, STRATEGY_TAKE_PROFIT_MID_MARGIN_PCT: "0" }, () => {
    const shy = { weightedAverageFill: 1.0, bid: 1.02, ask: 1.2 };
    assert.equal(
      evaluateTradingStrategy(metricsFor(shy), "cash").action,
      "CLOSE_POSITION",
    );
  });
  // Raise it past the midpoint and the winner waits.
  withEnv({ ...DEFAULTS, STRATEGY_TAKE_PROFIT_MID_MARGIN_PCT: "20" }, () => {
    assert.equal(
      evaluateTradingStrategy(metricsFor(MID_WINNER), "cash").action,
      "MANAGE_ALLOCATION",
    );
  });
});

test("STRATEGY_TAKE_PROFIT_ALLOW_MID=false restores the bid-only target", () => {
  withEnv({ ...DEFAULTS, STRATEGY_TAKE_PROFIT_ALLOW_MID: "false" }, () => {
    assert.equal(
      evaluateTradingStrategy(metricsFor(MID_WINNER), "cash").action,
      "MANAGE_ALLOCATION",
    );
  });
});

test("blank prefs resolve to the in-code defaults, not to off / NaN", () => {
  for (const blank of ["", "   "]) {
    withEnv({ ...DEFAULTS, STRATEGY_TAKE_PROFIT_ALLOW_MID: blank }, () => {
      assert.equal(
        evaluateTradingStrategy(metricsFor(MID_WINNER), "cash").action,
        "CLOSE_POSITION",
        `ALLOW_MID="${blank}" must mean the default (on)`,
      );
    });
    withEnv({ ...DEFAULTS, STRATEGY_TAKE_PROFIT_MID_MARGIN_PCT: blank }, () => {
      // A NaN margin would make every comparison false and silently disarm the path.
      assert.equal(
        evaluateTradingStrategy(metricsFor(MID_WINNER), "cash").action,
        "CLOSE_POSITION",
        `MARGIN_PCT="${blank}" must mean the default 5pp`,
      );
    });
  }
});

test("an unusable quote has no midpoint to trigger on", () => {
  withEnv(DEFAULTS, () => {
    // One-sided book: no ask, so no honest midpoint.
    assert.equal(
      evaluateTradingStrategy(
        metricsFor({ ...MID_WINNER, ask: 0 }),
        "cash",
      ).action,
      "MANAGE_ALLOCATION",
    );
    // Crossed book: the "midpoint" sits below the bid.
    assert.equal(
      evaluateTradingStrategy(
        metricsFor({ weightedAverageFill: 1.0, bid: 1.04, ask: 0.5 }),
        "cash",
      ).action,
      "MANAGE_ALLOCATION",
    );
  });
});

test("the bid path is unchanged and still names the bid basis", () => {
  withEnv(DEFAULTS, () => {
    const bidWinner = { weightedAverageFill: 1.0, bid: 1.6, ask: 1.7 };
    const strategy = evaluateTradingStrategy(metricsFor(bidWinner, 8, 15), "cash");
    assert.equal(strategy.action, "CLOSE_POSITION");
    assert.match(strategy.reason, /^Profit target reached \(60\.00% >=/);
    assert.doesNotMatch(strategy.reason, /mid /);
  });
});

test("a mid-path exit scales out exactly like a bid-path one", () => {
  withEnv(
    {
      ...DEFAULTS,
      STRATEGY_PARTIAL_SCALE_OUT_ENABLED: "true",
      STRATEGY_SCALE_OUT_FRACTION: "0.5",
    },
    () => {
      const strategy = evaluateTradingStrategy(metricsFor(MID_WINNER), "cash", {
        alreadyScaled: false,
        enabled: true,
        fraction: 0.5,
        runnerTargetMultiple: 1.5,
      });
      assert.equal(strategy.action, "CLOSE_POSITION");
      assert.equal(strategy.closeFraction, 0.5);
      assert.match(strategy.reason, /scaling out 50%/);
    },
  );
});

test("the margin EOD liquidation still outranks a mid take-profit", () => {
  withEnv(DEFAULTS, () => {
    const strategy = evaluateTradingStrategy(
      metricsFor(MID_WINNER, 12, 55),
      "margin",
    );
    assert.match(strategy.reason, /liquidate all positions immediately/);
    assert.equal(strategy.isUrgentClose, true);
  });
});
