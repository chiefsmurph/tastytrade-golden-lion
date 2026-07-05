import test from "node:test";
import assert from "node:assert/strict";

import {
  isWithinCashAccountSeedDteRange,
  deriveSeedContractSymbols,
  computeSeedQuotePrices,
  checkCashSeedDte,
  checkSeedAffordability,
  extractDryRunSkipReason,
  type SeedSymbolResult,
} from "../seed-symbol";
import {
  CASH_ACCOUNT_SEED_MIN_DTE,
  CASH_ACCOUNT_SEED_MAX_DTE,
  type TopOptionCandidateForSymbolResult,
} from "~/strategy/option-candidate";
import type { EffectiveBuyingPowerSummary } from "../effective-buying-power";

const cand = (obj: Record<string, unknown>) =>
  obj as TopOptionCandidateForSymbolResult;

test("isWithinCashAccountSeedDteRange enforces 14-30 inclusive", () => {
  assert.equal(isWithinCashAccountSeedDteRange(13), false);
  assert.equal(isWithinCashAccountSeedDteRange(14), true);
  assert.equal(isWithinCashAccountSeedDteRange(21), true);
  assert.equal(isWithinCashAccountSeedDteRange(30), true);
  assert.equal(isWithinCashAccountSeedDteRange(31), false);
  assert.equal(isWithinCashAccountSeedDteRange(undefined), false);
  assert.equal(isWithinCashAccountSeedDteRange(null), false);
});

test("deriveSeedContractSymbols prefers explicit symbol + streamerSymbol", () => {
  const result = deriveSeedContractSymbols(
    cand({ symbol: "SPY  240119C500", streamerSymbol: ".SPY240119C500" }),
    "call",
  );
  assert.deepEqual(result, {
    candidateSymbol: "SPY  240119C500",
    quoteSymbol: ".SPY240119C500",
  });
});

test("deriveSeedContractSymbols uses call/put side fields when no symbol", () => {
  const callResult = deriveSeedContractSymbols(
    cand({ call: "C", "call-streamer-symbol": ".C", put: "P", "put-streamer-symbol": ".P" }),
    "call",
  );
  assert.deepEqual(callResult, { candidateSymbol: "C", quoteSymbol: ".C" });

  const putResult = deriveSeedContractSymbols(
    cand({ call: "C", "call-streamer-symbol": ".C", put: "P", "put-streamer-symbol": ".P" }),
    "put",
  );
  assert.deepEqual(putResult, { candidateSymbol: "P", quoteSymbol: ".P" });
});

test("deriveSeedContractSymbols falls back quoteSymbol to candidateSymbol", () => {
  const result = deriveSeedContractSymbols(cand({ symbol: "ONLY" }), "call");
  assert.deepEqual(result, { candidateSymbol: "ONLY", quoteSymbol: "ONLY" });
});

test("deriveSeedContractSymbols returns undefineds for null candidate", () => {
  assert.deepEqual(deriveSeedContractSymbols(null, "call"), {
    candidateSymbol: undefined,
    quoteSymbol: undefined,
  });
  assert.deepEqual(deriveSeedContractSymbols(undefined, "put"), {
    candidateSymbol: undefined,
    quoteSymbol: undefined,
  });
});

test("computeSeedQuotePrices computes mid and honors priceMode", () => {
  assert.deepEqual(computeSeedQuotePrices({ bid: 1, ask: 3 }, "mid"), {
    bidPrice: 1,
    askPrice: 3,
    midPrice: 2,
    selectedPrice: 2,
  });
  assert.deepEqual(computeSeedQuotePrices({ bid: 1, ask: 3 }, "ask"), {
    bidPrice: 1,
    askPrice: 3,
    midPrice: 2,
    selectedPrice: 3,
  });
});

test("computeSeedQuotePrices falls back mid to ask when bid is missing", () => {
  assert.deepEqual(computeSeedQuotePrices({ ask: 3 }, "mid"), {
    bidPrice: 0,
    askPrice: 3,
    midPrice: 3,
    selectedPrice: 3,
  });
});

