import { test } from "node:test";
import assert from "node:assert/strict";
import { getPositionGroupExecutionTargets } from "~/strategy/evaluate-trading-strategy";
import { buildGroupExecutionTargets } from "~/strategy/group-execution-targets";
import { getTimeOfDayExecutionTargets } from "~/strategy/evaluate-trading-strategy";

// buildGroupExecutionTargets lazily starts the secret socket via the
// secret-execution-target getters; with SECRET_* set in a local .env (loaded
// by dotenv through the import chain), socket.io retries an unreachable
// endpoint forever and the test process never exits. Blank the config so
// isSecretModuleConfigured() is false. Imports are hoisted, so this runs
// after dotenv but before any test body.
process.env.SECRET_SOCKET_URL = "";
process.env.SECRET_DATA_UPDATE_POSITIONS_KEY = "";

// 7:00 AM PT — the raw schedule DTE is ~28 here; production margin plan rows
// showed 15-30 DTE because the account type was dropped on this path.
const MORNING = new Date(2026, 6, 6, 7, 0);
const THIRTY_MIN_MS = 30 * 60 * 1000;

test("margin group targets respect the margin DTE cap in the morning", () => {
  const targets = getPositionGroupExecutionTargets(-0.05, THIRTY_MIN_MS, MORNING, "margin");
  assert.ok(
    targets.targetDTE <= 7,
    `margin group targetDTE ${targets.targetDTE} exceeds the 7-DTE cap`,
  );
});

test("cash group targets keep the cash DTE floor", () => {
  const targets = getPositionGroupExecutionTargets(-0.05, THIRTY_MIN_MS, MORNING, "cash");
  assert.ok(targets.targetDTE >= 7, `cash group targetDTE ${targets.targetDTE} below floor`);
});

test("blended margin targets no longer average in the cash-branch DTE (regression)", () => {
  const baseExecutionTargets = getTimeOfDayExecutionTargets(MORNING, "margin");
  const components = buildGroupExecutionTargets({
    accountType: "margin",
    askReturnPerc: -0.05,
    baseExecutionTargets,
    currentExposurePct: 0.3,
    currentTime: MORNING,
    symbol: "MARA",
    timeSinceLastActionMs: THIRTY_MIN_MS,
  });
  assert.ok(
    components.finalPostCapsTargets.targetDTE <= 7,
    `blended margin targetDTE ${components.finalPostCapsTargets.targetDTE} exceeds the 7-DTE cap`,
  );
});

test("omitting accountType still behaves like the legacy unknown branch", () => {
  const targets = getPositionGroupExecutionTargets(-0.05, THIRTY_MIN_MS, MORNING);
  assert.ok(targets.targetDTE >= 7);
});
