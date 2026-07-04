import test from "node:test";
import assert from "node:assert/strict";

import { normalizeGroupExecutionTargetExposures } from "../run-cycle-context";
import type { PositionGroupEvaluation } from "../evaluate-position";
import type { ExecutionTargets } from "~/strategy/evaluate-trading-strategy";

// The normalizer only reads/writes executionTargets.targetAccountExposure, so a
// minimal shape is sufficient. Cast through unknown to avoid the full evaluation.
function group(rawExposure: number | null): PositionGroupEvaluation {
  const executionTargets: ExecutionTargets | undefined =
    rawExposure === null
      ? undefined
      : {
          targetDTE: 14,
          targetAccountExposure: rawExposure,
          askWeight: 0.2,
          bidWeight: 0.3,
          midWeight: 0.5,
        };
  return { executionTargets } as unknown as PositionGroupEvaluation;
}

function exposures(evaluations: PositionGroupEvaluation[]): (number | undefined)[] {
  return evaluations.map((e) => e.executionTargets?.targetAccountExposure);
}

test("rescales two groups proportionally to the total target", () => {
  // raw 0.3 + 0.1 = 0.4; target 0.2 → 0.15 and 0.05 (last = remainder)
  const result = normalizeGroupExecutionTargetExposures(
    [group(0.3), group(0.1)],
    0.2,
  );
  assert.deepEqual(exposures(result), [0.15, 0.05]);
});

test("equal raw exposures split the target evenly", () => {
  const result = normalizeGroupExecutionTargetExposures(
    [group(0.2), group(0.2), group(0.2)],
    0.3,
  );
  assert.deepEqual(exposures(result), [0.1, 0.1, 0.1]);
});

test("the last group absorbs rounding drift so the sum is exact", () => {
  // raw [1,1,1]; target 0.10 → 0.0333.. rounds to 0.03 each; last = 0.10 - 0.06 = 0.04
  const result = normalizeGroupExecutionTargetExposures(
    [group(1), group(1), group(1)],
    0.1,
  );
  assert.deepEqual(exposures(result), [0.03, 0.03, 0.04]);
  const sum = exposures(result).reduce<number>((acc, v) => acc + (v ?? 0), 0);
  assert.equal(sum, 0.1);
});

test("returns evaluations unchanged when the total target is zero", () => {
  const result = normalizeGroupExecutionTargetExposures([group(0.3), group(0.1)], 0);
  assert.deepEqual(exposures(result), [0.3, 0.1]);
});

test("returns evaluations unchanged when raw exposure is all zero", () => {
  const result = normalizeGroupExecutionTargetExposures([group(0), group(0)], 0.2);
  assert.deepEqual(exposures(result), [0, 0]);
});

test("leaves groups without execution targets untouched", () => {
  const result = normalizeGroupExecutionTargetExposures([group(null)], 0.2);
  assert.equal(result[0]?.executionTargets, undefined);
});
