import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_OPTION_TICK_SIZES,
  EQUITY_TICK_SIZES,
  resolveTickSize,
  roundOrderPrice,
  tickSizesForInstrument,
  type OptionTickSize,
} from "../actions/order-utils";

// REGRESSION — 2026-08-15. `roundOrderPrice` rounded to $0.01 unconditionally.
// That is only a legal increment below $3.00; at or above it the broker requires
// nickels and rejects the whole order at preflight:
//
//   "One or more preflight checks failed: Price must be in increments of $0.05
//    for this order. [invalid_price_increment]"
//
// Twenty such rejections are in the shipped logs, at limit prices of 3.28, 3.23
// and 3.03 — every one at or above $3.00 and none below it. Each was a
// fully-sized, fully-gated entry thrown away at the last step, and it read
// downstream as an ordinary skipped seed, so nothing ever surfaced it. These
// tests pin the exact prices the broker refused.
//
// No clock is read anywhere in this path, so no test-clock fixture is needed.

const REJECTED_BY_BROKER = [3.28, 3.23, 3.03];

const isMultipleOf = (value: number, tick: number): boolean => {
  const steps = value / tick;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
};

test("the three prices the broker actually rejected are now legal nickels", () => {
  for (const price of REJECTED_BY_BROKER) {
    const rounded = Number(roundOrderPrice(price));
    assert.ok(
      isMultipleOf(rounded, 0.05),
      `${price} rounded to ${rounded}, still not a $0.05 multiple`,
    );
    // …and it stays near the price the strategy asked for.
    assert.ok(Math.abs(rounded - price) <= 0.025 + 1e-9, `${price} moved too far`);
  }
  // The specific values, so a regression names itself.
  assert.equal(roundOrderPrice(3.28), "3.30");
  assert.equal(roundOrderPrice(3.23), "3.25");
  assert.equal(roundOrderPrice(3.03), "3.05");
});

test("sub-$3 prices are untouched — pennies are legal there and were always used", () => {
  // The fix must not disturb the band where the bot has been trading correctly.
  for (const price of [0.07, 0.5, 1.23, 2.49, 2.99]) {
    assert.equal(roundOrderPrice(price), price.toFixed(2), `${price} must not move`);
  }
  // Raw chase floats still collapse to the nearest cent below $3.
  assert.equal(roundOrderPrice(1.2349), "1.23");
  assert.equal(roundOrderPrice(2.9876), "2.99");
});

test("the $3.00 boundary switches bands, inclusive of 3.00 itself", () => {
  assert.equal(resolveTickSize(2.9999), 0.01);
  assert.equal(resolveTickSize(3), 0.05);
  assert.equal(resolveTickSize(3.01), 0.05);
  assert.equal(roundOrderPrice(3), "3.00");
  // 3.01 and 3.02 round DOWN to the band floor rather than becoming illegal.
  assert.equal(roundOrderPrice(3.01), "3.00");
  assert.equal(roundOrderPrice(3.02), "3.00");
  assert.equal(roundOrderPrice(3.06), "3.05");
});

test("every price across the range lands on its own band's tick", () => {
  // Property sweep — the boundary is the easy case to get wrong twice.
  for (let cents = 1; cents <= 2000; cents += 1) {
    const price = cents / 100;
    const rounded = Number(roundOrderPrice(price));
    const tick = resolveTickSize(rounded);
    assert.ok(
      isMultipleOf(rounded, tick),
      `${price} → ${rounded} is not a multiple of its ${tick} tick`,
    );
    assert.ok(rounded > 0, `${price} rounded to a non-positive limit`);
  }
});

test("a positive price never rounds away to a $0.00 limit", () => {
  // A $0.00 limit is an instant rejection on a buy and gives the position away on
  // a sell. With an all-nickel instrument, 2c would otherwise round to zero.
  const allNickels: OptionTickSize[] = [{ value: "0.05" }];
  assert.equal(roundOrderPrice(0.02, allNickels), "0.05");
  assert.equal(roundOrderPrice(0.001, allNickels), "0.05");
  assert.equal(roundOrderPrice(0.004), "0.01");
});

