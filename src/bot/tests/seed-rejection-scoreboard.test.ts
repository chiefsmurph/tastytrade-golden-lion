import test from "node:test";
import assert from "node:assert/strict";

import {
  CASH_ACCOUNT_SEED_MIN_DTE,
  CASH_ACCOUNT_SEED_MAX_DTE,
} from "~/strategy/option-candidate";
import {
  SEED_SCOREBOARD_LOG_SCOPE,
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

  recordSeedAttempt(acc, { placedOrder: true }, { symbol: "XXI", date });
  recordSeedAttempt(
    acc,
    { placedOrder: false, skippedReason: "cash seed candidate DTE must be within 14-30" },
    { symbol: "XXI", date },
  );
  recordSeedAttempt(
    acc,
    { placedOrder: false, skippedReason: "cash seed candidate DTE must be within 14-30" },
    { symbol: "NXTC", date },
  );
  recordSeedSkip(acc, "seed suppressed by cooldown", { symbol: "XXI", date });

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

// ── Durable mutation log (restart survival + symbol attribution) ─────────────

function captureScoreboardLog(run: () => void): Array<Record<string, unknown>> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(String(args[0]));
  };
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.scope === SEED_SCOREBOARD_LOG_SCOPE);
}

test("every scoreboard mutation emits one greppable JSON line carrying the symbol", () => {
  clearSeedRejectionScoreboard();
  const acc = "5WU18519";
  const date = "2026-08-05";

  const entries = captureScoreboardLog(() => {
    recordSeedAttempt(acc, { placedOrder: true }, { symbol: "XXI", date });
    recordSeedSkip(acc, "seed suppressed by no-candidate cooldown", { symbol: "MRLN", date });
    // No symbol supplied -> the field is present and null, never absent.
    recordSeedSkip(acc, "seed gate: IV rank unavailable", { symbol: null, date });
  });

  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((e) => [e.bucket, e.symbol]),
    [
      ["placed", "XXI"],
      ["cooldown", "MRLN"],
      ["gate", null],
    ],
  );
  for (const entry of entries) {
    assert.equal(entry.accountNumber, acc);
    assert.equal(entry.date, date);
    assert.equal(typeof entry.timestamp, "string");
  }
});

test("the log line reconstructs a day's board exactly after a PM2 restart", () => {
  // 2026-07-23: the cash day-report recorded `placed: 5` while that day's pm2
  // log contains 58 seeds with placedOrder true — the in-memory counters are a
  // since-last-restart count, not a day count. The mutation log is the durable
  // source the board can be rebuilt from.
  clearSeedRejectionScoreboard();
  const acc = "5WU18519";
  const date = "2026-07-23";

  const entries = captureScoreboardLog(() => {
    recordSeedAttempt(acc, { placedOrder: true }, { symbol: "PLAY", date });
    recordSeedAttempt(acc, { placedOrder: true }, { symbol: "APPS", date });
    recordSeedSkip(acc, "seed suppressed by placed cooldown", { symbol: "PLAY", date });

    // ── the restart ──
    clearSeedRejectionScoreboard();

    recordSeedAttempt(acc, { placedOrder: true }, { symbol: "NRGV", date });
    recordSeedSkip(acc, "seed suppressed by retry cooldown", { symbol: "APPS", date });
  });

  // The in-memory board lost everything before the restart…
  const board = getSeedRejectionScoreboard(acc, date);
  assert.equal(board.placed, 1);
  assert.equal(board.cooldown, 1);

  // …but the log lines still carry the whole day.
  const rebuilt = entries.reduce<Record<string, number>>((counts, entry) => {
    const bucket = String(entry.bucket);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    return counts;
  }, {});
  assert.equal(rebuilt.placed, 3);
  assert.equal(rebuilt.cooldown, 2);

  // And distinct opportunities are countable, which the raw counters could never
  // express: 5 mutations across only 3 (date, symbol) pairs. This is the whole
  // reason `cooldown` looked like the dominant rejection bucket — it counts
  // secret-feed ticks, not opportunities.
  const distinct = new Set(entries.map((e) => `${e.date}|${e.symbol}`));
  assert.equal(entries.length, 5);
  assert.equal(distinct.size, 3);
  assert.deepEqual([...distinct].sort(), [
    `${date}|APPS`,
    `${date}|NRGV`,
    `${date}|PLAY`,
  ]);
});

test("all four cooldown-kind reasons still classify into the cooldown bucket", () => {
  // The suppression reason now names which bench fired. The bucket must not
  // move — "no-candidate" is hyphenated so it cannot match the "no candidate"
  // no-chain rule that sits earlier in the table.
  for (const kind of ["placed", "no-chain", "no-candidate", "retry"] as const) {
    assert.equal(classifySeedRejection(`seed suppressed by ${kind} cooldown`), "cooldown", kind);
  }
});
