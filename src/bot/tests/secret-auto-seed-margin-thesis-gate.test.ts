import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateMarginSeedThesisGate,
  getMarginSeedRequireFullThesis,
  logMarginThesisGateDecision,
  marginSeedTriggerReason,
  recordFullThesisObservations,
} from "~/strategy/secret/secret-auto-seed";
import type { SecretSourcePosition } from "~/strategy/secret/types";

const FLAG = "STRATEGY_MARGIN_SEED_REQUIRE_FULL_THESIS";

function position(extra: Partial<SecretSourcePosition>): SecretSourcePosition {
  return { ticker: "X", ...extra } as SecretSourcePosition;
}

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

// Captures every console.log line emitted by `fn`, parsed back from JSON.
function captureLogLines(fn: () => void): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  const originalLog = console.log;
  console.log = (line?: unknown) => {
    lines.push(JSON.parse(String(line)) as Record<string, unknown>);
  };
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return lines;
}

// The sticky memory is module-level; every test below uses its own date string
// so the day-rollover clear isolates it from its neighbours.

// ── Default behaviour: the full-thesis requirement is GONE ──────────────────

test("default: willBuy alone seeds margin, with no thesis ever observed today", () => {
  const day = "Mon Feb 02 2026";
  const decision = withFlag(undefined, () =>
    evaluateMarginSeedThesisGate(position({ ticker: "CCOI", willBuy: true }), day),
  );

  assert.equal(decision.seed, true);
  assert.equal(decision.willBuy, true);
  assert.equal(decision.fullThesisObservedToday, false);
  assert.equal(decision.requireFullThesis, false);
  assert.equal(decision.legacyGateWouldBlock, true);
});

test("default: a partial thesis rollup is no longer a reason to refuse the seed", () => {
  const day = "Tue Feb 03 2026";
  // 1/4 flags — the old gate demanded 4/4 at some point in the day.
  recordFullThesisObservations(
    [position({ ticker: "AMIX", thesisCount: 1, thesisMax: 4 })],
    day,
  );
  const decision = withFlag(undefined, () =>
    evaluateMarginSeedThesisGate(
      position({ ticker: "AMIX", thesisCount: 1, thesisMax: 4, willBuy: true }),
      day,
    ),
  );

  assert.equal(decision.seed, true);
  assert.equal(decision.fullThesisObservedToday, false);
  assert.equal(decision.legacyGateWouldBlock, true);
});

test("default: a full-thesis name still seeds, and is NOT counted as relief", () => {
  const day = "Wed Feb 04 2026";
  recordFullThesisObservations(
    [position({ ticker: "SKYQ", thesisCount: 4, thesisMax: 4 })],
    day,
  );
  const decision = withFlag(undefined, () =>
    evaluateMarginSeedThesisGate(position({ ticker: "SKYQ", willBuy: true }), day),
  );

  assert.equal(decision.seed, true);
  assert.equal(decision.fullThesisObservedToday, true);
  assert.equal(decision.legacyGateWouldBlock, false);
});

// ── willBuy is still a hard gate ────────────────────────────────────────────

test("willBuy still blocks: no seed without a live buy, thesis or not", () => {
  const day = "Thu Feb 05 2026";
  recordFullThesisObservations(
    [position({ ticker: "TTI", thesisCount: 4, thesisMax: 4 })],
    day,
  );

  for (const flag of [undefined, "true"]) {
    const label = `flag=${String(flag)}`;
    // Full thesis observed, but the feed is not buying right now.
    assert.equal(
      withFlag(flag, () =>
        evaluateMarginSeedThesisGate(
          position({ ticker: "TTI", willBuy: false }),
          day,
        ),
      ).seed,
      false,
      label,
    );
    // willBuy absent entirely.
    assert.equal(
      withFlag(flag, () =>
        evaluateMarginSeedThesisGate(position({ ticker: "TTI" }), day),
      ).seed,
      false,
      label,
    );
    // Truthy junk is not a boolean true — the check is strict.
    assert.equal(
      withFlag(flag, () =>
        evaluateMarginSeedThesisGate(
          position({ ticker: "TTI", willBuy: "true" as unknown as boolean }),
          day,
        ),
      ).seed,
      false,
      label,
    );
  }
});

test("a non-willBuy name is never classified as relief", () => {
  const day = "Fri Feb 06 2026";
  const decision = withFlag(undefined, () =>
    evaluateMarginSeedThesisGate(position({ ticker: "QUIET", willBuy: false }), day),
  );
  assert.equal(decision.legacyGateWouldBlock, false);
});

// ── The revert flag ─────────────────────────────────────────────────────────

test("flag ON restores the old gate: willBuy without a full-thesis observation is refused", () => {
  const day = "Mon Feb 09 2026";
  const blocked = withFlag("true", () =>
    evaluateMarginSeedThesisGate(position({ ticker: "CLSK", willBuy: true }), day),
  );

  assert.equal(blocked.seed, false);
  assert.equal(blocked.requireFullThesis, true);
  assert.equal(blocked.legacyGateWouldBlock, true);

  // Same name, once the day has seen a full thesis at any point.
  recordFullThesisObservations(
    [position({ ticker: "CLSK", thesisCount: 4, thesisMax: 4 })],
    day,
  );
  const allowed = withFlag("true", () =>
    evaluateMarginSeedThesisGate(position({ ticker: "CLSK", willBuy: true }), day),
  );
  assert.equal(allowed.seed, true);
  assert.equal(allowed.legacyGateWouldBlock, false);
});

