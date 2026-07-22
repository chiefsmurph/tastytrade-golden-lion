import test from "node:test";
import assert from "node:assert/strict";

import { getHeldContractFallbackCandidate } from "../actions/manage-allocation";
import { isCostBlockedSeedReason, isNoFittingSeedCandidateReason } from "../run-cycle-seed";
import type { PositionGroupEvaluation } from "../evaluate-position";

function occSymbol(root: string, yymmdd: string, strike: string): string {
  return `${root.padEnd(6, " ")}${yymmdd}C${strike}`;
}

function buildEvaluation(
  snapshots: Array<{
    symbol: string;
    bid: number;
    ask: number;
    quantityWeight?: number;
    waf?: number;
  }>,
): PositionGroupEvaluation {
  return {
    currentReturn: 0,
    executionTargets: undefined,
    groupKey: "LCID::call",
    metrics: {
      currentAskPrice: snapshots[0]?.ask ?? 0,
      currentBidPrice: snapshots[0]?.bid ?? 0,
      currentTime: new Date(),
      lastActionTime: new Date(),
      weightedAverageFill: 1,
    },
    positionSnapshots: snapshots.map((snapshot) => ({
      currentAskPrice: snapshot.ask,
      currentBidPrice: snapshot.bid,
      lastActionTime: new Date(),
      position: {
        "account-number": "ACC-1",
        "instrument-type": "Option",
        quantity: 1,
        symbol: snapshot.symbol,
      },
      quantityWeight: snapshot.quantityWeight ?? 1,
      weightedAverageFill: snapshot.waf ?? 1,
    })),
    positions: snapshots.map((snapshot) => ({
      "account-number": "ACC-1",
      "instrument-type": "Option",
      quantity: 1,
      symbol: snapshot.symbol,
    })) as PositionGroupEvaluation["positions"],
    strategy: { action: "MANAGE_ALLOCATION", reason: "test" },
    underlyingSymbol: "LCID",
  };
}

// Midday: morning entry-spread ramp is at its 30% plateau
const at1030 = new Date("2026-07-02T10:30:00");

test("falls back to the held contract when it passes spread and DTE guards (LCID shape)", () => {
  // Held 15 DTE from 2026-07-02: expiry 2026-07-17, tight 4.4% spread
  const evaluation = buildEvaluation([
    { symbol: occSymbol("LCID", "260717", "00006000"), bid: 0.44, ask: 0.46 },
  ]);

  const result = getHeldContractFallbackCandidate(evaluation, "cash", at1030);

  assert.equal(result.symbol, occSymbol("LCID", "260717", "00006000"));
  assert.equal(result.dte, 15);
  assert.equal(result.skippedReason, undefined);
});

test("rejects the held contract when its spread exceeds the time-aware entry limit", () => {
  // 28.57% spread at 07:46 → 25% morning threshold applies
  const evaluation = buildEvaluation([
    { symbol: occSymbol("LCID", "260717", "00006000"), bid: 0.42, ask: 0.56 },
  ]);

  const result = getHeldContractFallbackCandidate(
    evaluation,
    "cash",
    new Date("2026-07-02T07:46:00"),
  );

  assert.equal(result.symbol, undefined);
  assert.match(result.skippedReason ?? "", /spread .* exceeds/);
});

test("rejects a contract expiring today for cash accounts but allows it for margin", () => {
  const expiresToday = occSymbol("LCID", "260702", "00006000");
  const evaluation = buildEvaluation([
    { symbol: expiresToday, bid: 0.44, ask: 0.46 },
  ]);

  const cashResult = getHeldContractFallbackCandidate(evaluation, "cash", at1030);
  assert.equal(cashResult.symbol, undefined);
  assert.match(cashResult.skippedReason ?? "", /too close to expiry/);

  const marginResult = getHeldContractFallbackCandidate(evaluation, "margin", at1030);
  assert.equal(marginResult.symbol, expiresToday);
  assert.equal(marginResult.dte, 0);
});

test("margin entry-spread override tightens the held-contract fallback too", () => {
  // WEN-shaped 18.2% spread: within the shared 30% gate, outside a 10% margin
  // entry ceiling. Cash must keep the shared behavior.
  const evaluation = buildEvaluation([
    { symbol: occSymbol("LCID", "260717", "00006000"), bid: 0.85, ask: 1.02 },
  ]);

  const originalEnv = process.env.STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT;
  process.env.STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT = "0.10";

  try {
    const marginResult = getHeldContractFallbackCandidate(evaluation, "margin", at1030);
    assert.equal(marginResult.symbol, undefined);
    assert.match(marginResult.skippedReason ?? "", /spread .* exceeds 10\.00% max/);

    const cashResult = getHeldContractFallbackCandidate(evaluation, "cash", at1030);
    assert.equal(cashResult.symbol, occSymbol("LCID", "260717", "00006000"));
    assert.equal(cashResult.skippedReason, undefined);
  } finally {
    if (originalEnv !== undefined) {
      process.env.STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT = originalEnv;
    } else {
      delete process.env.STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT;
    }
  }
});

