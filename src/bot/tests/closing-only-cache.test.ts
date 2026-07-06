import test from "node:test";
import assert from "node:assert/strict";

import {
  clearClosingOnlyCache,
  getClosingOnlyRetryAt,
  getClosingOnlyRetryMs,
  isClosingOnlyDryRunError,
  recordClosingOnly,
} from "../closing-only-cache";

test("getClosingOnlyRetryMs resolves blank/invalid env to the default", () => {
  const original = process.env.BOT_CLOSING_ONLY_RETRY_MS;
  try {
    delete process.env.BOT_CLOSING_ONLY_RETRY_MS;
    assert.equal(getClosingOnlyRetryMs(), 30 * 60 * 1000);

    process.env.BOT_CLOSING_ONLY_RETRY_MS = "";
    assert.equal(getClosingOnlyRetryMs(), 30 * 60 * 1000);

    process.env.BOT_CLOSING_ONLY_RETRY_MS = "0";
    assert.equal(getClosingOnlyRetryMs(), 30 * 60 * 1000);

    process.env.BOT_CLOSING_ONLY_RETRY_MS = "60000";
    assert.equal(getClosingOnlyRetryMs(), 60000);
  } finally {
    if (original == null) {
      delete process.env.BOT_CLOSING_ONLY_RETRY_MS;
    } else {
      process.env.BOT_CLOSING_ONLY_RETRY_MS = original;
    }
  }
});

test("closing-only cache records, expires, and self-heals", () => {
  clearClosingOnlyCache();
  const original = process.env.BOT_CLOSING_ONLY_RETRY_MS;
  process.env.BOT_CLOSING_ONLY_RETRY_MS = "1000";
  try {
    // Never cached -> clear to attempt.
    assert.equal(getClosingOnlyRetryAt("SOC", 0), null);

    // Record at t=0 -> skip until t=1000, case-insensitive on the symbol.
    const until = recordClosingOnly("soc", 0);
    assert.equal(until, 1000);
    assert.equal(getClosingOnlyRetryAt("SOC", 500), 1000);

    // At/after the TTL the entry is evicted and the symbol is clear again,
    // so the next real seed attempt re-checks the broker (intraday un-block).
    assert.equal(getClosingOnlyRetryAt("SOC", 1000), null);
    assert.equal(getClosingOnlyRetryAt("SOC", 1200), null);
  } finally {
    clearClosingOnlyCache();
    if (original == null) {
      delete process.env.BOT_CLOSING_ONLY_RETRY_MS;
    } else {
      process.env.BOT_CLOSING_ONLY_RETRY_MS = original;
    }
  }
});

test("isClosingOnlyDryRunError detects the nested preflight code", () => {
  const closingOnly = Object.assign(new Error("outer"), {
    response: {
      data: {
        error: {
          code: "preflight_check_failure",
          errors: [{ code: "closing_only", message: "SOC is closing only." }],
        },
      },
    },
  });
  assert.equal(isClosingOnlyDryRunError(closingOnly), true);

  const otherPreflight = Object.assign(new Error("outer"), {
    response: { data: { error: { errors: [{ code: "insufficient_buying_power" }] } } },
  });
  assert.equal(isClosingOnlyDryRunError(otherPreflight), false);

  assert.equal(isClosingOnlyDryRunError(new Error("plain")), false);
  assert.equal(isClosingOnlyDryRunError("nope"), false);
});
