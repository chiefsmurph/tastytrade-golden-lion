// Pin the timezone before any Date is constructed in this module. The
// intraday gate reads wall-clock time (getHours/getDay) under the production
// invariant of America/Los_Angeles; the unqualified `new Date("...")` literals
// and session-bound assertions below depend on it, so without this a UTC host
// (e.g. CI) would parse and evaluate them in the wrong timezone.
process.env.TZ = "America/Los_Angeles";

import test from "node:test";
import assert from "node:assert/strict";

import {
  EntryAccountType,
  evaluateLiquidityGate,
  getMarginMaxEntrySpreadPct,
  getMaxEntrySpreadPctForAccountType,
  getMinOpenInterest,
  isPhantomQuoteGuardEnabled,
  isRegularSessionByLocalClock,
} from "~/strategy/liquidity-gate";
import { buildTopOptionCandidateResult } from "~/strategy/option-candidate/selection";
import tastytradeApi from "~/core/tastytrade-client";
import type { OptionChainWithVolume } from "~/core/market-snapshot";

// 2026-07-06 is a Monday (the WEN session). Timestamps are local-clock, which
// is how every intraday gate reads time.
const mondayMidday = new Date("2026-07-06T10:30:00");
const mondayPreOpen = new Date("2026-07-06T05:00:00");
const saturdayMidday = new Date("2026-07-04T10:30:00");

const GATE_ENV_KEYS = [
  "STRATEGY_MAX_OPTION_SPREAD_PCT",
  "STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT",
  "STRATEGY_MIN_OPEN_INTEREST",
  "STRATEGY_PHANTOM_QUOTE_GUARD_ENABLED",
] as const;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

// Clears every gate env var (so in-code defaults apply), layers `overrides`
// on top, and restores the pre-test environment afterwards.
async function withEnv(
  overrides: Record<string, string | undefined>,
  run: () => void | Promise<void>,
): Promise<void> {
  const saved = GATE_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of GATE_ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    setEnv(key, value);
  }

  try {
    await run();
  } finally {
    for (const [key, value] of saved) {
      setEnv(key, value);
    }
  }
}

// WEN 2026-07-06 in numbers: ~18.2% spread (bid 0.85 / ask 1.02), day volume
// 12, open interest 40, askSize 1. The lot this shape built lost $160.86 at
// the forced EOD exit.
const WEN_SPREAD_PCT = (1.02 - 0.85) / ((1.02 + 0.85) / 2);

function wenLikeGateInput(accountType: EntryAccountType, currentTime = mondayMidday) {
  return {
    accountType,
    askSize: 1,
    bidSize: 5,
    currentTime,
    dayVolume: 12,
    maxAllowedSpreadPct: getMaxEntrySpreadPctForAccountType(accountType, currentTime),
    openInterest: 40,
    spreadPct: WEN_SPREAD_PCT,
  };
}

test("margin entry-spread ceiling defaults to the shared gate (behavior unchanged)", async () => {
  await withEnv({}, () => {
    assert.equal(getMarginMaxEntrySpreadPct(), 0.3);
    assert.equal(getMaxEntrySpreadPctForAccountType("margin", mondayMidday), 0.3);
    assert.equal(
      getMaxEntrySpreadPctForAccountType("margin", mondayMidday),
      getMaxEntrySpreadPctForAccountType("cash", mondayMidday),
    );
  });

  // The default follows the shared gate wherever it is set.
  await withEnv({ STRATEGY_MAX_OPTION_SPREAD_PCT: "0.2" }, () => {
    assert.equal(getMarginMaxEntrySpreadPct(), 0.2);
  });

  // Blank means "use the in-code default", never NaN.
  await withEnv({ STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT: "" }, () => {
    assert.equal(getMarginMaxEntrySpreadPct(), 0.3);
  });

  // Invalid / non-positive values also fall back to the shared gate.
  await withEnv({ STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT: "abc" }, () => {
    assert.equal(getMarginMaxEntrySpreadPct(), 0.3);
  });
  await withEnv({ STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT: "0" }, () => {
    assert.equal(getMarginMaxEntrySpreadPct(), 0.3);
  });
});

test("margin override tightens margin only; cash and unknown keep the shared gate", async () => {
  await withEnv({ STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT: "0.10" }, () => {
    assert.equal(getMaxEntrySpreadPctForAccountType("margin", mondayMidday), 0.10);
    assert.equal(getMaxEntrySpreadPctForAccountType("cash", mondayMidday), 0.3);
    assert.equal(getMaxEntrySpreadPctForAccountType("unknown", mondayMidday), 0.3);
  });
});

