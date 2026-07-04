import test from "node:test";
import assert from "node:assert/strict";

import { inferIsRegularSession } from "../market-sessions";

// The 7.5h heuristic baseline: 6:30 AM → 1:00 PM PT = 6.5 h (regular session)
const REGULAR_OPEN = "2026-07-07T13:30:00Z"; // 6:30 AM PT
const REGULAR_CLOSE = "2026-07-07T20:00:00Z"; // 1:00 PM PT

// An 8-hour window (the bug case: heuristic returns false, state: "Open" should override)
const EIGHT_HOUR_OPEN = "2026-07-07T12:00:00Z";
const EIGHT_HOUR_CLOSE = "2026-07-07T20:00:00Z";

test("inferIsRegularSession: state=Open returns true regardless of window duration", () => {
  // Bug case: 8h session window would trip the ≤7.5h heuristic to false.
  // The state: "Open" signal must take priority.
  assert.equal(
    inferIsRegularSession(undefined, "Open", EIGHT_HOUR_OPEN, EIGHT_HOUR_CLOSE),
    true,
  );
});

test("inferIsRegularSession: state=Closed returns true (regular session, just closed)", () => {
  assert.equal(
    inferIsRegularSession(undefined, "Closed", EIGHT_HOUR_OPEN, EIGHT_HOUR_CLOSE),
    true,
  );
});

test("inferIsRegularSession: sessionLabel=Regular returns true", () => {
  assert.equal(
    inferIsRegularSession("Regular", undefined, undefined, undefined),
    true,
  );
});

test("inferIsRegularSession: extended label returns false", () => {
  assert.equal(
    inferIsRegularSession("Extended Hours", undefined, undefined, undefined),
    false,
  );
});

test("inferIsRegularSession: pre-market label returns false", () => {
  assert.equal(
    inferIsRegularSession("Pre-Market", undefined, undefined, undefined),
    false,
  );
});

test("inferIsRegularSession: heuristic classifies 6.5h session as regular", () => {
  assert.equal(
    inferIsRegularSession(undefined, undefined, REGULAR_OPEN, REGULAR_CLOSE),
    true,
  );
});

test("inferIsRegularSession: heuristic classifies 8h session as not regular (no state)", () => {
  assert.equal(
    inferIsRegularSession(undefined, undefined, EIGHT_HOUR_OPEN, EIGHT_HOUR_CLOSE),
    false,
  );
});

test("inferIsRegularSession: missing timestamps with no state returns false", () => {
  assert.equal(
    inferIsRegularSession(undefined, undefined, undefined, undefined),
    false,
  );
});
