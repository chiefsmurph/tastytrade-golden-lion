import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getDoNotTouchGroupKeys,
  isEvaluationDoNotTouch,
} from "../do-not-touch-groups";

function protects(env: string, groupKey: string): boolean {
  process.env.BOT_DO_NOT_TOUCH_GROUPS = env;
  return isEvaluationDoNotTouch({ groupKey }, getDoNotTouchGroupKeys());
}

test("bare underlying protects every side", () => {
  assert.equal(protects("ORN", "ORN::call"), true);
  assert.equal(protects("ORN", "ORN::put"), true);
  assert.equal(protects("ORN", "ORN::none"), true);
  assert.equal(protects("ORN", "ORN::stock"), true);
  assert.equal(protects("ORN", "ORNX::call"), false); // different underlying, not a prefix match
});

test("::none and ::stock alias the same (equity) leg", () => {
  assert.equal(protects("ORN::none", "ORN::none"), true);
  assert.equal(protects("ORN::none", "ORN::stock"), true);
  assert.equal(protects("ORN::stock", "ORN::none"), true);
  assert.equal(protects("ORN::stock", "ORN::stock"), true);
  // an equity token must NOT catch the option sides
  assert.equal(protects("ORN::none", "ORN::call"), false);
  assert.equal(protects("ORN::stock", "ORN::put"), false);
});

test("explicit option side + case-insensitivity", () => {
  assert.equal(protects("ORN::call", "ORN::call"), true);
  assert.equal(protects("ORN::call", "ORN::none"), false);
  assert.equal(protects("orn", "ORN::CALL"), true);
  assert.equal(protects("ORN::STOCK", "orn::none"), true);
});

test("multi-entry list (John's corrected value)", () => {
  const env = "ORN::call,ORN::put,ORN::none";
  assert.equal(protects(env, "ORN::call"), true);
  assert.equal(protects(env, "ORN::put"), true);
  assert.equal(protects(env, "ORN::none"), true);
  assert.equal(protects(env, "ORN::stock"), true); // via the ::none alias
  assert.equal(protects(env, "SOFI::call"), false);
});
