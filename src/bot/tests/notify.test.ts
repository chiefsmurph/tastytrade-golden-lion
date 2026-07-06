import test from "node:test";
import assert from "node:assert/strict";

import { emitSecretLog } from "~/strategy/secret";

// The socket sink no-ops when the secret socket isn't connected. In the test
// process it never connects, so emitSecretLog must be safe and silent — this
// guards the "logging never throws / never touches the trading path" contract.
test("emitSecretLog is a safe no-op when the secret socket is disconnected", () => {
  assert.doesNotThrow(() => emitSecretLog("[cycle-exception] ACC-1: boom"));
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
test("notifyEvent writes a local [notify] breadcrumb carrying the type and message", async () => {
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
  // Socket never connects in the test process, so the emit was not delivered —
  // the breadcrumb must record that rather than implying a successful send.
  assert.match(breadcrumb!, /\(no-socket\)/, "breadcrumb records the un-connected sink");
});
