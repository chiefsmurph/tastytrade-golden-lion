import test from "node:test";
import assert from "node:assert/strict";
import { waitForOrderFillById } from "../actions/order-utils";

// REGRESSION — 2026-08-03.
//
// LIVE_ORDER_STATUSES was ["Pending", "Open", "Pending Cancel"], which omits every
// status tastytrade actually assigns a freshly-placed order. waitForOrderFillById
// treats an unrecognised status as terminal and returns false IMMEDIATELY, so the
// close tick-chase concluded "didn't fill" ~1s after posting, dropped a rung, and
// repeated — burning a 10-move / 30s-per-rung ladder (~5 min) in about a second and
// landing on the BID nearly every time.
//
// Observed that morning: EOSE posted 0.82 / 0.77 / 0.73 inside one second and filled
// at the bid rung; 2 of 3 sells filled below mid as a direct result.
//
// These tests assert the WAITING behaviour, not just the return value: a live order
// must keep the poller alive until the timeout, because that dwell time IS the
// chase's willingness to hold a better price.

const LIVE_STATUSES = ["Received", "Routed", "In Flight", "Live", "Pending", "Open"];

for (const status of LIVE_STATUSES) {
  test(`"${status}" is treated as WORKING — poller waits rather than bailing`, async () => {
    let polls = 0;
    const started = Date.now();
    const result = await waitForOrderFillById("ACC-1", "42", 120, {
      pollIntervalMs: 20,
      getOrder: async () => {
        polls += 1;
        return { status };
      },
    });
    const elapsed = Date.now() - started;

    assert.equal(result, false, "never filled, so the final answer is false");
    assert.ok(polls > 1, `expected repeated polling, got ${polls} poll(s)`);
    assert.ok(
      elapsed >= 100,
      `expected to wait out the ~120ms timeout, only waited ${elapsed}ms — ` +
        "returning early is the bug that collapsed the chase ladder",
    );
  });
}

test("a live order that fills mid-wait is reported as filled", async () => {
  let polls = 0;
  const result = await waitForOrderFillById("ACC-1", "42", 500, {
    pollIntervalMs: 10,
    getOrder: async () => {
      polls += 1;
      // Working for the first few polls, then fills — the case the old list made
      // impossible to observe, because it bailed before the fill ever landed.
      return { status: polls < 3 ? "Live" : "Filled" };
    },
  });
  assert.equal(result, true);
  assert.ok(polls >= 3);
});

test("genuinely terminal statuses still resolve false immediately", async () => {
  for (const status of ["Cancelled", "Rejected", "Expired"]) {
    let polls = 0;
    const started = Date.now();
    const result = await waitForOrderFillById("ACC-1", "42", 300, {
      pollIntervalMs: 20,
      getOrder: async () => {
        polls += 1;
        return { status };
      },
    });
    assert.equal(result, false, `${status} should resolve false`);
    assert.equal(polls, 1, `${status} should not be polled twice`);
    assert.ok(
      Date.now() - started < 150,
      `${status} should exit fast, not wait out the timeout`,
    );
  }
});