test("the morning spread ramp still caps the account ceiling", async () => {
  await withEnv({ STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT: "0.10" }, () => {
    const open = new Date("2026-07-06T06:30:00");
    assert.equal(getMaxEntrySpreadPctForAccountType("margin", open), 0.05);
    assert.equal(getMaxEntrySpreadPctForAccountType("cash", open), 0.05);
  });
});

test("getMinOpenInterest defaults to 0 (off) and rejects blank/invalid/negative", async () => {
  await withEnv({}, () => assert.equal(getMinOpenInterest(), 0));
  await withEnv({ STRATEGY_MIN_OPEN_INTEREST: "" }, () => assert.equal(getMinOpenInterest(), 0));
  await withEnv({ STRATEGY_MIN_OPEN_INTEREST: "abc" }, () => assert.equal(getMinOpenInterest(), 0));
  await withEnv({ STRATEGY_MIN_OPEN_INTEREST: "-5" }, () => assert.equal(getMinOpenInterest(), 0));
  await withEnv({ STRATEGY_MIN_OPEN_INTEREST: "100" }, () => assert.equal(getMinOpenInterest(), 100));
});

test("phantom-quote guard is off by default", async () => {
  await withEnv({}, () => assert.equal(isPhantomQuoteGuardEnabled(), false));
  await withEnv({ STRATEGY_PHANTOM_QUOTE_GUARD_ENABLED: "false" }, () =>
    assert.equal(isPhantomQuoteGuardEnabled(), false),
  );
  await withEnv({ STRATEGY_PHANTOM_QUOTE_GUARD_ENABLED: "true" }, () =>
    assert.equal(isPhantomQuoteGuardEnabled(), true),
  );
});

test("isRegularSessionByLocalClock covers session bounds and weekends", () => {
  assert.equal(isRegularSessionByLocalClock(mondayMidday), true);
  assert.equal(isRegularSessionByLocalClock(new Date("2026-07-06T06:30:00")), true);
  assert.equal(isRegularSessionByLocalClock(new Date("2026-07-06T12:59:00")), true);
  assert.equal(isRegularSessionByLocalClock(new Date("2026-07-06T06:29:00")), false);
  assert.equal(isRegularSessionByLocalClock(new Date("2026-07-06T13:00:00")), false);
  assert.equal(isRegularSessionByLocalClock(mondayPreOpen), false);
  assert.equal(isRegularSessionByLocalClock(saturdayMidday), false);
});

test("a liquid candidate passes for both margin and cash", async () => {
  await withEnv(
    {
      STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT: "0.10",
      STRATEGY_MIN_OPEN_INTEREST: "100",
      STRATEGY_PHANTOM_QUOTE_GUARD_ENABLED: "true",
    },
    () => {
      for (const accountType of ["margin", "cash"] as const) {
        const decision = evaluateLiquidityGate({
          accountType,
          askSize: 80,
          bidSize: 100,
          currentTime: mondayMidday,
          dayVolume: 1500,
          maxAllowedSpreadPct: getMaxEntrySpreadPctForAccountType(accountType, mondayMidday),
          openInterest: 500,
          spreadPct: 0.02,
        });
        assert.equal(decision.passed, true, `${accountType} should pass`);
        assert.deepEqual(decision.failedChecks, []);
        assert.deepEqual(decision.missingFields, []);
        assert.equal(decision.phantomQuote, false);
      }
    },
  );
});

test("a WEN-like wide-spread candidate is blocked for margin but passes for cash", async () => {
  // Shared gate at the deployed 0.2 (WEN cleared it at ~18.2%); margin opted
  // into a tighter 0.10 entry ceiling.
  await withEnv(
    {
      STRATEGY_MAX_OPTION_SPREAD_PCT: "0.2",
      STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT: "0.10",
    },
    () => {
      const marginDecision = evaluateLiquidityGate(wenLikeGateInput("margin"));
      assert.equal(marginDecision.passed, false);
      assert.equal(marginDecision.meetsSpreadRequirement, false);
      assert.deepEqual(marginDecision.failedChecks, ["spread"]);

      const cashDecision = evaluateLiquidityGate(wenLikeGateInput("cash"));
      assert.equal(cashDecision.passed, true);
      assert.equal(cashDecision.meetsSpreadRequirement, true);
    },
  );
});

