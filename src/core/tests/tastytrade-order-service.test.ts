import test from "node:test";
import assert from "node:assert/strict";

import { describeOrderError } from "../tastytrade-order-service";

test("describeOrderError extracts status + body from a tastytrade 422", () => {
  const err = {
    message: "Request failed with status code 422",
    response: {
      status: 422,
      data: { error: { code: "invalid_order", message: "nothing to close" } },
    },
  };
  const info = describeOrderError(err);
  assert.equal(info.status, 422);
  assert.deepEqual(info.body, {
    error: { code: "invalid_order", message: "nothing to close" },
  });
});

test("describeOrderError returns undefined fields for a non-HTTP error (no response)", () => {
  const info = describeOrderError(new Error("socket hang up"));
  assert.equal(info.status, undefined);
  assert.equal(info.body, undefined);
});

test("describeOrderError is null-safe for null/undefined and partial responses", () => {
  for (const input of [null, undefined, { response: {} }]) {
    const info = describeOrderError(input);
    assert.equal(info.status, undefined);
    assert.equal(info.body, undefined);
  }
});
