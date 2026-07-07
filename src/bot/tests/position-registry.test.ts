import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.BOT_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "position-registry-test-"),
);

import {
  getRegistryEntry,
  isOvernightPosition,
  recordPositionClosed,
  recordPositionOpened,
  syncPositionOpens,
  type PositionRegistryEntry,
} from "../position-registry";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function closeTo(actual: number | null | undefined, expected: number): boolean {
  return typeof actual === "number" && Math.abs(actual - expected) < 1e-9;
}

// Asserts the entry-side context (v8 #13) recorded on a registry entry. Narrows
// to a present entry first so the field reads stay branch-free (keeps this test
// helper simple); closeTo holds the float tolerance.
function assertEntryContext(
  entry: PositionRegistryEntry | null,
  expectedSpreadPct: number,
  expectedGateScore: number,
): void {
  assert.ok(entry, "expected a registry entry");
  assert.ok(closeTo(entry.entrySpreadPct, expectedSpreadPct), "entrySpreadPct");
  assert.equal(entry.gateScoreAtEntry, expectedGateScore);
}

// The inverse: a registry entry with no entry-side context recorded yet.
function assertNoEntryContext(entry: PositionRegistryEntry | null): void {
  assert.ok(entry, "expected a registry entry");
  assert.equal(entry.entrySpreadPct, null);
  assert.equal(entry.gateScoreAtEntry, null);
}

test("syncPositionOpens backfills a missing open from broker created-at", async () => {
  const openedAt = isoDaysAgo(1);
  await syncPositionOpens("ACC-SYNC-1", [
    { symbol: "LCID", side: "call", openedAt },
  ]);

  const entry = await getRegistryEntry("ACC-SYNC-1", "LCID");
  assert.equal(entry?.openedAt, openedAt);
  assert.equal(entry?.side, "call");
  assert.equal(await isOvernightPosition("ACC-SYNC-1", "LCID"), true);
});

test("syncPositionOpens does not overwrite an existing open entry", async () => {
  await recordPositionOpened("ACC-SYNC-2", "RUM", "call");
  const before = await getRegistryEntry("ACC-SYNC-2", "RUM");

  await syncPositionOpens("ACC-SYNC-2", [
    { symbol: "RUM", side: "put", openedAt: isoDaysAgo(3) },
  ]);

  const after = await getRegistryEntry("ACC-SYNC-2", "RUM");
  assert.equal(after?.openedAt, before?.openedAt);
  assert.equal(after?.side, "call");
});

test("a position synced with today's created-at is not overnight", async () => {
  await syncPositionOpens("ACC-SYNC-3", [
    { symbol: "SOFI", side: "call", openedAt: new Date().toISOString() },
  ]);

  assert.equal(await isOvernightPosition("ACC-SYNC-3", "SOFI"), false);
});

test("recordPositionClosed uses the openedAt fallback when no open entry exists", async () => {
  const openedAt = isoDaysAgo(2);
  await recordPositionClosed("ACC-CLOSE-1", "PLTR", "42", openedAt);

  const entry = await getRegistryEntry("ACC-CLOSE-1", "PLTR");
  assert.equal(entry?.openedAt, openedAt);
  assert.equal(entry?.closingOrderId, "42");
  assert.ok(entry?.closedAt);
});

test("recordPositionClosed attaches to an existing open entry", async () => {
  const openedAt = isoDaysAgo(1);
  await syncPositionOpens("ACC-CLOSE-2", [
    { symbol: "HOOD", side: "call", openedAt },
  ]);

  await recordPositionClosed("ACC-CLOSE-2", "HOOD", "77", isoDaysAgo(5));

  const entry = await getRegistryEntry("ACC-CLOSE-2", "HOOD");
  assert.equal(entry?.openedAt, openedAt);
  assert.equal(entry?.closingOrderId, "77");
  assert.ok(entry?.closedAt);
});

// v8 #13: entry-side quality (spread + gate score) is captured at open so the
// P&L ledger can later attribute entry quality onto the close-side row.
test("syncPositionOpens captures entry context on a new open", async () => {
  await syncPositionOpens("ACC-ENTRY-1", [
    {
      symbol: "WEN",
      side: "call",
      openedAt: new Date().toISOString(),
      entryContext: { entrySpreadPct: 0.18, gateScoreAtEntry: 6 },
    },
  ]);

  const entry = await getRegistryEntry("ACC-ENTRY-1", "WEN");
  assertEntryContext(entry, 0.18, 6);
});

test("syncPositionOpens backfills entry context onto an entry that lacks it", async () => {
  // A seed path opened the position with no gate data.
  await recordPositionOpened("ACC-ENTRY-2", "MARA", "call");
  const before = await getRegistryEntry("ACC-ENTRY-2", "MARA");
  assertNoEntryContext(before);

  // A later cycle with quotes/gate backfills it (openedAt preserved).
  await syncPositionOpens("ACC-ENTRY-2", [
    {
      symbol: "MARA",
      side: "call",
      openedAt: isoDaysAgo(3),
      entryContext: { entrySpreadPct: 0.12, gateScoreAtEntry: 4 },
    },
  ]);

  const after = await getRegistryEntry("ACC-ENTRY-2", "MARA");
  assert.equal(after?.openedAt, before?.openedAt);
  assertEntryContext(after, 0.12, 4);
});

test("entry context is not overwritten once recorded (earliest observation wins)", async () => {
  await syncPositionOpens("ACC-ENTRY-3", [
    {
      symbol: "SOFI",
      side: "call",
      openedAt: new Date().toISOString(),
      entryContext: { entrySpreadPct: 0.1, gateScoreAtEntry: 7 },
    },
  ]);

  await syncPositionOpens("ACC-ENTRY-3", [
    {
      symbol: "SOFI",
      side: "call",
      openedAt: new Date().toISOString(),
      entryContext: { entrySpreadPct: 0.5, gateScoreAtEntry: 1 },
    },
  ]);

  const entry = await getRegistryEntry("ACC-ENTRY-3", "SOFI");
  assertEntryContext(entry, 0.1, 7);
});

test("recordPositionOpened captures entry context on a fresh open", async () => {
  await recordPositionOpened("ACC-ENTRY-4", "PLTR", "call", {
    entrySpreadPct: 0.09,
    gateScoreAtEntry: 5,
  });

  const entry = await getRegistryEntry("ACC-ENTRY-4", "PLTR");
  assertEntryContext(entry, 0.09, 5);
});
