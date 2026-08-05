import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  isScaled,
  markScaled,
  clearScaled,
  pruneOpenGroups,
} from "~/bot/actions/scale-out-store";

// Exercises the persisted store against a real temp BOT_DATA_DIR — this is the
// bug-prone part (a stale/mis-keyed flag would freeze a re-entered position),
// so cover it directly rather than mocking fs.
test("scale-out store: mark / read / WAF-drift / account-scope / clear / prune", async () => {
  const dir = path.join(
    os.tmpdir(),
    `scaleout-store-${process.pid}-${process.hrtime.bigint()}`,
  );
  const prev = process.env.BOT_DATA_DIR;
  process.env.BOT_DATA_DIR = dir;
  try {
    const gk = "RUM::call";

    assert.equal(await isScaled("cash", gk, 1.0), false, "fresh group is not scaled");

    await markScaled("cash", gk, 1.0);
    assert.equal(await isScaled("cash", gk, 1.0), true, "scaled after markScaled");

    // WAF-drift re-entry guard (tolerance 5%).
    assert.equal(await isScaled("cash", gk, 1.03), true, "3% WAF drift → still the same runner");
    assert.equal(await isScaled("cash", gk, 1.5), false, "50% WAF drift → treated as a fresh position");

    // Account scoping: same group key under a different account is independent.
    assert.equal(await isScaled("margin", gk, 1.0), false, "flag is per-account");

    await clearScaled("cash", gk);
    assert.equal(await isScaled("cash", gk, 1.0), false, "not scaled after clearScaled");

    // Prune drops rows whose group is no longer open; keeps the open one.
    await markScaled("cash", "TE::call", 2.0);
    await markScaled("cash", "EOSE::call", 3.0);
    await pruneOpenGroups("cash", new Set(["TE::call"]));
    assert.equal(await isScaled("cash", "TE::call", 2.0), true, "open group survives prune");
    assert.equal(await isScaled("cash", "EOSE::call", 3.0), false, "closed group pruned");
  } finally {
    if (prev === undefined) delete process.env.BOT_DATA_DIR;
    else process.env.BOT_DATA_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
