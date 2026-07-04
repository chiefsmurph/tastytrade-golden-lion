import test from "node:test";
import assert from "node:assert/strict";
import { waitForOrderFillById } from "../actions/order-utils";

const FAST = { pollIntervalMs: 1 };

test("filled order resolves true", async () => {
  const result = await waitForOrderFillById("ACC-1", "42", 100, {
    ...FAST,
    getOrder: async () => ({ status: "Filled" }),
  });
  assert.equal(result, true);
});

test("partially filled order resolves true", async () => {
  const result = await waitForOrderFillById("ACC-1", "42", 100, {
    ...FAST,
    getOrder: async () => ({ status: "Partially Filled" }),
  });
  assert.equal(result, true);
});

test("terminal status resolves false", async () => {
  const result = await waitForOrderFillById("ACC-1", "42", 100, {
    ...FAST,
    getOrder: async () => ({ status: "Cancelled" }),
  });
  assert.equal(result, false);
});

test("vanished order (404) is NOT treated as filled", async () => {
  const result = await waitForOrderFillById("ACC-1", "42", 100, {
    ...FAST,
    getOrder: async () => {
      const error = new Error("not found") as Error & { response?: { status: number } };
      error.response = { status: 404 };
      throw error;
    },
  });
  assert.equal(result, false);
});

test("transient errors keep polling until the order fills", async () => {
  let calls = 0;
  const result = await waitForOrderFillById("ACC-1", "42", 500, {
    ...FAST,
    getOrder: async () => {
      calls += 1;
      if (calls < 3) throw new Error("socket hangup");
      return { status: "Filled" };
    },
  });
  assert.equal(result, true);
  assert.equal(calls, 3);
});

test("live order that never fills times out to false", async () => {
  const result = await waitForOrderFillById("ACC-1", "42", 25, {
    ...FAST,
    getOrder: async () => ({ status: "Open" }),
  });
  assert.equal(result, false);
});

test("non-numeric order id resolves false without polling", async () => {
  let calls = 0;
  const result = await waitForOrderFillById("ACC-1", "not-a-number", 100, {
    ...FAST,
    getOrder: async () => {
      calls += 1;
      return { status: "Filled" };
    },
  });
  assert.equal(result, false);
  assert.equal(calls, 0);
});
