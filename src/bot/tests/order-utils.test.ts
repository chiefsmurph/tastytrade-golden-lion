import test from "node:test";
import assert from "node:assert/strict";
import {
  getContractMultiplier,
  isOccOptionSymbol,
  waitForOrderFillById,
} from "../actions/order-utils";

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

// The contract multiplier decides whether a realized-P&L row reads in dollars or
// in hundreds of dollars, so the classification has to be exact in both
// directions: every real OCC contract ×100, everything else ×1.
test("isOccOptionSymbol accepts real OCC contracts and nothing else", () => {
  assert.equal(isOccOptionSymbol("AAPL  260619C00100000"), true);
  assert.equal(isOccOptionSymbol("WEN   260717P00012000"), true);
  assert.equal(isOccOptionSymbol("EOSE1 260918C00006000"), true);
  assert.equal(isOccOptionSymbol("SNWV"), false);
  assert.equal(isOccOptionSymbol("AAPL"), false);
  assert.equal(isOccOptionSymbol(""), false);
  assert.equal(isOccOptionSymbol("AAPL  260619C0010000"), false, "strike too short");
  assert.equal(isOccOptionSymbol("AAPL 260619C00100000"), false, "root not padded to 6");
});

test("getContractMultiplier is 100 for options and 1 for equity", () => {
  assert.equal(getContractMultiplier("AAPL  260619C00100000"), 100);
  assert.equal(getContractMultiplier("SNWV"), 1);
  assert.equal(getContractMultiplier(""), 1);
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
