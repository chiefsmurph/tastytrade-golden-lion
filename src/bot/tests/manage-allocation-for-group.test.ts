import test from "node:test";
import assert from "node:assert/strict";

import {
  manageAllocationForGroup,
  type AllocationBudget,
  type ManageAllocationDependencies,
} from "../actions/manage-allocation";
import type { PositionGroupEvaluation } from "../evaluate-position";
import type { ExecutionTargets } from "~/strategy/evaluate-trading-strategy";

const baseTargets: ExecutionTargets = {
  targetDTE: 21,
  targetAccountExposure: 0.5,
  bidWeight: 0.34,
  midWeight: 0.33,
  askWeight: 0.33,
};

const fullBudget: AllocationBudget = {
  buyingPowerRemaining: 100000,
  portfolioExposure: 0,
  totalCapital: 100000,
};

function buildEvaluation(
  targets: ExecutionTargets | undefined,
): PositionGroupEvaluation {
  return {
    currentReturn: 0,
    executionTargets: targets,
    groupKey: "LCID::call",
    metrics: {
      currentAskPrice: 1.2,
      currentBidPrice: 1.0,
      currentTime: new Date(),
      lastActionTime: new Date(),
      weightedAverageFill: 1,
    },
    positionSnapshots: [
      {
        currentAskPrice: 1.2,
        currentBidPrice: 1.0,
        lastActionTime: new Date(),
        position: {
          "account-number": "ACC-1",
          "instrument-type": "Option",
          quantity: 1,
          symbol: "LCID  250117C00010000",
        },
        quantityWeight: 1,
        weightedAverageFill: 1,
      },
    ],
    positions: [
      {
        "account-number": "ACC-1",
        "instrument-type": "Option",
        quantity: 1,
        symbol: "LCID  250117C00010000",
      },
    ] as PositionGroupEvaluation["positions"],
    strategy: { action: "MANAGE_ALLOCATION", reason: "test" },
    underlyingSymbol: "LCID",
  } as PositionGroupEvaluation;
}

// Health gate fails when the summary reports no healthy target DTEs.
const failingHealthDeps: ManageAllocationDependencies = {
  getOptionHealth: (async () => ({ summary: { healthyTargets: [] } })) as never,
};

test("manageAllocationForGroup skips when execution targets are missing", async () => {
  const result = await manageAllocationForGroup(
    "ACC-1",
    buildEvaluation(undefined),
    fullBudget,
  );
  assert.equal(result.placedOrder, false);
  assert.equal(result.skippedReason, "execution targets missing");
  assert.deepEqual(result.routeOrders, []);
});

test("manageAllocationForGroup skips when target exposure is zero", async () => {
  const result = await manageAllocationForGroup(
    "ACC-1",
    buildEvaluation({ ...baseTargets, targetAccountExposure: 0 }),
    fullBudget,
  );
  assert.equal(result.skippedReason, "target exposure is zero");
});

test("manageAllocationForGroup skips when no buying power remains", async () => {
  const result = await manageAllocationForGroup(
    "ACC-1",
    buildEvaluation(baseTargets),
    { ...fullBudget, buyingPowerRemaining: 0 },
  );
  assert.equal(result.skippedReason, "no remaining exposure or buying power");
});

test("manageAllocationForGroup skips when portfolio is already at target exposure", async () => {
  const result = await manageAllocationForGroup(
    "ACC-1",
    buildEvaluation(baseTargets),
    { ...fullBudget, portfolioExposure: 100000 },
  );
  assert.equal(result.skippedReason, "no remaining exposure or buying power");
});

test("manageAllocationForGroup skips when the option health gate fails", async () => {
  const result = await manageAllocationForGroup(
    "ACC-1",
    buildEvaluation(baseTargets),
    fullBudget,
    1,
    {},
    failingHealthDeps,
  );
  assert.equal(result.placedOrder, false);
  assert.match(result.skippedReason ?? "", /option health gate failed/);
});
