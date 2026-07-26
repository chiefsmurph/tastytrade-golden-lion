import test from "node:test";
import assert from "node:assert/strict";

import {
  classifySeedOutcomeCooldown,
  isAutoSeedCooldownActive,
  recordSeedOutcomeCooldown,
} from "~/strategy/secret/secret-auto-seed";

test("placed orders get the standard per-symbol cooldown", () => {
  assert.equal(classifySeedOutcomeCooldown({ placedOrder: true }), "placed");
  // placedOrder wins even if a reason string is riding along.
  assert.equal(
    classifySeedOutcomeCooldown({ placedOrder: true, skippedReason: "whatever" }),
    "placed",
  );
});

test("a truly optionless underlying is classified no-chain, not no-candidate", () => {
  // Emitted by option-candidate selection when the underlying carries ZERO
  // expirations anywhere (see NO_OPTION_CHAIN_SKIP_REASON) — a permanent
  // property, benched far longer than a chain that merely lacks a candidate.
  assert.equal(
    classifySeedOutcomeCooldown({
      placedOrder: false,
      skippedReason: "no option chain for underlying",
    }),
    "no-chain",
  );
  // …and it is NOT lumped with the generic no-candidate reason.
  assert.notEqual(
    classifySeedOutcomeCooldown({
      placedOrder: false,
      skippedReason: "no option chain for underlying",
    }),
    "no-candidate",
  );
});

test("no-candidate skips (chain exists, no usable candidate) get the long cooldown", () => {
  // These match seed-symbol.ts skip strings verbatim.
  assert.equal(
    classifySeedOutcomeCooldown({ placedOrder: false, skippedReason: "no option candidate found" }),
    "no-candidate",
  );
  assert.equal(
    classifySeedOutcomeCooldown({
      placedOrder: false,
      skippedReason: "candidate quote symbol unavailable",
    }),
    "no-candidate",
  );
  // seed-symbol emits `candidate ${priceMode} quote unavailable` per mode.
  assert.equal(
    classifySeedOutcomeCooldown({ placedOrder: false, skippedReason: "candidate ask quote unavailable" }),
    "no-candidate",
  );
  assert.equal(
    classifySeedOutcomeCooldown({ placedOrder: false, skippedReason: "candidate mid quote unavailable" }),
    "no-candidate",
  );
});

test("DTE-window misses get the long cooldown, not the 3-min retry", () => {
  // Since the DTE fallback shipped, a DTE miss means the widened 7-60 window
  // ALSO failed — expirations don't appear intraday, so retrying every 3 min
  // just burns selection API calls.
  assert.equal(
    classifySeedOutcomeCooldown({
      placedOrder: false,
      skippedReason: "no candidate found in cash seed DTE window 14-30",
    }),
    "no-candidate",
  );
  assert.equal(
    classifySeedOutcomeCooldown({
      placedOrder: false,
      skippedReason: "cash seed candidate DTE must be within 14-30",
    }),
    "no-candidate",
  );
});

test("transient failures get the short retry cooldown", () => {
  const transientReasons = [
    "insufficient effective buying power for seed order — capped at 98.80 by per-action max buy pct, order cost 183.00",
    "seed order cost 600.00 exceeds BOT_MAX_SEED_ORDER_COST 500.00",
    "underlying set to closing-only by broker; retrying after 2026-07-17T20:00:00.000Z",
    "underlying already has an open position",
    "time-of-day strategy is not allowing new accumulation",
    "seed order dry run failed",
  ];
  for (const skippedReason of transientReasons) {
    assert.equal(
      classifySeedOutcomeCooldown({ placedOrder: false, skippedReason }),
      "retry",
      skippedReason,
    );
  }
  // Missing reason is still a failed attempt → short retry.
  assert.equal(classifySeedOutcomeCooldown({ placedOrder: false }), "retry");
  assert.equal(classifySeedOutcomeCooldown({ placedOrder: false, skippedReason: null }), "retry");
});

// The no-candidate / retry cooldowns live in module-level maps, so each test
// below uses its own unique symbol to stay isolated. Defaults (env unset):
// placed 10 min, no-candidate 45 min, retry 3 min.
const MIN = 60 * 1000;

