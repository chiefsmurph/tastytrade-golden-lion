import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "os";
import * as path from "path";

// Point the store at an isolated temp dir BEFORE importing it (getStorePath
// reads BOT_DATA_DIR each call, so this keeps the suite off the real data dir).
process.env.BOT_DATA_DIR = path.join(os.tmpdir(), `gl-seed-outcome-test-${process.pid}`);

import {
  recordSeedOutcome,
  getRecentSeedOutcome,
  clearSeedOutcomeStore,
} from "~/bot/actions/seed-outcome-store";

const HOUR = 60 * 60 * 1000;

beforeEach(async () => {
  await clearSeedOutcomeStore();
});

test("records an outcome and reads it back within the recency window", async () => {
  const now = 1_000_000_000_000;
  await recordSeedOutcome({
    accountType: "cash",
    symbol: "ENVX",
    side: "call",
    state: "aborted",
    reason: "no-quote",
    observedFilled: 0,
    totalContracts: 5,
    atMs: now,
  });

  const got = await getRecentSeedOutcome("cash", "envx", "call", HOUR, now + 60_000);
  assert.ok(got, "outcome found (symbol match is case-insensitive)");
  assert.equal(got.state, "aborted");
  assert.equal(got.reason, "no-quote");
  assert.equal(got.observedFilled, 0);
  assert.equal(got.totalContracts, 5);
});

test("returns null once the outcome is older than maxAgeMs", async () => {
  const now = 1_000_000_000_000;
  await recordSeedOutcome({
    accountType: "cash",
    symbol: "ENVX",
    side: "call",
    state: "aborted",
    reason: "no-quote",
    observedFilled: 0,
    totalContracts: 5,
    atMs: now,
  });
  assert.equal(await getRecentSeedOutcome("cash", "ENVX", "call", HOUR, now + HOUR + 1), null);
});

test("returns null for an unknown key and does not cross account/side", async () => {
  const now = 1_000_000_000_000;
  await recordSeedOutcome({
    accountType: "cash",
    symbol: "ENVX",
    side: "call",
    state: "aborted",
    observedFilled: 0,
    totalContracts: 5,
    atMs: now,
  });
  assert.equal(await getRecentSeedOutcome("margin", "ENVX", "call", HOUR, now), null);
  assert.equal(await getRecentSeedOutcome("cash", "ENVX", "put", HOUR, now), null);
  assert.equal(await getRecentSeedOutcome("cash", "TE", "call", HOUR, now), null);
});

test("a later fill overwrites an earlier abort at the same key", async () => {
  const now = 1_000_000_000_000;
  await recordSeedOutcome({
    accountType: "cash", symbol: "TE", side: "call",
    state: "aborted", reason: "no-quote", observedFilled: 0, totalContracts: 5, atMs: now,
  });
  await recordSeedOutcome({
    accountType: "cash", symbol: "TE", side: "call",
    state: "filled", observedFilled: 5, totalContracts: 5, atMs: now + 60_000,
  });
  const got = await getRecentSeedOutcome("cash", "TE", "call", HOUR, now + 120_000);
  assert.equal(got?.state, "filled", "the abort no longer shadows the fill");
});

test("rows past the 24h retention window are pruned on the next write", async () => {
  const now = 1_000_000_000_000;
  const stale = now - 25 * HOUR;
  await recordSeedOutcome({
    accountType: "cash", symbol: "OLD", side: "call",
    state: "aborted", reason: "no-quote", observedFilled: 0, totalContracts: 5, atMs: stale,
  });
  // A fresh write for a different key triggers pruning keyed off the new atMs.
  await recordSeedOutcome({
    accountType: "cash", symbol: "NEW", side: "call",
    state: "aborted", reason: "no-quote", observedFilled: 0, totalContracts: 5, atMs: now,
  });
  // Even ignoring recency, the stale row is gone from the file.
  assert.equal(await getRecentSeedOutcome("cash", "OLD", "call", 999 * HOUR, now), null);
  assert.ok(await getRecentSeedOutcome("cash", "NEW", "call", HOUR, now));
});
