import test from "node:test";
import assert from "node:assert/strict";

import { emitSecretLog } from "~/strategy/secret";

// The socket sink no-ops when the secret socket isn't connected. In the test
// process it never connects, so emitSecretLog must be safe and silent — this
// guards the "logging never throws / never touches the trading path" contract.
test("emitSecretLog is a safe no-op when the secret socket is disconnected", () => {
  assert.doesNotThrow(() => emitSecretLog("[cycle-exception] ACC-1: boom"));
});

test("notifyEvent does not throw regardless of connection state", async () => {
  const { notifyEvent } = await import("../notify");
  assert.doesNotThrow(() => notifyEvent("hard-risk-close", "ACC-1 RUM: stop loss"));
  assert.doesNotThrow(() => notifyEvent("cycle-exception", "ACC-1: threw"));
  assert.doesNotThrow(() => notifyEvent("cancel-orders-failed", "shutdown failed"));
});