test("defaults are non-binding: the WEN-like candidate still passes both accounts", async () => {
  // Deploy-safety: with none of the new env vars set, even a thin candidate
  // (18% spread, OI 40, askSize 1) passes exactly as it did before this gate.
  await withEnv({}, () => {
    for (const accountType of ["margin", "cash"] as const) {
      const decision = evaluateLiquidityGate(wenLikeGateInput(accountType));
      assert.equal(decision.passed, true, `${accountType} must be unchanged by default`);
      assert.deepEqual(decision.failedChecks, []);
    }
  });
});

test("open-interest floor blocks thin OI when set; boundary is inclusive", async () => {
  await withEnv({ STRATEGY_MIN_OPEN_INTEREST: "100" }, () => {
    const thin = evaluateLiquidityGate({
      ...wenLikeGateInput("cash"),
      openInterest: 40,
      spreadPct: 0.02,
    });
    assert.equal(thin.passed, false);
    assert.deepEqual(thin.failedChecks, ["open-interest"]);

    const atFloor = evaluateLiquidityGate({
      ...wenLikeGateInput("cash"),
      openInterest: 100,
      spreadPct: 0.02,
    });
    assert.equal(atFloor.passed, true);
  });
});

test("unknown open interest degrades gracefully: passes with a missing-field note", async () => {
  await withEnv({ STRATEGY_MIN_OPEN_INTEREST: "100" }, () => {
    for (const openInterest of [null, undefined, Number.NaN]) {
      const decision = evaluateLiquidityGate({
        ...wenLikeGateInput("cash"),
        openInterest,
        spreadPct: 0.02,
      });
      assert.equal(decision.passed, true, `OI ${String(openInterest)} must pass`);
      assert.ok(decision.missingFields.includes("openInterest"));
      assert.equal(decision.openInterest, null);
    }
  });
});

test("phantom sizeless quote distrusts the spread pass when the guard is enabled", async () => {
  await withEnv({ STRATEGY_PHANTOM_QUOTE_GUARD_ENABLED: "true" }, () => {
    for (const sizes of [{ askSize: 0, bidSize: 5 }, { askSize: 1, bidSize: 0 }]) {
      const decision = evaluateLiquidityGate({
        ...wenLikeGateInput("cash"),
        ...sizes,
        spreadPct: 0.02, // the spread itself would pass — that's the point
      });
      assert.equal(decision.meetsSpreadRequirement, true);
      assert.equal(decision.phantomQuote, true);
      assert.equal(decision.passed, false);
      assert.deepEqual(decision.failedChecks, ["phantom-quote"]);
    }
  });
});

test("phantom guard off by default: detection is reported but nothing is blocked", async () => {
  await withEnv({}, () => {
    const decision = evaluateLiquidityGate({
      ...wenLikeGateInput("cash"),
      askSize: 0,
      spreadPct: 0.02,
    });
    assert.equal(decision.phantomQuote, true);
    assert.equal(decision.phantomQuoteGuardEnabled, false);
    assert.equal(decision.passed, true);
  });
});

test("phantom guard never fires outside market hours (sizes stream NaN/absent when closed)", async () => {
  await withEnv({ STRATEGY_PHANTOM_QUOTE_GUARD_ENABLED: "true" }, () => {
    for (const currentTime of [mondayPreOpen, saturdayMidday]) {
      const decision = evaluateLiquidityGate({
        ...wenLikeGateInput("cash", currentTime),
        askSize: 0,
        spreadPct: 0.02,
      });
      assert.equal(decision.phantomQuote, false);
      assert.equal(decision.passed, true);
    }
  });
});

test("missing quote sizes degrade gracefully even with the guard enabled", async () => {
  await withEnv({ STRATEGY_PHANTOM_QUOTE_GUARD_ENABLED: "true" }, () => {
    const decision = evaluateLiquidityGate({
      ...wenLikeGateInput("cash"),
      askSize: undefined,
      bidSize: null,
      spreadPct: 0.02,
    });
    assert.equal(decision.phantomQuote, false, "missing size is unknown, not sizeless");
    assert.equal(decision.passed, true);
    assert.ok(decision.missingFields.includes("bidSize"));
    assert.ok(decision.missingFields.includes("askSize"));
  });
});

test("a no-quote infinite spread still fails the spread check (pre-existing behavior)", async () => {
  await withEnv({}, () => {
    const decision = evaluateLiquidityGate({
      ...wenLikeGateInput("cash"),
      spreadPct: Number.POSITIVE_INFINITY,
    });
    assert.equal(decision.passed, false);
    assert.deepEqual(decision.failedChecks, ["spread"]);
  });
});