test("resolveTickSize reads tastytrade's banded tick-sizes schema", () => {
  // Shape per TastytradeOptionChain['tick-sizes']: `threshold` is where a band
  // stops applying; the entry without one is the open-ended top band.
  const chainTicks: OptionTickSize[] = [
    { value: "0.01", threshold: "3.0" },
    { value: "0.05", threshold: "10.0" },
    { value: "0.10" },
  ];
  assert.equal(resolveTickSize(1.5, chainTicks), 0.01);
  assert.equal(resolveTickSize(5, chainTicks), 0.05);
  assert.equal(resolveTickSize(25, chainTicks), 0.1);
  assert.equal(roundOrderPrice(25.04, chainTicks), "25.00");
  assert.equal(roundOrderPrice(25.06, chainTicks), "25.10");
});

test("chain tick-sizes are honoured out of order and degrade safely", () => {
  // Ordering is the API's business, not ours.
  const unsorted: OptionTickSize[] = [{ value: "0.05" }, { value: "0.01", threshold: "3.0" }];
  assert.equal(resolveTickSize(1, unsorted), 0.01);
  assert.equal(resolveTickSize(4, unsorted), 0.05);

  // Junk must not produce a zero tick and a division by zero.
  assert.equal(resolveTickSize(4, []), 0.01);
  assert.equal(resolveTickSize(4, [{ value: "0" }]), 0.01);
  assert.equal(resolveTickSize(4, [{ value: "not-a-number" }]), 0.01);
  assert.equal(roundOrderPrice(4.567, []), "4.57");
});

test("the shipped defaults encode the rule the broker enforced, not a guess", () => {
  assert.deepEqual(DEFAULT_OPTION_TICK_SIZES, [
    { value: "0.01", threshold: "3.0" },
    { value: "0.05" },
  ]);
});

// ── Equity is not options ───────────────────────────────────────────────────
// The bot places SHARE orders too: the EOD margin liquidation clears every
// instrument in the account, including equity the owner bought by hand. Shares
// quote in pennies at any price, so lending them the $3.00 nickel band would move
// a share limit for no reason — and this is a live sell path.
test("share orders keep penny ticks at every price", () => {
  assert.deepEqual(EQUITY_TICK_SIZES, [{ value: "0.01" }]);
  for (const price of [0.99, 3.01, 4.02, 7.13, 9.87, 123.45]) {
    assert.equal(
      roundOrderPrice(price, EQUITY_TICK_SIZES),
      price.toFixed(2),
      `${price} must not be nudged onto the option grid`,
    );
  }
  // The same prices on the option grid DO move — proving the split is load-bearing.
  assert.notEqual(roundOrderPrice(4.02), roundOrderPrice(4.02, EQUITY_TICK_SIZES));
});

test("tickSizesForInstrument matches options before equity", () => {
  // "Equity Option" contains "Equity"; matching equity first would silently put
  // every option order back on the penny grid and re-open the rejection.
  assert.equal(tickSizesForInstrument("Equity Option"), DEFAULT_OPTION_TICK_SIZES);
  assert.equal(tickSizesForInstrument("Future Option"), DEFAULT_OPTION_TICK_SIZES);
  assert.equal(tickSizesForInstrument("Equity"), EQUITY_TICK_SIZES);
  assert.equal(tickSizesForInstrument("equity"), EQUITY_TICK_SIZES);
  // Unknown falls back to the option grid: a nickel is always a legal penny price,
  // so the option grid is never rejected, only coarser.
  assert.equal(tickSizesForInstrument(undefined), DEFAULT_OPTION_TICK_SIZES);
  assert.equal(tickSizesForInstrument(""), DEFAULT_OPTION_TICK_SIZES);
});
