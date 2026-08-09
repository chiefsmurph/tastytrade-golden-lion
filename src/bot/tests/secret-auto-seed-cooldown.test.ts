import test from "node:test";
import assert from "node:assert/strict";

import {
  CASH_ACCOUNT_SEED_MIN_DTE,
  CASH_ACCOUNT_SEED_MAX_DTE,
} from "~/strategy/option-candidate";
import {
  classifySeedOutcomeCooldown,
  getActiveAutoSeedCooldownKind,
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

test("no-chain cooldown is long (3h), account-SCOPED, and outlasts no-candidate", () => {
  const map = new Map<string, number>();
  const now = 1_000_000_000;

  recordSeedOutcomeCooldown("no-chain", map, "CD-NOCHAIN", "ACC-1", now);
  // Still blocking past the 45-min no-candidate window — a name confirmed
  // optionless once is re-probed only ~twice per 6.5h seed session.
  assert.equal(isAutoSeedCooldownActive(map, "CD-NOCHAIN", "ACC-1", now + 46 * MIN), true);
  assert.equal(isAutoSeedCooldownActive(map, "CD-NOCHAIN", "ACC-1", now + 179 * MIN), true);
  // …but ONLY for the account that observed it. An empty chain can be a
  // transient upstream fetch failure — which is exactly why this bench is 3h
  // rather than permanent — so one account's bad fetch must not bench the other.
  assert.equal(isAutoSeedCooldownActive(new Map(), "CD-NOCHAIN", "ACC-2", now + 1), false);
  // …and clears after 3 hours (conservative: not permanent, so a transient
  // empty-chain fetch is re-probed later this session rather than benched forever).
  assert.equal(isAutoSeedCooldownActive(map, "CD-NOCHAIN", "ACC-1", now + 180 * MIN), false);
});

test("no-candidate cooldown is 45 min and account-SCOPED (after early session)", () => {
  const map = new Map<string, number>();
  // Recorded at 10:00am local (past the early-session window) so the full 45-min
  // cooldown applies. Local-time constructor matches the local getHours() the
  // cooldown uses, keeping this deterministic regardless of the runner timezone.
  const now = new Date(2026, 0, 12, 10, 0, 0).getTime();

  recordSeedOutcomeCooldown("no-candidate", map, "CD-NOCAND", "ACC-1", now);
  // Blocks well past the placed window on the account that observed it…
  assert.equal(isAutoSeedCooldownActive(map, "CD-NOCAND", "ACC-1", now + 44 * MIN), true);
  // …and clears after 45 minutes. The DURATION is unchanged — loosening it adds
  // fills from the worst cohort (entrySpreadPct > 15% closed -11.97% n=21 vs
  // -3.06% n=51); only the KEY changed.
  assert.equal(isAutoSeedCooldownActive(map, "CD-NOCAND", "ACC-1", now + 45 * MIN), false);
});

test("a CASH no-candidate miss does not bench MARGIN (the 142/142 production case)", () => {
  // 2026-07-20 PLAY, verbatim from the pm2 log: the cash seed path failed with a
  // reason margin can never produce — margin does not apply the cash seed DTE
  // window at all — yet the bench was keyed by symbol alone, so margin was
  // suppressed for 45 min on a name it had never evaluated. Cash and margin also
  // run different spread caps (0.20 vs 0.10), so they never share a verdict.
  const cashMap = new Map<string, number>();
  const marginMap = new Map<string, number>();
  const CASH = "5WU18519";
  const MARGIN = "5WI88116";
  const now = new Date(2026, 6, 20, 10, 0, 0).getTime();

  const cashResult = {
    placedOrder: false,
    skippedReason: `no candidate found in cash seed DTE window ${CASH_ACCOUNT_SEED_MIN_DTE}-${CASH_ACCOUNT_SEED_MAX_DTE}`,
  };
  assert.equal(classifySeedOutcomeCooldown(cashResult), "no-candidate");
  recordSeedOutcomeCooldown("no-candidate", cashMap, "PLAY", CASH, now);

  // Cash is benched, as intended.
  assert.equal(isAutoSeedCooldownActive(cashMap, "PLAY", CASH, now + 1), true);
  // Margin is free to run its own probe — this is the behaviour change.
  assert.equal(isAutoSeedCooldownActive(marginMap, "PLAY", MARGIN, now + 1), false);

  // Symmetrically, a margin miss must not bench cash.
  recordSeedOutcomeCooldown("no-candidate", marginMap, "MRLN", MARGIN, now);
  assert.equal(isAutoSeedCooldownActive(marginMap, "MRLN", MARGIN, now + 1), true);
  assert.equal(isAutoSeedCooldownActive(cashMap, "MRLN", CASH, now + 1), false);

  // Same for the 3h no-chain bench.
  recordSeedOutcomeCooldown("no-chain", cashMap, "NXTC", CASH, now);
  assert.equal(isAutoSeedCooldownActive(cashMap, "NXTC", CASH, now + 60 * MIN), true);
  assert.equal(isAutoSeedCooldownActive(marginMap, "NXTC", MARGIN, now + 60 * MIN), false);
});

test("getActiveAutoSeedCooldownKind names which bench is suppressing the seed", () => {
  // The scoreboard's `cooldown` bucket was one opaque number covering all four
  // benches; the kind is what makes it decomposable.
  const now = new Date(2026, 0, 12, 10, 0, 0).getTime();

  const placedMap = new Map<string, number>();
  recordSeedOutcomeCooldown("placed", placedMap, "KIND-P", "ACC-K", now);
  assert.equal(getActiveAutoSeedCooldownKind(placedMap, "KIND-P", "ACC-K", now + 1), "placed");

  recordSeedOutcomeCooldown("no-chain", new Map(), "KIND-NC", "ACC-K", now);
  assert.equal(getActiveAutoSeedCooldownKind(new Map(), "KIND-NC", "ACC-K", now + 1), "no-chain");

  recordSeedOutcomeCooldown("no-candidate", new Map(), "KIND-NCAND", "ACC-K", now);
  assert.equal(
    getActiveAutoSeedCooldownKind(new Map(), "KIND-NCAND", "ACC-K", now + 1),
    "no-candidate",
  );

  recordSeedOutcomeCooldown("retry", new Map(), "KIND-R", "ACC-K", now);
  assert.equal(getActiveAutoSeedCooldownKind(new Map(), "KIND-R", "ACC-K", now + 1), "retry");

  // Nothing recorded for this symbol -> no bench…
  assert.equal(getActiveAutoSeedCooldownKind(new Map(), "KIND-NONE", "ACC-K", now), null);
  // …and isAutoSeedCooldownActive stays the boolean view of the same answer.
  assert.equal(isAutoSeedCooldownActive(new Map(), "KIND-NONE", "ACC-K", now), false);
  assert.equal(isAutoSeedCooldownActive(new Map(), "KIND-R", "ACC-K", now + 1), true);
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
