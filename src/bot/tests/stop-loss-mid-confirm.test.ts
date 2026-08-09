import test from "node:test";
import assert from "node:assert/strict";

import { evaluateTradingStrategy } from "~/strategy/evaluate-trading-strategy";

// STRATEGY_STOP_LOSS_REQUIRE_MID_CONFIRM — the intraday bid stop must also see the
// MIDPOINT under a (shallower) floor before it fires.
//
// Every fixture below is a REAL stop close pulled from the run ledger
// (data-pull/<date>/data/ledger/*.ndjson, 2026-07-06 → 2026-08-07). The quoted
// bid/ask are reconstructed from the recorded weightedAverageOpenFill and the
// bidReturnPctAtCycle / askReturnPctAtCycle the bot decided on, so these are the
// exact numbers the live engine saw. `realizedPct` is what the trade actually
// booked — it is the yardstick, not an assertion input.
//
// The split these cases have to reproduce: the bot stopped 25 positions on the
// intraday floor in that window, and 22 of them (cash 21 of 24) were not under
// -30% at the midpoint. PTON is the limit case — a -63.05% bid against a +136.45%
// ask, closed for -5.4%.

interface StopFixture {
  ask: number;
  bid: number;
  bidReturnPct: number;
  label: string;
  midReturnPct: number;
  realizedPct: number;
  weightedAverageFill: number;
}

// --- fires today AND under the mid confirmation: genuinely broken positions ---
const DEEP_STOPS: StopFixture[] = [
  {
    label: "LCID 2026-07-14 cash",
    weightedAverageFill: 0.63,
    bid: 0.36,
    ask: 0.48,
    bidReturnPct: -42.86,
    midReturnPct: -33.33,
    realizedPct: -41.27,
  },
  {
    label: "CLSK 2026-07-28 cash",
    weightedAverageFill: 1.17,
    bid: 0.7,
    ask: 0.78,
    bidReturnPct: -40.17,
    midReturnPct: -36.75,
    realizedPct: -37.61,
  },
  {
    label: "NEXT 2026-07-28 cash",
    weightedAverageFill: 0.77,
    bid: 0.5,
    ask: 0.6,
    bidReturnPct: -35.06,
    midReturnPct: -28.57,
    realizedPct: -35.06,
  },
];

// --- fires today, DEFERRED under the mid confirmation: the phantom triggers ---
const PHANTOM_STOPS: StopFixture[] = [
  {
    label: "PTON 2026-08-07 cash (145.9% spread)",
    weightedAverageFill: 0.67666667,
    bid: 0.25,
    ask: 1.6,
    bidReturnPct: -63.05,
    midReturnPct: 36.7,
    realizedPct: -5.42,
  },
  {
    label: "IOVA 2026-08-03 cash (closed for a PROFIT)",
    weightedAverageFill: 0.53571429,
    bid: 0.25,
    ask: 0.9,
    bidReturnPct: -53.33,
    midReturnPct: 7.33,
    realizedPct: 6.4,
  },
  {
    label: "TDOC 2026-07-30 cash",
    weightedAverageFill: 0.52,
    bid: 0.35,
    ask: 0.63,
    bidReturnPct: -32.69,
    midReturnPct: -5.77,
    // The one case in the window where deferring costs: the midpoint said -5.8%
    // and the position booked -25.0%. Kept as a fixture precisely so the cost of
    // this gate stays visible in the suite rather than only in a PR body.
    realizedPct: -25,
  },
  {
    label: "SG 2026-08-04 cash",
    weightedAverageFill: 1.23,
    bid: 0.85,
    ask: 1.2,
    bidReturnPct: -30.89,
    midReturnPct: -16.67,
    realizedPct: -15.45,
  },
];

