import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getExitDelayMs,
  getMaxQuoteStreamerReconnectAttempts,
  getReconnectAttemptDelayMs,
  isFatalQuoteStreamerConsoleMessage,
  isFatalQuoteStreamerMessage,
  runQuoteStreamerReconnectRound,
  shouldAttemptInProcessReconnect,
} from "~/core/quote-streamer-recovery";

// Captured live 2026-07-06 — the exact console line that drove all 23 restarts.
const PRODUCTION_SESSION_LIMIT_LINE =
  "[DXLinkWebSocketClient] Unhandled dxLink error { type: 'UNAUTHORIZED', message: 'The number of user sessions has exceeded the configured limit, user=tasty/U0001058779' }";

test("exit delay backs off exponentially and caps at 10 minutes", () => {
  assert.equal(getExitDelayMs(0), 250);
  assert.equal(getExitDelayMs(1), 30_000);
  assert.equal(getExitDelayMs(2), 60_000);
  assert.equal(getExitDelayMs(3), 120_000);
  assert.equal(getExitDelayMs(20), 10 * 60 * 1000);
});

test("reconnect attempt delay backs off exponentially and caps at 60s", () => {
  assert.equal(getReconnectAttemptDelayMs(1), 5_000);
  assert.equal(getReconnectAttemptDelayMs(2), 10_000);
  assert.equal(getReconnectAttemptDelayMs(3), 20_000);
  assert.equal(getReconnectAttemptDelayMs(5), 60_000);
  assert.equal(getReconnectAttemptDelayMs(0), 5_000);
});

test("in-process reconnect is gated by max attempts and the per-window round limit", () => {
  assert.equal(shouldAttemptInProcessReconnect(3, 0), true);
  assert.equal(shouldAttemptInProcessReconnect(3, 2), true);
  assert.equal(shouldAttemptInProcessReconnect(3, 3), false);
  assert.equal(shouldAttemptInProcessReconnect(0, 0), false);
});

test("CORE_QUOTE_STREAMER_MAX_RECONNECT_ATTEMPTS: blank/invalid falls back to 3, 0 disables", () => {
  const key = "CORE_QUOTE_STREAMER_MAX_RECONNECT_ATTEMPTS";
  const original = process.env[key];
  try {
    delete process.env[key];
    assert.equal(getMaxQuoteStreamerReconnectAttempts(), 3);
    process.env[key] = "";
    assert.equal(getMaxQuoteStreamerReconnectAttempts(), 3);
    process.env[key] = "0";
    assert.equal(getMaxQuoteStreamerReconnectAttempts(), 0);
    process.env[key] = "5";
    assert.equal(getMaxQuoteStreamerReconnectAttempts(), 5);
    process.env[key] = "-2";
    assert.equal(getMaxQuoteStreamerReconnectAttempts(), 3);
    process.env[key] = "abc";
    assert.equal(getMaxQuoteStreamerReconnectAttempts(), 3);
    process.env[key] = "999999";
    assert.equal(getMaxQuoteStreamerReconnectAttempts(), 10);
  } finally {
    if (original == null) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});

test("reconnect round stops as soon as an attempt succeeds", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const recovered = await runQuoteStreamerReconnectRound(
    "test",
    3,
    async () => {
      attempts += 1;
      return attempts >= 2;
    },
    async (ms) => {
      sleeps.push(ms);
    },
  );

  assert.equal(recovered, true);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [5_000, 10_000]);
});

test("reconnect round exhausts capped attempts and reports failure", async () => {
  let attempts = 0;
  const recovered = await runQuoteStreamerReconnectRound(
    "test",
    3,
    async () => {
      attempts += 1;
      return false;
    },
    async () => {},
  );

  assert.equal(recovered, false);
  assert.equal(attempts, 3);
});

test("a throwing reconnect attempt is contained and the round keeps going", async () => {
  let attempts = 0;
  const recovered = await runQuoteStreamerReconnectRound(
    "test",
    2,
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("still saturated");
      }
      return true;
    },
    async () => {},
  );

  assert.equal(recovered, true);
  assert.equal(attempts, 2);
});

test("a round with zero attempts fails immediately without reconnecting", async () => {
  let attempts = 0;
  const recovered = await runQuoteStreamerReconnectRound(
    "test",
    0,
    async () => {
      attempts += 1;
      return true;
    },
    async () => {},
  );

  assert.equal(recovered, false);
  assert.equal(attempts, 0);
});

test("the production session-limit line is fatal for both matchers", () => {
  assert.equal(isFatalQuoteStreamerMessage(PRODUCTION_SESSION_LIMIT_LINE), true);
  assert.equal(isFatalQuoteStreamerConsoleMessage(PRODUCTION_SESSION_LIMIT_LINE), true);
  // The session-limit text alone is unmistakable even without dxLink context.
  assert.equal(
    isFatalQuoteStreamerConsoleMessage(
      "The number of user sessions has exceeded the configured limit, user=tasty/U0001058779",
    ),
    true,
  );
});

test("console matcher requires dxLink context so REST 401s can't kill the process", () => {
  const restLine = "request failed: 401 Unauthorized from balances endpoint";
  // Broad matcher (explicit streamer call sites) treats any unauthorized as fatal…
  assert.equal(isFatalQuoteStreamerMessage(restLine), true);
  // …but the process-wide console guard must not.
  assert.equal(isFatalQuoteStreamerConsoleMessage(restLine), false);
  assert.equal(
    isFatalQuoteStreamerConsoleMessage("[DXLinkWebSocketClient] socket closed, message: 'Bye'"),
    true,
  );
});
