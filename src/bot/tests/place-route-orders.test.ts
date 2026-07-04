import test from "node:test";
import assert from "node:assert/strict";

import { placeRouteOrders } from "../actions/manage-allocation";
import type { AllocationRouteResult } from "../actions/manage-allocation";

function buildRouteOrder(overrides: Partial<AllocationRouteResult> = {}): AllocationRouteResult {
  return {
    estimatedOrderValue: 100,
    limitPrice: 1.25,
    placedOrder: false,
    quantity: 1,
    route: "ask",
    weight: 1,
    ...overrides,
  };
}

test("placeRouteOrders skips orders with zero quantity", async () => {
  let createOrderCalls = 0;
  const results = await placeRouteOrders(
    "ACC-1",
    "RUM   260619C00100000",
    [buildRouteOrder({ quantity: 0 })],
    1.0,
    1.5,
    {
      createOrder: async () => {
        createOrderCalls++;
        return { order: { id: "1" } } as never;
      },
    },
  );

  assert.equal(createOrderCalls, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.placedOrder, false);
  assert.match(results[0]?.skippedReason ?? "", /rounded to zero/);
});

test("placeRouteOrders rests a bid-route order without chasing", async () => {
  // bid=1.0, ask=1.5 → bid route rests at 1.00 with maxTicks=0; no fill check
  const submittedPrices: string[] = [];
  let waitForFillCalls = 0;

  const results = await placeRouteOrders(
    "ACC-1",
    "RUM   260619C00100000",
    [buildRouteOrder({ route: "bid" })],
    1.0,
    1.5,
    {
      createOrder: async (_acct, order) => {
        submittedPrices.push(String((order as { price?: string }).price ?? ""));
        return { order: { id: "1" } } as never;
      },
      waitForFill: async () => {
        waitForFillCalls++;
        return false;
      },
    },
  );

  assert.deepEqual(submittedPrices, ["1.00"]);
  assert.equal(waitForFillCalls, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.placedOrder, true);
});

test("placeRouteOrders places ask-route order and stops when fill detected", async () => {
  // bid=1.0, ask=1.5 → ask route starts at mid (1.25); fills on first tick
  const submittedPrices: string[] = [];

  const results = await placeRouteOrders(
    "ACC-1",
    "RUM   260619C00100000",
    [buildRouteOrder({ route: "ask" })],
    1.0,
    1.5,
    {
      createOrder: async (_acct, order) => {
        submittedPrices.push(String((order as { price?: string }).price ?? ""));
        return { order: { id: String(submittedPrices.length) } } as never;
      },
      waitForFill: async () => true,
    },
  );

  assert.deepEqual(submittedPrices, ["1.25"]);
  assert.equal(results[0]?.placedOrder, true);
});

test("placeRouteOrders chases ask route from mid toward ceiling on no-fill", async () => {
  // bid=1.0, ask=1.5 → mid=1.25, tickSize=max(0.25/10, 0.05)=0.05
  // First order at 1.25, no fill → cancel → second order at 1.30, fills
  const submittedPrices: string[] = [];
  const cancelledIds: number[] = [];
  let fillCall = 0;

  const results = await placeRouteOrders(
    "ACC-1",
    "RUM   260619C00100000",
    [buildRouteOrder({ route: "ask" })],
    1.0,
    1.5,
    {
      createOrder: async (_acct, order) => {
        submittedPrices.push(String((order as { price?: string }).price ?? ""));
        return { order: { id: String(submittedPrices.length) } } as never;
      },
      cancelOrder: async (_acct, orderId) => {
        cancelledIds.push(orderId);
      },
      waitForFill: async () => {
        fillCall++;
        return fillCall >= 2;
      },
    },
  );

  assert.deepEqual(submittedPrices, ["1.25", "1.30"]);
  assert.deepEqual(cancelledIds, [1]);
  assert.equal(results[0]?.placedOrder, true);
});

test("placeRouteOrders stops chasing when cancel cannot be confirmed (no double-order)", async () => {
  const submittedPrices: string[] = [];

  const results = await placeRouteOrders(
    "ACC-1",
    "RUM   260619C00100000",
    [buildRouteOrder({ route: "ask" })],
    1.0,
    1.5,
    {
      createOrder: async (_acct, order) => {
        submittedPrices.push(String((order as { price?: string }).price ?? ""));
        return { order: { id: String(submittedPrices.length) } } as never;
      },
      cancelOrder: async () => {
        throw new Error("cancel rejected");
      },
      waitForFill: async () => false,
    },
  );

  // One order placed at mid; failed cancel must break the chase before a second
  // sell goes live against the still-working first order.
  assert.deepEqual(submittedPrices, ["1.25"]);
  assert.equal(results[0]?.placedOrder, true);
});

test("placeRouteOrders handles multiple route orders independently", async () => {
  let createOrderCalls = 0;

  const results = await placeRouteOrders(
    "ACC-1",
    "RUM   260619C00100000",
    [buildRouteOrder({ route: "bid" }), buildRouteOrder({ route: "bid", quantity: 2 })],
    1.0,
    1.5,
    {
      createOrder: async () => {
        createOrderCalls++;
        return { order: { id: String(createOrderCalls) } } as never;
      },
    },
  );

  assert.equal(createOrderCalls, 2);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.placedOrder === true));
});
