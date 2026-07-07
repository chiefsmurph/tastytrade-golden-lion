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
  reconcileWithBrokerPositions,
  recordPositionClosed,
  recordPositionOpened,
  syncPositionOpens,
  type PositionRegistryEntry,
  toHeldUnderlyingSymbols,
  toPositionOpenSnapshots,
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

test("toPositionOpenSnapshots skips zero-quantity groups and keeps held ones", () => {
  const earliestCreatedAt = isoDaysAgo(1);
  const todayCreatedAt = new Date().toISOString();

  const snapshots = toPositionOpenSnapshots([
    {
      underlyingSymbol: "MARA",
      groupKey: "MARA::call",
      positions: [{ quantity: 0, "created-at": todayCreatedAt }],
    },
    {
      underlyingSymbol: "CLSK",
      groupKey: "CLSK::call",
      positions: [
        { quantity: 0, "created-at": earliestCreatedAt },
        { quantity: "2", "created-at": todayCreatedAt },
      ],
    },
  ]);

  assert.deepEqual(snapshots, [
    { symbol: "CLSK", side: "call", openedAt: earliestCreatedAt },
  ]);
});

test("toHeldUnderlyingSymbols reports only non-zero-quantity groups", () => {
  const held = toHeldUnderlyingSymbols([
    { underlyingSymbol: "mara ", groupKey: "MARA::call", positions: [{ quantity: 3 }] },
    { underlyingSymbol: "CLSK", groupKey: "CLSK::call", positions: [{ quantity: 0 }] },
    { underlyingSymbol: "EOSE", groupKey: "EOSE::none", positions: [{ quantity: "1" }] },
  ]);

  assert.deepEqual([...held].sort(), ["EOSE", "MARA"]);
});

test("a quantity-0 broker row does not resurrect a closed same-day entry", async () => {
  await recordPositionOpened("ACC-RESURRECT-1", "MARA", "call");
  await recordPositionClosed("ACC-RESURRECT-1", "MARA", "99");

  // Later cycle the same day: the broker still lists the closed position
  // with quantity 0. Backfill must not turn the closed entry OPEN again.
  await syncPositionOpens(
    "ACC-RESURRECT-1",
    toPositionOpenSnapshots([
      {
        underlyingSymbol: "MARA",
        groupKey: "MARA::call",
        positions: [{ quantity: 0, "created-at": new Date().toISOString() }],
      },
    ]),
  );

  const entry = await getRegistryEntry("ACC-RESURRECT-1", "MARA");
  assert.ok(entry?.closedAt);
  assert.equal(entry?.closingOrderId, "99");
});

test("reconcile marks tracked-but-not-held entries closed", async () => {
  await syncPositionOpens("ACC-RECON-1", [
    { symbol: "MARA", side: "call", openedAt: isoDaysAgo(4) },
    { symbol: "CLSK", side: "call", openedAt: isoDaysAgo(4) },
  ]);

  const reconciled = await reconcileWithBrokerPositions("ACC-RECON-1", []);

  assert.deepEqual(reconciled.map((entry) => entry.symbol).sort(), ["CLSK", "MARA"]);
  for (const symbol of ["MARA", "CLSK"]) {
    const entry = await getRegistryEntry("ACC-RECON-1", symbol);
    assert.ok(entry?.closedAt);
    assert.equal(entry?.closedVia, "broker-reconcile");
    assert.equal(await isOvernightPosition("ACC-RECON-1", symbol), false);
  }
});

test("reconcile leaves held symbols open (overnight cash hold)", async () => {
  await syncPositionOpens("ACC-RECON-2", [
    { symbol: "EOSE", side: "call", openedAt: isoDaysAgo(4) },
  ]);

  const reconciled = await reconcileWithBrokerPositions("ACC-RECON-2", ["EOSE"]);

  assert.equal(reconciled.length, 0);
  const entry = await getRegistryEntry("ACC-RECON-2", "EOSE");
  assert.equal(entry?.closedAt, undefined);
  assert.equal(await isOvernightPosition("ACC-RECON-2", "EOSE"), true);
});

test("reconcile held-symbol matching tolerates case and whitespace", async () => {
  await syncPositionOpens("ACC-RECON-3", [
    { symbol: "MARA", side: "call", openedAt: isoDaysAgo(4) },
  ]);

  const reconciled = await reconcileWithBrokerPositions("ACC-RECON-3", [" mara "]);

  assert.equal(reconciled.length, 0);
  assert.equal((await getRegistryEntry("ACC-RECON-3", "MARA"))?.closedAt, undefined);
});

test("reconcile only touches entries for the given account", async () => {
  await syncPositionOpens("ACC-RECON-4A", [
    { symbol: "MARA", side: "call", openedAt: isoDaysAgo(4) },
  ]);
  await syncPositionOpens("ACC-RECON-4B", [
    { symbol: "MARA", side: "call", openedAt: isoDaysAgo(4) },
  ]);

  const reconciled = await reconcileWithBrokerPositions("ACC-RECON-4A", []);

  assert.equal(reconciled.length, 1);
  assert.ok((await getRegistryEntry("ACC-RECON-4A", "MARA"))?.closedAt);
  assert.equal((await getRegistryEntry("ACC-RECON-4B", "MARA"))?.closedAt, undefined);
});

test("reconcile skips entries opened within the placement grace window", async () => {
  await recordPositionOpened("ACC-RECON-5", "SOFI", "call");

  const reconciled = await reconcileWithBrokerPositions("ACC-RECON-5", []);

  assert.equal(reconciled.length, 0);
  assert.equal((await getRegistryEntry("ACC-RECON-5", "SOFI"))?.closedAt, undefined);
});

test("reconcile is idempotent — already-closed entries are not re-reconciled", async () => {
  await syncPositionOpens("ACC-RECON-6", [
    { symbol: "MARA", side: "call", openedAt: isoDaysAgo(4) },
  ]);

  const first = await reconcileWithBrokerPositions("ACC-RECON-6", []);
  const firstClosedAt = (await getRegistryEntry("ACC-RECON-6", "MARA"))?.closedAt;
  const second = await reconcileWithBrokerPositions("ACC-RECON-6", []);

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal((await getRegistryEntry("ACC-RECON-6", "MARA"))?.closedAt, firstClosedAt);
});

test("a re-entry re-registers via syncPositionOpens after reconcile closed the stale entry", async () => {
  await syncPositionOpens("ACC-RECON-7", [
    { symbol: "MARA", side: "call", openedAt: isoDaysAgo(4) },
  ]);
  await reconcileWithBrokerPositions("ACC-RECON-7", []);

  // The symbol is bought again today; the stale entry no longer blocks the
  // backfill, so the fresh open registers and is not treated as overnight.
  const reopenedAt = new Date().toISOString();
  await syncPositionOpens("ACC-RECON-7", [
    { symbol: "MARA", side: "call", openedAt: reopenedAt },
  ]);

  const entry = await getRegistryEntry("ACC-RECON-7", "MARA");
  assert.equal(entry?.openedAt, reopenedAt);
  assert.equal(entry?.closedAt, undefined);
  assert.equal(await isOvernightPosition("ACC-RECON-7", "MARA"), false);
});