test("flag ON is sticky across a flicker, exactly like the old gate", () => {
  const day = "Tue Feb 10 2026";
  recordFullThesisObservations(
    [position({ ticker: "ASAN", thesisCount: 4, thesisMax: 4 })],
    day,
  );
  // Thesis has since collapsed to 2/4 — the sticky memory still carries it.
  const decision = withFlag("true", () =>
    evaluateMarginSeedThesisGate(
      position({ ticker: "ASAN", thesisCount: 2, thesisMax: 4, willBuy: true }),
      day,
    ),
  );
  assert.equal(decision.seed, true);
});

test("flag parsing: blank / absent / falsey resolve to the in-code default (gate removed)", () => {
  const day = "Wed Feb 11 2026";
  const buying = position({ ticker: "NOFLAG", willBuy: true });

  for (const raw of [undefined, "", "   ", "false", "0", "no", "off", "maybe"]) {
    assert.equal(
      withFlag(raw, () => getMarginSeedRequireFullThesis()),
      false,
      `raw=${JSON.stringify(raw)}`,
    );
    assert.equal(
      withFlag(raw, () => evaluateMarginSeedThesisGate(buying, day).seed),
      true,
      `raw=${JSON.stringify(raw)}`,
    );
  }
});

test("flag parsing: true / 1 / yes (any case) arm the old gate", () => {
  const day = "Thu Feb 12 2026";
  const buying = position({ ticker: "ONFLAG", willBuy: true });

  for (const raw of ["true", "TRUE", "1", "yes", " Yes "]) {
    assert.equal(withFlag(raw, () => getMarginSeedRequireFullThesis()), true, raw);
    assert.equal(
      withFlag(raw, () => evaluateMarginSeedThesisGate(buying, day).seed),
      false,
      raw,
    );
  }
});

test("an explicit requireFullThesis argument overrides the environment", () => {
  const day = "Fri Feb 13 2026";
  const buying = position({ ticker: "OVERRIDE", willBuy: true });

  // Env says "gate removed", the caller asks for the gate.
  assert.equal(
    withFlag("false", () => evaluateMarginSeedThesisGate(buying, day, true)).seed,
    false,
  );
  // Env says "gate armed", the caller asks without it.
  assert.equal(
    withFlag("true", () => evaluateMarginSeedThesisGate(buying, day, false)).seed,
    true,
  );
});

// ── The inverted instrument ─────────────────────────────────────────────────

test("relief line fires for a seed the old gate would have blocked", () => {
  const day = "Mon Feb 16 2026";
  const decision = withFlag(undefined, () =>
    evaluateMarginSeedThesisGate(
      position({ ticker: "CCOI", willBuy: true, plateauScore: 61 }),
      day,
    ),
  );

  const lines = captureLogLines(() =>
    logMarginThesisGateDecision(decision, "CCOI", 61),
  );

  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], {
    scope: "secret-auto-seed-margin-thesis-relief",
    symbol: "CCOI",
    willBuy: true,
    fullThesisObservedToday: false,
    requireFullThesis: false,
    plateauScore: 61,
  });
});

test("pass line fires for a seed the old gate would have allowed", () => {
  const day = "Tue Feb 17 2026";
  recordFullThesisObservations(
    [position({ ticker: "SEEN", thesisCount: 4, thesisMax: 4 })],
    day,
  );
  const decision = withFlag(undefined, () =>
    evaluateMarginSeedThesisGate(
      position({ ticker: "SEEN", willBuy: true, plateauScore: 42 }),
      day,
    ),
  );

  const lines = captureLogLines(() =>
    logMarginThesisGateDecision(decision, "SEEN", 42),
  );

  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], {
    scope: "secret-auto-seed-margin-thesis-pass",
    symbol: "SEEN",
    willBuy: true,
    fullThesisObservedToday: true,
    requireFullThesis: false,
    plateauScore: 42,
  });
});

test("the original block line survives, reachable only with the flag armed", () => {
  const day = "Wed Feb 18 2026";
  const decision = withFlag("true", () =>
    evaluateMarginSeedThesisGate(
      position({ ticker: "AMIX", willBuy: true, plateauScore: 55 }),
      day,
    ),
  );

  const lines = captureLogLines(() =>
    logMarginThesisGateDecision(decision, "AMIX", 55),
  );

  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], {
    scope: "secret-auto-seed-margin-sticky-block",
    symbol: "AMIX",
    willBuy: true,
    fullThesisObservedToday: false,
    requireFullThesis: true,
    plateauScore: 55,
  });
});

test("the seed line's trigger reason names the regime it fired under", () => {
  const day = "Fri Feb 20 2026";
  const buying = position({ ticker: "REASON", willBuy: true });

  assert.equal(
    marginSeedTriggerReason(evaluateMarginSeedThesisGate(buying, day, false)),
    "secret-positions-update: willBuy",
  );
  assert.equal(
    marginSeedTriggerReason(evaluateMarginSeedThesisGate(buying, day, true)),
    "secret-positions-update: full thesis observed today + willBuy",
  );
});

test("relief and pass partition the seeded population — never both, never neither", () => {
  const day = "Thu Feb 19 2026";
  recordFullThesisObservations(
    [position({ ticker: "WITH", thesisCount: 4, thesisMax: 4 })],
    day,
  );

  const scopes = withFlag(undefined, () =>
    ["WITH", "WITHOUT"].map((ticker) => {
      const decision = evaluateMarginSeedThesisGate(
        position({ ticker, willBuy: true }),
        day,
      );
      assert.equal(decision.seed, true, ticker);
      const lines = captureLogLines(() =>
        logMarginThesisGateDecision(decision, ticker, undefined),
      );
      assert.equal(lines.length, 1, ticker);
      return lines[0].scope;
    }),
  );

  assert.deepEqual(scopes, [
    "secret-auto-seed-margin-thesis-pass",
    "secret-auto-seed-margin-thesis-relief",
  ]);
});
