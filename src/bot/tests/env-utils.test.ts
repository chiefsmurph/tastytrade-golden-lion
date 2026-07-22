import test from "node:test";
import assert from "node:assert/strict";

import { readEnvFraction } from "~/core/env-utils";

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

const KEY = "TEST_READ_ENV_FRACTION";

test("readEnvFraction: integer-looking percents (>1) normalize to a fraction", () => {
  withEnv(KEY, "12", () => assert.equal(readEnvFraction(KEY, 0.99), 0.12));
  withEnv(KEY, "35", () => assert.equal(readEnvFraction(KEY, 0.99), 0.35));
  withEnv(KEY, "60", () => assert.equal(readEnvFraction(KEY, 0.99), 0.6));
  withEnv(KEY, "70", () => assert.equal(readEnvFraction(KEY, 0.99), 0.7));
});

test("readEnvFraction: values already a fraction (<=1) pass through unchanged", () => {
  withEnv(KEY, "0.12", () => assert.equal(readEnvFraction(KEY, 0.99), 0.12));
  withEnv(KEY, "0.35", () => assert.equal(readEnvFraction(KEY, 0.99), 0.35));
  // Exactly 1 = 100%, treated as a full fraction (not divided).
  withEnv(KEY, "1", () => assert.equal(readEnvFraction(KEY, 0.99), 1));
});

test("readEnvFraction: absent / blank / non-numeric / non-positive → fallback", () => {
  withEnv(KEY, undefined, () => assert.equal(readEnvFraction(KEY, 0.42), 0.42));
  withEnv(KEY, "", () => assert.equal(readEnvFraction(KEY, 0.42), 0.42));
  withEnv(KEY, "   ", () => assert.equal(readEnvFraction(KEY, 0.42), 0.42));
  withEnv(KEY, "garbage", () => assert.equal(readEnvFraction(KEY, 0.42), 0.42));
  withEnv(KEY, "0", () => assert.equal(readEnvFraction(KEY, 0.42), 0.42));
  withEnv(KEY, "-5", () => assert.equal(readEnvFraction(KEY, 0.42), 0.42));
});
