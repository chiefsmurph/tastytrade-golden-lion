import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import {
  categorizeTastytradeApiPath,
  getApiCallDateKey,
  hydrateCountsFromSaved,
  resolveApiCallCountsDir,
  rollCountsForDate,
  type ApiCallCounts,
} from "~/core/api-call-counter";

// Categorization mapping — URL patterns lifted from the SDK's service
// implementations (node_modules/@tastytrade/api/dist/services/*.js).

test("categorize: option-chain fetches are chainWalks", () => {
  assert.equal(categorizeTastytradeApiPath("/option-chains/AAPL/nested"), "chainWalks");
  assert.equal(categorizeTastytradeApiPath("/option-chains/MARA/compact"), "chainWalks");
  assert.equal(categorizeTastytradeApiPath("/option-chains/SPY"), "chainWalks");
  assert.equal(categorizeTastytradeApiPath("/futures-option-chains/ES/nested"), "chainWalks");
});

test("categorize: market-data and quote-token endpoints are quotes", () => {
  assert.equal(categorizeTastytradeApiPath("/api-quote-tokens"), "quotes");
  assert.equal(categorizeTastytradeApiPath("/market-data/by-type"), "quotes");
});

test("categorize: market-metrics family is marketMetrics", () => {
  assert.equal(categorizeTastytradeApiPath("/market-metrics"), "marketMetrics");
  assert.equal(categorizeTastytradeApiPath("/market-metrics?symbols=MARA"), "marketMetrics");
  assert.equal(
    categorizeTastytradeApiPath("/market-metrics/historic-corporate-events/dividends/AAPL"),
    "marketMetrics",
  );
});

test("categorize: order endpoints (incl. dry-runs and complex) are orders", () => {
  assert.equal(categorizeTastytradeApiPath("/accounts/5WX01234/orders"), "orders");
  assert.equal(categorizeTastytradeApiPath("/accounts/5WX01234/orders/dry-run"), "orders");
  assert.equal(categorizeTastytradeApiPath("/accounts/5WX01234/orders/123/dry-run"), "orders");
  assert.equal(categorizeTastytradeApiPath("/accounts/5WX01234/orders/live"), "orders");
  assert.equal(categorizeTastytradeApiPath("/accounts/5WX01234/complex-orders"), "orders");
  assert.equal(categorizeTastytradeApiPath("/customers/me/orders/live"), "orders");
});

test("categorize: everything else falls through to other", () => {
  assert.equal(categorizeTastytradeApiPath("/accounts/5WX01234/positions"), "other");
  assert.equal(categorizeTastytradeApiPath("/accounts/5WX01234/balances"), "other");
  assert.equal(categorizeTastytradeApiPath("/customers/me/accounts"), "other");
  assert.equal(categorizeTastytradeApiPath("/instruments/equity-options"), "other");
  assert.equal(categorizeTastytradeApiPath("/oauth/token"), "other");
  assert.equal(categorizeTastytradeApiPath(""), "other");
});

// Date key format — must match the feed's M-D-YYYY with no zero padding.

test("date key: no zero padding, M-D-YYYY", () => {
  assert.equal(getApiCallDateKey(new Date(2026, 6, 19)), "7-19-2026");
  assert.equal(getApiCallDateKey(new Date(2026, 0, 5)), "1-5-2026");
  assert.equal(getApiCallDateKey(new Date(2026, 11, 31)), "12-31-2026");
});

// Daily rollover.

test("rollover: same-day counts are preserved, new day resets to zero", () => {
  const day: ApiCallCounts = {
    date: "7-19-2026",
    chainWalks: 3,
    quotes: 10,
    marketMetrics: 2,
    orders: 1,
    other: 5,
  };

  assert.equal(rollCountsForDate(day, "7-19-2026"), day);

  const nextDay = rollCountsForDate(day, "7-20-2026");
  assert.deepEqual(nextDay, {
    date: "7-20-2026",
    chainWalks: 0,
    quotes: 0,
    marketMetrics: 0,
    orders: 0,
    other: 0,
  });
});

test("rollover: null state starts a fresh zeroed day", () => {
  assert.deepEqual(rollCountsForDate(null, "7-19-2026"), {
    date: "7-19-2026",
    chainWalks: 0,
    quotes: 0,
    marketMetrics: 0,
    orders: 0,
    other: 0,
  });
});

// Restart hydration — adopting a persisted same-day file.

test("hydrate: same-day file restores counts; junk values become 0", () => {
  const restored = hydrateCountsFromSaved(
    {
      date: "7-19-2026",
      chainWalks: 7,
      quotes: "12",
      marketMetrics: -3,
      orders: "junk",
      updatedAt: "2026-07-19T20:00:00.000Z",
    },
    "7-19-2026",
  );

  assert.deepEqual(restored, {
    date: "7-19-2026",
    chainWalks: 7,
    quotes: 12,
    marketMetrics: 0,
    orders: 0,
    other: 0,
  });
});

test("hydrate: stale-day or malformed files are rejected", () => {
  assert.equal(hydrateCountsFromSaved({ date: "7-18-2026", quotes: 5 }, "7-19-2026"), null);
  assert.equal(hydrateCountsFromSaved(null, "7-19-2026"), null);
  assert.equal(hydrateCountsFromSaved("garbage", "7-19-2026"), null);
  assert.equal(hydrateCountsFromSaved({}, "7-19-2026"), null);
});

// Directory resolution — cross-repo contract with the feed's reader.

test("counts dir: env API_CALL_COUNTS_DIR wins, default is ~/golden-lion/json/api-call-counts", () => {
  const previous = process.env.API_CALL_COUNTS_DIR;
  try {
    process.env.API_CALL_COUNTS_DIR = "/tmp/custom-counts";
    assert.equal(resolveApiCallCountsDir(), "/tmp/custom-counts");

    delete process.env.API_CALL_COUNTS_DIR;
    assert.equal(
      resolveApiCallCountsDir(),
      path.join(os.homedir(), "golden-lion", "json", "api-call-counts"),
    );
  } finally {
    if (previous === undefined) delete process.env.API_CALL_COUNTS_DIR;
    else process.env.API_CALL_COUNTS_DIR = previous;
  }
});
