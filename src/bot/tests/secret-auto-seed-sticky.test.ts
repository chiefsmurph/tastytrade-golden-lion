import test from "node:test";
import assert from "node:assert/strict";

import {
  recordFullThesisObservations,
  wasFullThesisObservedToday,
  shouldSeedMarginSticky,
} from "~/strategy/secret/secret-auto-seed";
import type { SecretSourcePosition } from "~/strategy/secret/types";

function position(extra: Partial<SecretSourcePosition>): SecretSourcePosition {
  return { ticker: "X", ...extra } as SecretSourcePosition;
}

// The sticky memory is module-level; each test uses its own date string so the
// day-rollover clear isolates it from earlier tests.

test("records tickers at full thesis; the observation sticks across later ticks", () => {
  const day = "Mon Jan 05 2026";
  recordFullThesisObservations(
    [position({ ticker: "aapl", thesisCount: 4, thesisMax: 4 })],
    day,
  );
  assert.equal(wasFullThesisObservedToday("AAPL", day), true);

  // A later tick where the flags have flickered away does NOT un-record it.
  recordFullThesisObservations(
    [position({ ticker: "AAPL", thesisCount: 2, thesisMax: 4 })],
    day,
  );
  assert.equal(wasFullThesisObservedToday("AAPL", day), true);
});

test("ignores partial thesis and missing rollups", () => {
  const day = "Tue Jan 06 2026";
  recordFullThesisObservations(
    [
      position({ ticker: "PART", thesisCount: 3, thesisMax: 4 }),
      position({ ticker: "NONE", willBuy: true }),
      position({ ticker: "", thesisCount: 4, thesisMax: 4 }),
    ],
    day,
  );
  assert.equal(wasFullThesisObservedToday("PART", day), false);
  assert.equal(wasFullThesisObservedToday("NONE", day), false);
});

test("day rollover clears yesterday's observations", () => {
  const yesterday = "Wed Jan 07 2026";
  const today = "Thu Jan 08 2026";
  recordFullThesisObservations(
    [position({ ticker: "TSLA", thesisCount: 4, thesisMax: 4 })],
    yesterday,
  );
  assert.equal(wasFullThesisObservedToday("TSLA", yesterday), true);

  // First record of the new day clears the set before adding.
  recordFullThesisObservations(
    [position({ ticker: "NVDA", thesisCount: 4, thesisMax: 4 })],
    today,
  );
  assert.equal(wasFullThesisObservedToday("TSLA", today), false);
  assert.equal(wasFullThesisObservedToday("NVDA", today), true);
  // Querying with a stale date string never matches either.
  assert.equal(wasFullThesisObservedToday("TSLA", yesterday), false);
});

test("margin condition requires BOTH a sticky observation and current willBuy", () => {
  const day = "Fri Jan 09 2026";
  recordFullThesisObservations(
    [position({ ticker: "SEEN", thesisCount: 4, thesisMax: 4 })],
    day,
  );

  // Observed + willBuy now → seed, even though thesis has flickered to 2/4.
  assert.equal(
    shouldSeedMarginSticky(
      position({ ticker: "SEEN", thesisCount: 2, thesisMax: 4, willBuy: true }),
      day,
    ),
    true,
  );
  // Observed but not currently buying → no seed.
  assert.equal(
    shouldSeedMarginSticky(position({ ticker: "SEEN", willBuy: false }), day),
    false,
  );
  assert.equal(shouldSeedMarginSticky(position({ ticker: "SEEN" }), day), false);
  // willBuy now but never observed at full thesis today → no seed. (In the
  // seed loop, a same-tick full thesis IS recorded before this check runs.)
  assert.equal(
    shouldSeedMarginSticky(position({ ticker: "UNSEEN", willBuy: true }), day),
    false,
  );
});