function metricsFor(
  fixture: Pick<StopFixture, "ask" | "bid" | "weightedAverageFill">,
  hours = 8,
  minutes = 15,
) {
  const currentTime = new Date();
  currentTime.setHours(hours, minutes, 0, 0);
  return {
    currentAskPrice: fixture.ask,
    currentBidPrice: fixture.bid,
    currentTime,
    // Well past the 10-minute cooldown, which would otherwise short-circuit
    // before the stop is ever reached.
    lastActionTime: new Date(currentTime.getTime() - 45 * 60 * 1000),
    weightedAverageFill: fixture.weightedAverageFill,
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

// Every var absent ⇒ the in-code defaults. Since 2026-08-08 that means the mid
// confirmation is ON (see isStopLossMidConfirmEnabled); DISABLED is the explicit
// opt-out that restores the original bid-only stop.
const ON = {
  STRATEGY_STOP_LOSS_REQUIRE_MID_CONFIRM: undefined,
  STRATEGY_STOP_LOSS_MID_CONFIRM_PCT: undefined,
  STRATEGY_INTRADAY_STOP_LOSS_PCT: undefined,
  STRATEGY_EOD_STOP_LOSS_PCT: undefined,
};
const DISABLED = { ...ON, STRATEGY_STOP_LOSS_REQUIRE_MID_CONFIRM: "false" };

test("default (pref absent) applies the mid confirmation", () => {
  withEnv(ON, () => {
    for (const fixture of DEEP_STOPS) {
      const strategy = evaluateTradingStrategy(metricsFor(fixture), "cash");
      assert.equal(
        strategy.action,
        "CLOSE_POSITION",
        `${fixture.label}: mid ${fixture.midReturnPct}% is under the confirmation floor`,
      );
      assert.equal(strategy.isUrgentClose, true, fixture.label);
      assert.match(strategy.reason, /stop loss triggered/);
    }
    for (const fixture of PHANTOM_STOPS) {
      assert.equal(
        evaluateTradingStrategy(metricsFor(fixture), "cash").action,
        "MANAGE_ALLOCATION",
        `${fixture.label}: mid ${fixture.midReturnPct}% must defer by default now`,
      );
    }
  });
});

test("a blank pref means the in-code default, not off", () => {
  // dotenv turns `KEY=` into "", which is NOT nullish — a `?? true` read would
  // silently invert the flag. Blank must behave exactly like absent.
  withEnv({ ...ON, STRATEGY_STOP_LOSS_REQUIRE_MID_CONFIRM: "" }, () => {
    assert.equal(
      evaluateTradingStrategy(metricsFor(PHANTOM_STOPS[0]), "cash").action,
      "MANAGE_ALLOCATION",
    );
  });
});

test("pref explicitly false restores the original bid-only stop", () => {
  withEnv(DISABLED, () => {
    for (const fixture of [...DEEP_STOPS, ...PHANTOM_STOPS]) {
      const strategy = evaluateTradingStrategy(metricsFor(fixture), "cash");
      assert.equal(
        strategy.action,
        "CLOSE_POSITION",
        `${fixture.label}: bid-only must keep firing (bid ${fixture.bidReturnPct}%)`,
      );
      assert.equal(strategy.isUrgentClose, true, fixture.label);
      assert.match(strategy.reason, /stop loss triggered/);
    }
  });
});

test("enabled: the deep stops still fire — the gate does not mute the real ones", () => {
  withEnv(ON, () => {
    for (const fixture of DEEP_STOPS) {
      const strategy = evaluateTradingStrategy(metricsFor(fixture), "cash");
      assert.equal(
        strategy.action,
        "CLOSE_POSITION",
        `${fixture.label}: mid ${fixture.midReturnPct}% is under the confirmation floor, must still close (it realized ${fixture.realizedPct}%)`,
      );
      assert.equal(strategy.isUrgentClose, true, fixture.label);
    }
  });
});

test("enabled: the phantom-bid stops are deferred and adds are suppressed", () => {
  withEnv(ON, () => {
    for (const fixture of PHANTOM_STOPS) {
      const strategy = evaluateTradingStrategy(metricsFor(fixture), "cash");
      assert.equal(
        strategy.action,
        "MANAGE_ALLOCATION",
        `${fixture.label}: bid ${fixture.bidReturnPct}% but mid ${fixture.midReturnPct}%`,
      );
      assert.equal(
        strategy.suppressAdds,
        true,
        `${fixture.label}: a disputed quote must not be averaged down into either`,
      );
      assert.notEqual(strategy.isUrgentClose, true, fixture.label);
      assert.match(strategy.reason, /mid confirmation/);
    }
  });
});

test("enabled: margin's tighter bid/ask keeps its stops intact (PTON's cash spread is the outlier)", () => {
  // TE 2026-07-07 margin stop-loss: bid -33.13% / mid -25.83% on a 19.4% spread.
  // The margin book's mid-minus-bid gap averages 7.6pp vs cash's 16.7pp, so the
  // same confirmation floor barely touches it.
  const te = { weightedAverageFill: 0.59, bid: 0.3946, ask: 0.48 };
  withEnv(ON, () => {
    const strategy = evaluateTradingStrategy(metricsFor(te, 11, 0), "margin");
    assert.equal(strategy.action, "CLOSE_POSITION");
    assert.equal(strategy.isUrgentClose, true);
  });
});

test("enabled: an unusable quote fires the stop — the gate can only ever suppress on evidence", () => {
  const phantom = PHANTOM_STOPS[0];
  withEnv(ON, () => {
    // One-sided quote (no ask): there is no midpoint to argue with.
    assert.equal(
      evaluateTradingStrategy(
        metricsFor({ ...phantom, ask: 0 }),
        "cash",
      ).action,
      "CLOSE_POSITION",
      "no ask",
    );
    // Crossed quote: the "midpoint" sits below the bid and would defer on
    // arithmetic rather than on evidence.
    assert.equal(
      evaluateTradingStrategy(
        metricsFor({ weightedAverageFill: 0.67666667, bid: 0.25, ask: 0.1 }),
        "cash",
      ).action,
      "CLOSE_POSITION",
      "crossed quote",
    );
    // Zero bid on a dead contract: still a close, never a deferral.
    assert.equal(
      evaluateTradingStrategy(
        metricsFor({ weightedAverageFill: 0.67666667, bid: 0, ask: 1.6 }),
        "cash",
      ).action,
      "CLOSE_POSITION",
      "no bid",
    );
  });
});

test("STRATEGY_STOP_LOSS_MID_CONFIRM_PCT moves the confirmation floor", () => {
  const next = DEEP_STOPS[2]; // mid -28.57%
  // At the default 20% floor NEXT clears the confirmation and closes.
  withEnv(ON, () => {
    assert.equal(
      evaluateTradingStrategy(metricsFor(next), "cash").action,
      "CLOSE_POSITION",
    );
  });
  // At a 30% floor its midpoint is no longer deep enough, so it defers.
  withEnv({ ...ON, STRATEGY_STOP_LOSS_MID_CONFIRM_PCT: "30" }, () => {
    assert.equal(
      evaluateTradingStrategy(metricsFor(next), "cash").action,
      "MANAGE_ALLOCATION",
    );
  });
  // A blank value resolves to the in-code default, never NaN (which would
  // compare false against every midpoint and silently disarm the gate).
  withEnv({ ...ON, STRATEGY_STOP_LOSS_MID_CONFIRM_PCT: "" }, () => {
    assert.equal(
      evaluateTradingStrategy(metricsFor(next), "cash").action,
      "CLOSE_POSITION",
    );
    assert.equal(
      evaluateTradingStrategy(metricsFor(PHANTOM_STOPS[3]), "cash").action,
      "MANAGE_ALLOCATION",
    );
  });
});

test("the confirmation floor is clamped to the intraday floor", () => {
  // 60% would be deeper than the -30% bid floor, which would make the bid trigger
  // dead weight. Clamped to 30, LCID (mid -33.33%) still closes.
  withEnv({ ...ON, STRATEGY_STOP_LOSS_MID_CONFIRM_PCT: "60" }, () => {
    assert.equal(
      evaluateTradingStrategy(metricsFor(DEEP_STOPS[0]), "cash").action,
      "CLOSE_POSITION",
    );
  });
});

test("the EOD stop is out of scope — it fires on the bid with the pref on", () => {
  // WEN 2026-07-06 margin eod-stop: bid -12.29% / mid -5.61%. A -20% mid
  // confirmation would defer it; the EOD floor must not consult one at all.
  const wen = { weightedAverageFill: 0.38724138, bid: 0.3397, ask: 0.3914 };
  withEnv(ON, () => {
    const strategy = evaluateTradingStrategy(metricsFor(wen, 12, 35), "margin");
    assert.equal(strategy.action, "CLOSE_POSITION");
    assert.equal(strategy.isUrgentClose, true);
    assert.match(strategy.reason, /End-of-day risk management/);
  });
});

test("the take-profit and EOD-liquidation branches are untouched by the pref", () => {
  withEnv(ON, () => {
    const winner = { weightedAverageFill: 1, bid: 1.6, ask: 1.8 };
    assert.match(
      evaluateTradingStrategy(metricsFor(winner, 8, 15), "cash").reason,
      /Profit target reached/,
    );
    const anything = { weightedAverageFill: 1, bid: 0.99, ask: 1.01 };
    assert.match(
      evaluateTradingStrategy(metricsFor(anything, 12, 55), "margin").reason,
      /liquidate all positions immediately/,
    );
  });
});
