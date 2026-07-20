import test from "node:test";
import assert from "node:assert/strict";

import { isMarginSeedBlockedByCrashRegime } from "~/strategy/secret/secret-auto-seed";
import type { SecretRegime } from "~/strategy/secret/types";

test("crashRegime true blocks margin auto-seeds", () => {
  assert.equal(isMarginSeedBlockedByCrashRegime({ crashRegime: true }), true);
});

test("calm, missing-flag, and null regimes pass (block only on explicit true)", () => {
  assert.equal(isMarginSeedBlockedByCrashRegime({ crashRegime: false }), false);
  assert.equal(isMarginSeedBlockedByCrashRegime({}), false);
  assert.equal(isMarginSeedBlockedByCrashRegime(null), false);
});

test("index-signature junk never blocks — only the boolean true does", () => {
  assert.equal(
    isMarginSeedBlockedByCrashRegime({
      crashRegime: "true" as unknown as boolean,
    } as SecretRegime),
    false,
  );
  assert.equal(
    isMarginSeedBlockedByCrashRegime({
      crashRegime: 1 as unknown as boolean,
    } as SecretRegime),
    false,
  );
});
