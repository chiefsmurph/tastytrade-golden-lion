import test from "node:test";
import assert from "node:assert/strict";

import {
  CASH_ACCOUNT_SEED_MIN_DTE,
  CASH_ACCOUNT_SEED_MAX_DTE,
} from "~/strategy/option-candidate";
import {
  classifySeedRejection,
  recordSeedAttempt,
  recordSeedSkip,
  getSeedRejectionScoreboard,
  clearSeedRejectionScoreboard,
} from "../seed-rejection-scoreboard";

test("classifySeedRejection buckets the live DTE-window skip strings", () => {
  assert.equal(
    classifySeedRejection(
      `cash seed candidate DTE must be within ${CASH_ACCOUNT_SEED_MIN_DTE}-${CASH_ACCOUNT_SEED_MAX_DTE}`,
    ),
    "dte-empty",
  );
  assert.equal(
    classifySeedRejection(
      `no candidate found in cash seed DTE window ${CASH_ACCOUNT_SEED_MIN_DTE}-${CASH_ACCOUNT_SEED_MAX_DTE}`,
    ),
    "dte-empty",
  );
});

test("classifySeedRejection buckets no-chain / candidate reasons", () => {
  assert.equal(classifySeedRejection("no option candidate found"), "no-chain");
  assert.equal(classifySeedRejection("candidate quote symbol unavailable"), "no-chain");
  assert.equal(classifySeedRejection("candidate mid quote unavailable"), "no-chain");
});

test("classifySeedRejection buckets liquidity / cost / cooldown / gate", () => {
  assert.equal(classifySeedRejection("spread 42% exceeds max"), "liquidity");
  assert.equal(
    classifySeedRejection("seed order cost 620.00 exceeds BOT_MAX_SEED_ORDER_COST 500.00"),
    "cost",
  );
  assert.equal(
    classifySeedRejection("insufficient effective buying power for seed order"),
    "cost",
  );
  assert.equal(classifySeedRejection("unfavorable entry: limit price 2.10 > cash fill 1.90"), "cost");
  assert.equal(classifySeedRejection("seed suppressed by cooldown"), "cooldown");
  assert.equal(classifySeedRejection("underlying already has an open position"), "gate");
  assert.equal(classifySeedRejection("time-of-day strategy is not allowing new accumulation"), "gate");
  assert.equal(classifySeedRejection("seed gate: iv rank too low"), "gate");
});

test("classifySeedRejection falls back to other for empty/unknown reasons", () => {
  assert.equal(classifySeedRejection(""), "other");
  assert.equal(classifySeedRejection(null), "other");
  assert.equal(classifySeedRejection(undefined), "other");
  assert.equal(classifySeedRejection("some brand new broker error"), "other");
});

test("recordSeedAttempt/recordSeedSkip aggregate per account per day", () => {
  clearSeedRejectionScoreboard();
  const acc = "5W-TEST";
  const date = "2026-07-21";

  recordSeedAttempt(acc, { placedOrder: true }, date);
  recordSeedAttempt(
    acc,
    { placedOrder: false, skippedReason: "cash seed candidate DTE must be within 14-30" },
    date,
  );
  recordSeedAttempt(
    acc,
    { placedOrder: false, skippedReason: "cash seed candidate DTE must be within 14-30" },
    date,
  );
  recordSeedSkip(acc, "seed suppressed by cooldown", date);

  const board = getSeedRejectionScoreboard(acc, date);
  assert.equal(board.placed, 1);
  assert.equal(board["dte-empty"], 2);
  assert.equal(board.cooldown, 1);
  assert.equal(board["no-chain"], 0);

  // A different account/day is isolated and returns a fresh zeroed board.
  const other = getSeedRejectionScoreboard("OTHER", date);
  assert.equal(other.placed, 0);
  assert.equal(other["dte-empty"], 0);
});
