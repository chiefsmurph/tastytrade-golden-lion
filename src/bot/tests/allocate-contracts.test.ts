import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateContractsByWeight,
  buildRouteOrders,
  candidateDteResultFields,
} from "../actions/manage-allocation";

const EVEN_WEIGHTS = { bidWeight: 0.33, midWeight: 0.33, askWeight: 0.34 };

test("splits capital across routes by weight, respecting whole contracts", () => {
  // bid 1.00 / ask 1.20 → route prices 1.00 / 1.10 / 1.20, i.e. $100/$110/$120.
  const routes = buildRouteOrders(1.0, 1.2, EVEN_WEIGHTS);
  const allocated = allocateContractsByWeight(routes, 600);
  const totalSpend = allocated.reduce((sum, r) => sum + r.estimatedOrderValue, 0);
  const totalQty = allocated.reduce((sum, r) => sum + r.quantity, 0);
  assert.ok(totalSpend <= 600, "never overspends the available capital");
  assert.ok(totalQty >= 1, "buys at least one contract when affordable");
  // Greedy remainder should pack close to the budget, not leave a whole contract unbought.
  assert.ok(600 - totalSpend < 100, "remainder loop uses leftover capital");
});

test("allocates zero when capital cannot afford a single contract", () => {
  const routes = buildRouteOrders(1.0, 1.2, EVEN_WEIGHTS);
  const allocated = allocateContractsByWeight(routes, 50);
  assert.equal(allocated.reduce((sum, r) => sum + r.quantity, 0), 0);
});

test("zero/negative capital or weight is a no-op", () => {
  const routes = buildRouteOrders(1.0, 1.2, EVEN_WEIGHTS);
  assert.equal(
    allocateContractsByWeight(routes, 0).reduce((s, r) => s + r.quantity, 0),
    0,
  );
  const zeroWeightRoutes = buildRouteOrders(1.0, 1.2, {
    bidWeight: 0,
    midWeight: 0,
    askWeight: 0,
  });
  assert.equal(zeroWeightRoutes.length, 0, "routes with zero weight are filtered out");
});

test("buildRouteOrders drops routes with zero weight or price", () => {
  const routes = buildRouteOrders(1.0, 1.2, { bidWeight: 0.5, midWeight: 0, askWeight: 0.5 });
  assert.deepEqual(routes.map((r) => r.route), ["bid", "ask"]);
});

test("candidateDteResultFields maps DTE fields from a candidate", () => {
  assert.deepEqual(
    candidateDteResultFields({
      dte: 21,
      minDTE: 14,
      maxDTE: 30,
      preferredDTE: 21,
      usedDteFallback: false,
    } as never),
    {
      candidateDTE: 21,
      minDTE: 14,
      maxDTE: 30,
      preferredDTE: 21,
      usedDteFallback: false,
    },
  );
});

test("candidateDteResultFields returns undefineds for a null candidate", () => {
  assert.deepEqual(candidateDteResultFields(null), {
    candidateDTE: undefined,
    minDTE: undefined,
    maxDTE: undefined,
    preferredDTE: undefined,
    usedDteFallback: undefined,
  });
});
