import test from "node:test";
import assert from "node:assert/strict";

import {
  getHeldAddAgeGivePct,
  getHeldGroupAgeDays,
  isHeldAddAgeGiveEnabled,
  HELD_ADD_AGE_GIVE_HARD_CAP_PCT,
  getHeldContractFallbackCandidate,
} from "../actions/manage-allocation";
import type { PositionGroupEvaluation } from "../evaluate-position";

const GIVE_ENV_KEYS = [
  "STRATEGY_MARGIN_HELD_ADD_AGE_GIVE_ENABLED",
  "STRATEGY_MARGIN_HELD_ADD_AGE_GIVE_FULL_DAYS",
  "STRATEGY_MARGIN_HELD_ADD_AGE_GIVE_MAX_PCT",
] as const;

function applyEnv(values: Record<string, string | undefined>): void {
  for (const key of GIVE_ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withGiveEnv(
  overrides: Partial<Record<(typeof GIVE_ENV_KEYS)[number], string>>,
  run: () => void,
): void {
  const saved = Object.fromEntries(GIVE_ENV_KEYS.map((key) => [key, process.env[key]]));
  applyEnv(overrides);
  try {
    run();
  } finally {
    applyEnv(saved);
  }
}

test("flag off (default): give is always 0 regardless of age", () => {
  withGiveEnv({}, () => {
    assert.equal(isHeldAddAgeGiveEnabled(), false);
    assert.equal(getHeldAddAgeGivePct(0), 0);
    assert.equal(getHeldAddAgeGivePct(1), 0);
    assert.equal(getHeldAddAgeGivePct(30), 0);
    assert.equal(getHeldAddAgeGivePct(null), 0);
  });
});

test("flag on: fresh position gets ~zero give, older position gets more", () => {
  withGiveEnv(
    {
      STRATEGY_MARGIN_HELD_ADD_AGE_GIVE_ENABLED: "true",
      STRATEGY_MARGIN_HELD_ADD_AGE_GIVE_FULL_DAYS: "4",
      STRATEGY_MARGIN_HELD_ADD_AGE_GIVE_MAX_PCT: "0.05",
    },
    () => {
      // Fresh (age 0) and negative/unknown → no give: don't chase a just-entered spike.
      assert.equal(getHeldAddAgeGivePct(0), 0);
      assert.equal(getHeldAddAgeGivePct(-1), 0);
      assert.equal(getHeldAddAgeGivePct(null), 0);

      // Linear ramp: half the full-age window → half the max give.
      assert.ok(Math.abs(getHeldAddAgeGivePct(2) - 0.025) < 1e-9);

      // At and beyond full age → the configured max, then flat.
      assert.ok(Math.abs(getHeldAddAgeGivePct(4) - 0.05) < 1e-9);
      assert.ok(Math.abs(getHeldAddAgeGivePct(40) - 0.05) < 1e-9);

      // Monotonic: older ⇒ at least as much give as younger.
      assert.ok(getHeldAddAgeGivePct(3) >= getHeldAddAgeGivePct(1));
    },
  );
});

test("hard cap bounds the give even when the env tunables are absurd", () => {
  withGiveEnv(
    {
      STRATEGY_MARGIN_HELD_ADD_AGE_GIVE_ENABLED: "1",
      STRATEGY_MARGIN_HELD_ADD_AGE_GIVE_FULL_DAYS: "1",
      STRATEGY_MARGIN_HELD_ADD_AGE_GIVE_MAX_PCT: "5", // 500% — clearly fat-fingered
    },
    () => {
      const give = getHeldAddAgeGivePct(365);
      assert.equal(give, HELD_ADD_AGE_GIVE_HARD_CAP_PCT);
      assert.ok(give <= HELD_ADD_AGE_GIVE_HARD_CAP_PCT);
    },
  );
});

function occSymbol(root: string, yymmdd: string, strike: string): string {
  return `${root.padEnd(6, " ")}${yymmdd}C${strike}`;
}

function buildEvaluation(snapshot: {
  symbol: string;
  bid: number;
  ask: number;
  waf: number;
  createdAt?: string;
}): PositionGroupEvaluation {
  return {
    currentReturn: 0,
    executionTargets: undefined,
    groupKey: "LCID::call",
    metrics: {
      currentAskPrice: snapshot.ask,
      currentBidPrice: snapshot.bid,
      currentTime: new Date(),
      lastActionTime: new Date(),
      weightedAverageFill: snapshot.waf,
    },
    positionSnapshots: [
      {
        currentAskPrice: snapshot.ask,
        currentBidPrice: snapshot.bid,
        lastActionTime: new Date(),
        position: {
          "account-number": "ACC-1",
          "created-at": snapshot.createdAt,
          "instrument-type": "Option",
          quantity: 1,
          symbol: snapshot.symbol,
        },
        quantityWeight: 1,
        weightedAverageFill: snapshot.waf,
      },
    ],
    positions: [
      {
        "account-number": "ACC-1",
        "created-at": snapshot.createdAt,
        "instrument-type": "Option",
        quantity: 1,
        symbol: snapshot.symbol,
      },
    ] as PositionGroupEvaluation["positions"],
    strategy: { action: "MANAGE_ALLOCATION", reason: "test" },
    underlyingSymbol: "LCID",
  };
}

test("getHeldGroupAgeDays reads the earliest created-at; null when absent", () => {
  const now = new Date("2026-07-10T10:30:00.000Z");
  const aged = buildEvaluation({
    symbol: occSymbol("LCID", "260717", "00006000"),
    bid: 0.44,
    ask: 0.46,
    waf: 0.4,
    createdAt: "2026-07-07T10:30:00.000Z",
  });
  const age = getHeldGroupAgeDays(aged, now);
  assert.ok(age !== null && Math.abs(age - 3) < 0.01);

  const undated = buildEvaluation({
    symbol: occSymbol("LCID", "260717", "00006000"),
    bid: 0.44,
    ask: 0.46,
    waf: 0.4,
  });
  assert.equal(getHeldGroupAgeDays(undated, now), null);
});

// Midday so the entry-spread ramp is at its plateau; a tight spread passes.
const at1030 = new Date("2026-07-10T10:30:00");

test("flag OFF preserves current behavior: aged position still blocked above avg", () => {
  withGiveEnv({}, () => {
    // 3 days old, ask 0.48 above 0.40 avg. With the flag off there is no give,
    // so this must be blocked exactly as before (same message shape).
    const evaluation = buildEvaluation({
      symbol: occSymbol("LCID", "260717", "00006000"),
      bid: 0.46,
      ask: 0.48,
      waf: 0.4,
      createdAt: "2026-07-07T10:30:00.000Z",
    });
    const result = getHeldContractFallbackCandidate(evaluation, "margin", at1030);
    assert.equal(result.symbol, undefined);
    assert.match(result.skippedReason ?? "", /above our avg .*average down only/);
  });
});

test("flag ON: aged position clears the give; fresh position still blocked", () => {
  withGiveEnv(
    {
      STRATEGY_MARGIN_HELD_ADD_AGE_GIVE_ENABLED: "true",
      STRATEGY_MARGIN_HELD_ADD_AGE_GIVE_FULL_DAYS: "3",
      STRATEGY_MARGIN_HELD_ADD_AGE_GIVE_MAX_PCT: "0.05",
    },
    () => {
      // 3+ days old → full 5% give. avg 0.40 → max add 0.42; ask 0.41 is allowed.
      const aged = buildEvaluation({
        symbol: occSymbol("LCID", "260717", "00006000"),
        bid: 0.4,
        ask: 0.41,
        waf: 0.4,
        createdAt: "2026-07-07T10:30:00.000Z",
      });
      const agedResult = getHeldContractFallbackCandidate(aged, "margin", at1030);
      assert.equal(
        agedResult.symbol,
        occSymbol("LCID", "260717", "00006000"),
        agedResult.skippedReason ?? "expected aged position to clear the give",
      );
      assert.equal(agedResult.skippedReason, undefined);

      // Same quote but freshly opened today → age ~0 → no give → still blocked.
      const fresh = buildEvaluation({
        symbol: occSymbol("LCID", "260717", "00006000"),
        bid: 0.4,
        ask: 0.41,
        waf: 0.4,
        createdAt: "2026-07-10T10:00:00.000Z",
      });
      const freshResult = getHeldContractFallbackCandidate(fresh, "margin", at1030);
      assert.equal(freshResult.symbol, undefined);
      assert.match(freshResult.skippedReason ?? "", /average down only/);
    },
  );
});