test("placed cooldown uses the per-path map and the standard 10 min window", () => {
  const map = new Map<string, number>();
  const now = 1_000_000_000;
  assert.equal(isAutoSeedCooldownActive(map, "CD-PLACED", "ACC-1", now), false);

  recordSeedOutcomeCooldown("placed", map, "CD-PLACED", "ACC-1", now);
  assert.equal(isAutoSeedCooldownActive(map, "CD-PLACED", "ACC-1", now + 9 * MIN), true);
  assert.equal(isAutoSeedCooldownActive(map, "CD-PLACED", "ACC-1", now + 10 * MIN), false);
  // The placed stamp lives on the caller's map — a different path's map is clear.
  assert.equal(isAutoSeedCooldownActive(new Map(), "CD-PLACED", "ACC-1", now + 1), false);
});

test("no-chain cooldown is long (3h), account-independent, and outlasts no-candidate", () => {
  const map = new Map<string, number>();
  const now = 1_000_000_000;

  recordSeedOutcomeCooldown("no-chain", map, "CD-NOCHAIN", "ACC-1", now);
  // Still blocking past the 45-min no-candidate window — a name confirmed
  // optionless once is re-probed only ~twice per 6.5h seed session.
  assert.equal(isAutoSeedCooldownActive(map, "CD-NOCHAIN", "ACC-1", now + 46 * MIN), true);
  assert.equal(isAutoSeedCooldownActive(map, "CD-NOCHAIN", "ACC-1", now + 179 * MIN), true);
  // …for every account (chain absence is a property of the underlying)…
  assert.equal(isAutoSeedCooldownActive(new Map(), "CD-NOCHAIN", "ACC-2", now + 179 * MIN), true);
  // …and clears after 3 hours (conservative: not permanent, so a transient
  // empty-chain fetch is re-probed later this session rather than benched forever).
  assert.equal(isAutoSeedCooldownActive(map, "CD-NOCHAIN", "ACC-1", now + 180 * MIN), false);
});

test("no-candidate cooldown is 45 min and account-independent (after early session)", () => {
  const map = new Map<string, number>();
  // Recorded at 10:00am local (past the early-session window) so the full 45-min
  // cooldown applies. Local-time constructor matches the local getHours() the
  // cooldown uses, keeping this deterministic regardless of the runner timezone.
  const now = new Date(2026, 0, 12, 10, 0, 0).getTime();

  recordSeedOutcomeCooldown("no-candidate", map, "CD-NOCAND", "ACC-1", now);
  // Blocks well past the placed window…
  assert.equal(isAutoSeedCooldownActive(map, "CD-NOCAND", "ACC-1", now + 44 * MIN), true);
  // …for every account (account-independent: a margin miss suppresses cash too)…
  assert.equal(isAutoSeedCooldownActive(new Map(), "CD-NOCAND", "ACC-2", now + 44 * MIN), true);
  // …and clears after 45 minutes.
  assert.equal(isAutoSeedCooldownActive(map, "CD-NOCAND", "ACC-1", now + 45 * MIN), false);
});

test("no-candidate cooldown is SHORT (15 min) anywhere in the 6:30-8:00am gate ramp", () => {
  const map = new Map<string, number>();
  // Recorded at 7:30am local — past the OLD 7:15am cutoff but still inside the
  // 6:30-8:00am spread-gate ramp, so it should get the 15-min retry, not 45min.
  // (This is the MBLY-7:16am class of case the window was extended to cover.)
  const now = new Date(2026, 0, 12, 7, 30, 0).getTime();

  recordSeedOutcomeCooldown("no-candidate", map, "CD-EARLY", "ACC-1", now);
  assert.equal(isAutoSeedCooldownActive(map, "CD-EARLY", "ACC-1", now + 14 * MIN), true);
  assert.equal(isAutoSeedCooldownActive(map, "CD-EARLY", "ACC-1", now + 16 * MIN), false);
});

test("retry cooldown is short (3 min) and account-specific", () => {
  const map = new Map<string, number>();
  const now = 1_000_000_000;

  recordSeedOutcomeCooldown("retry", map, "CD-RETRY", "ACC-1", now);
  assert.equal(isAutoSeedCooldownActive(map, "CD-RETRY", "ACC-1", now + 2 * MIN), true);
  // A buying-power miss on one account must not block the other account.
  assert.equal(isAutoSeedCooldownActive(map, "CD-RETRY", "ACC-2", now + 2 * MIN), false);
  assert.equal(isAutoSeedCooldownActive(map, "CD-RETRY", "ACC-1", now + 3 * MIN), false);
});
