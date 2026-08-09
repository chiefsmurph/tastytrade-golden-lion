import test from "node:test";
import assert from "node:assert/strict";

import { readEnvBool, readEnvFraction } from "~/core/env-utils";

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

const BOOL_KEY = "TEST_READ_ENV_BOOL";

test("readEnvBool: absent / blank / whitespace → the in-code default, either way", () => {
  // The whole reason this helper exists: `toBooleanFlag(process.env.K ?? true)`
  // reads a present-but-blank `K=` as "" — not nullish — and silently returns
  // false, inverting any flag whose default is true.
  for (const blank of [undefined, "", "   ", "\t"]) {
    withEnv(BOOL_KEY, blank, () => {
      assert.equal(readEnvBool(BOOL_KEY, true), true, `blank=${JSON.stringify(blank)}`);
      assert.equal(readEnvBool(BOOL_KEY, false), false, `blank=${JSON.stringify(blank)}`);
    });
  }
});

test("readEnvBool: an explicit value always wins over the default", () => {
  for (const on of ["true", "TRUE", " true ", "1", "yes", "Yes"]) {
    withEnv(BOOL_KEY, on, () => assert.equal(readEnvBool(BOOL_KEY, false), true, on));
  }
  for (const off of ["false", "FALSE", "0", "no", "garbage", "-1"]) {
    withEnv(BOOL_KEY, off, () => assert.equal(readEnvBool(BOOL_KEY, true), false, off));
  }
});
