import test from "node:test";
import assert from "node:assert/strict";

import {
  emitSecretLog,
  flushPendingSecretLogs,
  getSecretSocketStatus,
} from "~/strategy/secret";

// The socket never connects in the test process, so every emit takes the
// queue path — the server drops client:act from unauthenticated sockets, so
// messages must be held for the attemptAuth ack rather than fired blind.
test("emitSecretLog queues (never throws) when the socket is down, and reports it", () => {
  const before = getSecretSocketStatus().pendingLogEmits;
  let outcome: "sent" | "queued" | undefined;
  assert.doesNotThrow(() => {
    outcome = emitSecretLog("[cycle-exception] ACC-1: boom");
  });
  assert.equal(outcome, "queued");
  assert.equal(getSecretSocketStatus().pendingLogEmits, Math.min(before + 1, 50));
});

test("the pending queue is bounded at 50 — oldest dropped, no unbounded growth", () => {
  for (let i = 0; i < 60; i++) {
    emitSecretLog(`overflow test ${i}`);
  }
  assert.equal(getSecretSocketStatus().pendingLogEmits, 50);
});

test("flushPendingSecretLogs is a safe no-op while disconnected/unauthed", () => {
  const before = getSecretSocketStatus().pendingLogEmits;
  assert.doesNotThrow(() => flushPendingSecretLogs());
  // Nothing sent, nothing lost — the queue waits for a real auth ack.
  assert.equal(getSecretSocketStatus().pendingLogEmits, before);
});

test("socket status exposes auth state for the ops checks", () => {
  const status = getSecretSocketStatus();
  assert.equal(typeof status.authed, "boolean");
  assert.equal(typeof status.pendingLogEmits, "number");
});

test("notifyEvent does not throw for any event type regardless of connection state", async () => {
  const { notifyEvent } = await import("../notify");
  assert.doesNotThrow(() => notifyEvent("hard-risk-close", "ACC-1 RUM: stop loss"));
  assert.doesNotThrow(() => notifyEvent("position-closed", "ACC-1 RUM: profit target reached"));
  assert.doesNotThrow(() => notifyEvent("position-built", "ACC-1 RUM: built to 82% of target"));
  assert.doesNotThrow(() => notifyEvent("cycle-exception", "ACC-1: threw"));
  assert.doesNotThrow(() => notifyEvent("cancel-orders-failed", "shutdown failed"));
});

// The whole point of item #8: every emit must leave a local breadcrumb in the
// process log so EOD verification doesn't depend on the secret server's stream.
test("notifyEvent writes a local [notify] breadcrumb carrying the type, message, and real sink outcome", async () => {
  const { notifyEvent } = await import("../notify");

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    notifyEvent("hard-risk-close", "ACC-1 WEN: urgent EOD close");
  } finally {
    console.log = originalLog;
  }

  const breadcrumb = lines.find((line) => line.startsWith("[notify] "));
  assert.ok(breadcrumb, "expected a [notify] breadcrumb line");
  assert.match(breadcrumb!, /\bhard-risk-close\b/, "breadcrumb includes the event type");
  assert.match(breadcrumb!, /ACC-1 WEN: urgent EOD close/, "breadcrumb includes the message");
  // Socket never connects in the test process, so the emit was queued for the
  // auth ack — the breadcrumb must record the real outcome, not imply a send.
  assert.match(breadcrumb!, /\(queued\)/, "breadcrumb records the queued sink outcome");
});