// --- Wiring through buildTopOptionCandidateResult -------------------------
// Verifies selectionOptions.accountType actually reaches the gate and that a
// blocked candidate surfaces an honest skippedReason.

const WEN_CALL_SYMBOL = "WEN   260710C00005000";

function buildWenChain(overrides: { callOpenInterest?: number } = {}): OptionChainWithVolume {
  return {
    "underlying-symbol": "WEN",
    expirations: [
      {
        "expiration-date": "2026-07-10",
        "expiration-type": "Weekly",
        "days-to-expiration": 4,
        strikes: [
          {
            "strike-price": "5.0",
            call: WEN_CALL_SYMBOL,
            put: "WEN   260710P00005000",
            "call-streamer-symbol": ".WEN260710C5",
            "put-streamer-symbol": ".WEN260710P5",
            callVolume: 12,
            ...overrides,
          },
        ],
      },
    ],
  } as unknown as OptionChainWithVolume;
}

type BidAskQuote = Awaited<ReturnType<typeof tastytradeApi.johnsService.getBidAskForSymbol>>;

async function withPatchedQuote(quote: BidAskQuote, run: () => Promise<void>): Promise<void> {
  const original = tastytradeApi.johnsService.getBidAskForSymbol;
  tastytradeApi.johnsService.getBidAskForSymbol = async () => quote;
  try {
    await run();
  } finally {
    tastytradeApi.johnsService.getBidAskForSymbol = original;
  }
}

function selectWenCandidate(accountType: EntryAccountType) {
  return buildTopOptionCandidateResult(
    "WEN",
    "call",
    buildWenChain({ callOpenInterest: 40 }),
    5.5,
    7,
    { accountType },
    mondayMidday,
  );
}

test("selection blocks the WEN-like candidate for margin and picks it for cash", async () => {
  await withEnv(
    {
      STRATEGY_MAX_OPTION_SPREAD_PCT: "0.2",
      STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT: "0.10",
    },
    async () => {
      await withPatchedQuote({ bid: 0.85, ask: 1.02, bidSize: 5, askSize: 1 }, async () => {
        const cashResult = await selectWenCandidate("cash");
        assert.ok(cashResult, "cash selection must return a result");
        assert.equal(cashResult.symbol, WEN_CALL_SYMBOL);
        assert.equal(cashResult.maxAllowedSpreadPct, 0.2);

        const marginResult = await selectWenCandidate("margin");
        assert.ok(marginResult, "margin selection must return a result");
        assert.equal(marginResult.symbol, undefined);
        assert.match(
          String(marginResult.skippedReason),
          /all candidate spreads exceeded max allowed spread \(10\.00%\)/,
        );
      });
    },
  );
});

test("selection enforces the OI floor but passes when OI is unknown (graceful)", async () => {
  await withEnv({ STRATEGY_MIN_OPEN_INTEREST: "100" }, async () => {
    await withPatchedQuote({ bid: 0.98, ask: 1.02, bidSize: 5, askSize: 3 }, async () => {
      const thinResult = await selectWenCandidate("cash");
      assert.ok(thinResult, "thin-OI selection must return a result");
      assert.equal(thinResult.symbol, undefined);
      assert.match(
        String(thinResult.skippedReason),
        /entry liquidity gate \(open-interest\)/,
      );

      // Same floor, but the chain carries no OI data — must NOT block.
      const unknownOiResult = await buildTopOptionCandidateResult(
        "WEN",
        "call",
        buildWenChain(),
        5.5,
        7,
        { accountType: "cash" },
        mondayMidday,
      );
      assert.ok(unknownOiResult, "unknown-OI selection must return a result");
      assert.equal(unknownOiResult.symbol, WEN_CALL_SYMBOL);
    });
  });
});

test("selection distrusts a phantom sizeless quote only when the guard is enabled", async () => {
  await withPatchedQuote({ bid: 0.98, ask: 1.02, bidSize: 5, askSize: 0 }, async () => {
    await withEnv({ STRATEGY_PHANTOM_QUOTE_GUARD_ENABLED: "true" }, async () => {
      const guarded = await selectWenCandidate("cash");
      assert.ok(guarded, "guarded selection must return a result");
      assert.equal(guarded.symbol, undefined);
      assert.match(String(guarded.skippedReason), /entry liquidity gate \(phantom-quote\)/);
    });

    await withEnv({}, async () => {
      const unguarded = await selectWenCandidate("cash");
      assert.ok(unguarded, "unguarded selection must return a result");
      assert.equal(unguarded.symbol, WEN_CALL_SYMBOL, "guard off must stay log-only");
    });
  });
});
