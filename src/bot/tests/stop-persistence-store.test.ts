import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  clearStopStreak,
  getStopStreak,
  recordStopTrigger,
} from "~/bot/actions/stop-persistence-store";

// The persisted half of the stop-loss persistence gate. Exercised against a real
// temp BOT_DATA_DIR rather than a mocked fs, because every bug this store can have
// is a bug about what actually landed on disk: a leaked streak fires a stop a cycle
// early, a dropped one holds a real stop open.

const CYCLE_MS = 4 * 60 * 1000;
const T0 = Date.UTC(2026, 7, 8, 16, 30, 0);

async function withStore<T>(run: () => Promise<T>): Promise<T> {
  const dir = path.join(
    os.tmpdir(),
    `stop-persistence-${process.pid}-${process.hrtime.bigint()}`,
  );
  const priorDir = process.env.BOT_DATA_DIR;
  const priorInterval = process.env.BOT_RUN_INTERVAL_MS;
  process.env.BOT_DATA_DIR = dir;
  process.env.BOT_RUN_INTERVAL_MS = String(CYCLE_MS);
  try {
    return await run();
  } finally {
    if (priorDir === undefined) delete process.env.BOT_DATA_DIR;
    else process.env.BOT_DATA_DIR = priorDir;
    if (priorInterval === undefined) delete process.env.BOT_RUN_INTERVAL_MS;
    else process.env.BOT_RUN_INTERVAL_MS = priorInterval;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("a triggering group's streak grows one per cycle and resets the moment it stops", async () => {
  await withStore(async () => {
    const group = "CLSK::call";
    assert.equal(await getStopStreak("cash", group, 1.17, T0), 0, "fresh group");

    await recordStopTrigger("cash", group, true, 1.17, T0);
    assert.equal(await getStopStreak("cash", group, 1.17, T0 + CYCLE_MS), 1);

    await recordStopTrigger("cash", group, true, 1.17, T0 + CYCLE_MS);
    assert.equal(await getStopStreak("cash", group, 1.17, T0 + 2 * CYCLE_MS), 2);

    // The trigger stops holding (the position recovered) — start over, not decay.
    await recordStopTrigger("cash", group, false, 1.17, T0 + 2 * CYCLE_MS);
    assert.equal(await getStopStreak("cash", group, 1.17, T0 + 3 * CYCLE_MS), 0);

    await recordStopTrigger("cash", group, true, 1.17, T0 + 3 * CYCLE_MS);
    assert.equal(
      await getStopStreak("cash", group, 1.17, T0 + 4 * CYCLE_MS),
      1,
      "a re-triggered stop starts from one, not from where it left off",
    );
  });
});

test("repeat evaluations inside one cycle re-affirm without advancing the streak", async () => {
  await withStore(async () => {
    const group = "CLSK::call";
    // getPositionEvaluations runs several times per cycle (run-cycle context, the
    // seeding pass, the allocation budget). If each one counted, a single cycle
    // would satisfy a 2-cycle requirement on its own.
    await recordStopTrigger("cash", group, true, 1.17, T0);
    await recordStopTrigger("cash", group, true, 1.17, T0 + 1_000);
    await recordStopTrigger("cash", group, true, 1.17, T0 + 30_000);
    assert.equal(await getStopStreak("cash", group, 1.17, T0 + 30_000), 1);

    // ...and the next real cycle is still measured from the FIRST sighting, so the
    // re-affirmations neither advance nor postpone it.
    await recordStopTrigger("cash", group, true, 1.17, T0 + CYCLE_MS);
    assert.equal(await getStopStreak("cash", group, 1.17, T0 + CYCLE_MS), 2);
  });
});

test("streaks are per account — one book's quote noise cannot arm the other's stop", async () => {
  await withStore(async () => {
    const group = "TDOC::call";
    await recordStopTrigger("cash", group, true, 0.52, T0);
    await recordStopTrigger("cash", group, true, 0.52, T0 + CYCLE_MS);

    assert.equal(await getStopStreak("cash", group, 0.52, T0 + 2 * CYCLE_MS), 2);
    assert.equal(
      await getStopStreak("margin", group, 0.52, T0 + 2 * CYCLE_MS),
      0,
      "margin holds the same underlying and must start from zero",
    );

    // And the reverse: margin's own streak does not disturb cash's.
    await recordStopTrigger("margin", group, true, 0.52, T0 + 2 * CYCLE_MS);
    assert.equal(await getStopStreak("margin", group, 0.52, T0 + 3 * CYCLE_MS), 1);
    assert.equal(await getStopStreak("cash", group, 0.52, T0 + 3 * CYCLE_MS), 2);
  });
});

test("a re-entered position does not inherit the old one's streak (cost-basis guard)", async () => {
  await withStore(async () => {
    const group = "SG::call";
    await recordStopTrigger("cash", group, true, 1.23, T0);
    assert.equal(await getStopStreak("cash", group, 1.23, T0 + CYCLE_MS), 1);
    assert.equal(
      await getStopStreak("cash", group, 0.80, T0 + CYCLE_MS),
      0,
      "a materially different cost basis is a different position",
    );
    // Recording against the new basis starts a fresh streak rather than extending.
    await recordStopTrigger("cash", group, true, 0.80, T0 + CYCLE_MS);
    assert.equal(await getStopStreak("cash", group, 0.80, T0 + 2 * CYCLE_MS), 1);
  });
});

test("a streak from before a gap (restart / overnight) is not the previous cycle", async () => {
  await withStore(async () => {
    const group = "AUR::call";
    await recordStopTrigger("cash", group, true, 1.0, T0);
    assert.equal(await getStopStreak("cash", group, 1.0, T0 + 2 * CYCLE_MS), 1);
    assert.equal(
      await getStopStreak("cash", group, 1.0, T0 + 20 * 60 * 60 * 1000),
      0,
      "yesterday's trigger cannot confirm today's",
    );
  });
});

test("group keys are normalized, and clearStopStreak drops the row", async () => {
  await withStore(async () => {
    await recordStopTrigger("cash", "  iova::call  ", true, 0.53, T0);
    assert.equal(await getStopStreak("cash", "IOVA::CALL", 0.53, T0 + CYCLE_MS), 1);

    await clearStopStreak("cash", "IOVA::call");
    assert.equal(await getStopStreak("cash", "IOVA::call", 0.53, T0 + CYCLE_MS), 0);
  });
});

test("concurrent writes across the cycle's groups all survive", async () => {
  await withStore(async () => {
    // getPositionEvaluations fans every group out through one Promise.all, so the
    // store takes a burst of read-modify-write on a single JSON file.
    const groups = Array.from({ length: 12 }, (_, i) => `SYM${i}::call`);
    await Promise.all(
      groups.map((group) => recordStopTrigger("cash", group, true, 1.0, T0)),
    );
    for (const group of groups) {
      assert.equal(
        await getStopStreak("cash", group, 1.0, T0 + CYCLE_MS),
        1,
        `${group} was lost to a racing write`,
      );
    }
  });
});