test("margin held add blocked when ask is above our weighted-average fill (average down only)", () => {
  // Tight 4.3% spread so the liquidity gate passes; ask 0.48 sits above our 0.40
  // average, so margin must not average up into it.
  const evaluation = buildEvaluation([
    { symbol: occSymbol("LCID", "260717", "00006000"), bid: 0.46, ask: 0.48, waf: 0.4 },
  ]);

  const result = getHeldContractFallbackCandidate(evaluation, "margin", at1030);

  assert.equal(result.symbol, undefined);
  assert.match(result.skippedReason ?? "", /above our avg .*average down only/);
});

test("margin held add allowed when ask is at or below our average; cash is never guarded", () => {
  // Ask 0.46 sits below our 0.60 average → margin may keep averaging down.
  const evaluation = buildEvaluation([
    { symbol: occSymbol("LCID", "260717", "00006000"), bid: 0.44, ask: 0.46, waf: 0.6 },
  ]);

  const marginResult = getHeldContractFallbackCandidate(evaluation, "margin", at1030);
  assert.equal(marginResult.symbol, occSymbol("LCID", "260717", "00006000"));
  assert.equal(marginResult.skippedReason, undefined);

  // Same contract priced above a low 0.20 average: cash keeps adding (unguarded),
  // margin would be blocked — proving the guard is margin-only.
  const aboveAvg = buildEvaluation([
    { symbol: occSymbol("LCID", "260717", "00006000"), bid: 0.44, ask: 0.46, waf: 0.2 },
  ]);
  const cashResult = getHeldContractFallbackCandidate(aboveAvg, "cash", at1030);
  assert.equal(cashResult.symbol, occSymbol("LCID", "260717", "00006000"));
  assert.equal(cashResult.skippedReason, undefined);
});

test("picks the dominant holding when the group spans multiple contracts", () => {
  const small = occSymbol("LCID", "260710", "00005500");
  const dominant = occSymbol("LCID", "260717", "00006000");
  const evaluation = buildEvaluation([
    { symbol: small, bid: 0.3, ask: 0.32, quantityWeight: 1 },
    { symbol: dominant, bid: 0.44, ask: 0.46, quantityWeight: 5 },
  ]);

  const result = getHeldContractFallbackCandidate(evaluation, "cash", at1030);

  assert.equal(result.symbol, dominant);
});

test("returns a skip when the group holds no parseable option contract", () => {
  const evaluation = buildEvaluation([{ symbol: "LCID", bid: 6, ask: 6.02 }]);

  const result = getHeldContractFallbackCandidate(evaluation, "cash", at1030);

  assert.equal(result.symbol, undefined);
  assert.match(result.skippedReason ?? "", /no held option contract/);
});

test("rejects the held contract when its quote is missing", () => {
  const evaluation = buildEvaluation([
    { symbol: occSymbol("LCID", "260717", "00006000"), bid: 0, ask: 0 },
  ]);

  const result = getHeldContractFallbackCandidate(evaluation, "cash", at1030);

  assert.equal(result.symbol, undefined);
  assert.match(result.skippedReason ?? "", /quote unavailable/);
});

test("isNoFittingSeedCandidateReason matches only candidate-fit failures", () => {
  assert.equal(
    isNoFittingSeedCandidateReason("no candidate found in cash seed DTE window 14-30"),
    true,
  );
  assert.equal(
    isNoFittingSeedCandidateReason("cash seed candidate DTE must be within 14-30"),
    true,
  );
  assert.equal(isNoFittingSeedCandidateReason("no option candidate found"), true);
  assert.equal(isNoFittingSeedCandidateReason("candidate quote symbol unavailable"), true);

  assert.equal(isNoFittingSeedCandidateReason(null), false);
  assert.equal(isNoFittingSeedCandidateReason(undefined), false);
  assert.equal(
    isNoFittingSeedCandidateReason("underlying already has an open position"),
    false,
  );
  assert.equal(
    isNoFittingSeedCandidateReason("time-of-day strategy is not allowing new accumulation"),
    false,
  );
  assert.equal(
    isNoFittingSeedCandidateReason(
      "insufficient effective buying power for seed order — capped at 98.80 by per-action max buy pct, order cost 183.00",
    ),
    false,
  );
});

test("isCostBlockedSeedReason matches only buying-power failures", () => {
  assert.equal(
    isCostBlockedSeedReason(
      "insufficient effective buying power for seed order — capped at 98.80 by per-action max buy pct, order cost 183.00",
    ),
    true,
  );
  // The old dollar-cap reason is retired (BOT_MAX_SEED_ORDER_COST removed) and
  // is no longer produced, so it no longer classifies as cost-blocked.
  assert.equal(
    isCostBlockedSeedReason(
      "seed order cost 250.00 exceeds BOT_MAX_SEED_ORDER_COST 200.00",
    ),
    false,
  );

  assert.equal(isCostBlockedSeedReason(null), false);
  assert.equal(isCostBlockedSeedReason(undefined), false);
  assert.equal(
    isCostBlockedSeedReason("cash seed candidate DTE must be within 14-30"),
    false,
  );
  assert.equal(
    isCostBlockedSeedReason("underlying already has an open position"),
    false,
  );
});
