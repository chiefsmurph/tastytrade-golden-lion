import test from "node:test";
import assert from "node:assert/strict";

import {
  isWithinSecretAutoSeedWindow,
} from "~/strategy/seeding-windows";

test("isWithinSecretAutoSeedWindow stays open through 13:00", () => {
  assert.equal(
    isWithinSecretAutoSeedWindow(new Date("2026-06-24T12:59:00")),
    true,
  );
  assert.equal(
    isWithinSecretAutoSeedWindow(new Date("2026-06-24T13:00:00")),
    true,
  );
  assert.equal(
    isWithinSecretAutoSeedWindow(new Date("2026-06-24T13:01:00")),
    false,
  );
});
