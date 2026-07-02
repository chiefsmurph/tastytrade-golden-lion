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
} from "../position-registry";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
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