test("computeSeedQuotePrices defaults ask to bid when ask is missing", () => {
  assert.deepEqual(computeSeedQuotePrices({ bid: 2 }, "ask"), {
    bidPrice: 2,
    askPrice: 2,
    midPrice: 2,
    selectedPrice: 2,
  });
});

test("computeSeedQuotePrices zeroes out on null quote", () => {
  assert.deepEqual(computeSeedQuotePrices(null, "ask"), {
    bidPrice: 0,
    askPrice: 0,
    midPrice: 0,
    selectedPrice: 0,
  });
});

const baseResult: SeedSymbolResult = {
  accountNumber: "ACCT",
  placedOrder: false,
  side: "call",
  symbol: "TEST",
};

test("checkCashSeedDte is a no-op for margin accounts and explicit contracts", () => {
  assert.equal(checkCashSeedDte("margin", undefined, cand({}), 5, baseResult), null);
  assert.equal(
    checkCashSeedDte("cash", { symbol: "X" }, cand({}), 5, baseResult),
    null,
  );
});

test("checkCashSeedDte skips on cash DTE fallback with the window reason", () => {
  const result = checkCashSeedDte(
    "cash",
    undefined,
    cand({ usedDteFallback: true }),
    undefined,
    baseResult,
  );
  assert.equal(
    result?.skippedReason,
    `no candidate found in cash seed DTE window ${CASH_ACCOUNT_SEED_MIN_DTE}-${CASH_ACCOUNT_SEED_MAX_DTE}`,
  );
  assert.equal(result?.accountNumber, "ACCT");
});

test("checkCashSeedDte skips when cash candidate DTE is out of range", () => {
  const result = checkCashSeedDte("cash", undefined, cand({}), 5, baseResult);
  assert.equal(
    result?.skippedReason,
    `cash seed candidate DTE must be within ${CASH_ACCOUNT_SEED_MIN_DTE}-${CASH_ACCOUNT_SEED_MAX_DTE}`,
  );
});

test("checkCashSeedDte passes when cash candidate DTE is in range", () => {
  assert.equal(checkCashSeedDte("cash", undefined, cand({}), 21, baseResult), null);
});

const costResult: SeedSymbolResult = {
  ...baseResult,
  estimatedOrderCost: 200,
  limitPrice: 2,
};

const bpSummary: EffectiveBuyingPowerSummary = {
  buyingPowerRemaining: 100,
  currentExposurePct: 0,
  currentExposureValue: 0,
  effectiveBuyingPower: 100,
  exposureHeadroom: 100,
  limitingFactor: "per-action-cap",
  maxBuyAmountPerAction: 100,
  targetExposurePct: 0,
  targetExposureValue: 0,
  totalCapital: 1000,
};

test("checkSeedAffordability skips when cost exceeds the seed cap", () => {
  const result = checkSeedAffordability(600, 500, 100000, bpSummary, costResult);
  assert.equal(
    result?.skippedReason,
    "seed order cost 600.00 exceeds BOT_MAX_SEED_ORDER_COST 500.00",
  );
});

test("checkSeedAffordability skips when cost exceeds buying power", () => {
  const result = checkSeedAffordability(200, 500, 100, bpSummary, costResult);
  assert.equal(
    result?.skippedReason,
    "insufficient effective buying power for seed order — capped at 100.00 by per-action max buy pct, order cost 200.00",
  );
});

test("checkSeedAffordability passes when affordable", () => {
  assert.equal(checkSeedAffordability(200, 500, 100000, bpSummary, costResult), null);
});

test("extractDryRunSkipReason unwraps broker error shapes", () => {
  assert.equal(extractDryRunSkipReason("nope"), "seed order dry run failed");

  const withBrokerError = Object.assign(new Error("outer"), {
    response: { data: { error: { message: "broker rejected" } } },
  });
  assert.equal(extractDryRunSkipReason(withBrokerError), "broker rejected");

  const withDataMessage = Object.assign(new Error("outer"), {
    response: { data: { message: "data message" } },
  });
  assert.equal(extractDryRunSkipReason(withDataMessage), "data message");

  assert.equal(extractDryRunSkipReason(new Error("plain message")), "plain message");
  assert.equal(extractDryRunSkipReason(new Error("")), "seed order dry run failed");
});
