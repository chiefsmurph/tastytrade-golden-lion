import test from "node:test";
import assert from "node:assert/strict";
import {
  abortOpenSlices,
  buildSpraySchedule,
  distributeContracts,
  distributeOffsets,
  getDueSlices,
  isSliceDue,
  summarizeSprayProgress,
  type SpraySliceState,
} from "../actions/spray-schedule";

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function isNonIncreasing(values: number[]): boolean {
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] > values[i - 1]) return false;
  }
  return true;
}

// ---- distributeContracts (front-load distribution) ------------------------

test("distributeContracts sums exactly to the total and is front-loaded", () => {
  const quantities = distributeContracts(10, 3, 0.6);
  assert.equal(sum(quantities), 10, "must conserve the total");
  assert.equal(quantities.length, 3);
  assert.ok(isNonIncreasing(quantities), "front-loaded => non-increasing");
  assert.ok(quantities[0] > quantities[2], "first clip bigger than last");
});

test("distributeContracts bias 0 splits as evenly as possible", () => {
  const quantities = distributeContracts(9, 3, 0);
  assert.deepEqual(quantities, [3, 3, 3]);
});

test("distributeContracts bias 1 is maximally front-loaded", () => {
  const even = distributeContracts(12, 3, 0);
  const skewed = distributeContracts(12, 3, 1);
  assert.equal(sum(skewed), 12);
  assert.ok(skewed[0] > even[0], "higher bias puts more on the first slice");
  assert.ok(isNonIncreasing(skewed));
});

test("distributeContracts never produces an empty slice (floor of 1)", () => {
  const quantities = distributeContracts(4, 4, 1);
  assert.deepEqual(quantities, [1, 1, 1, 1]);
  assert.ok(quantities.every((q) => q >= 1));
});

test("distributeContracts clamps more slices than contracts to one-each", () => {
  // 3 contracts across a requested 5 slices => 3 slices of 1.
  const quantities = distributeContracts(3, 5, 0.5);
  assert.deepEqual(quantities, [1, 1, 1]);
});

test("distributeContracts single slice takes everything", () => {
  assert.deepEqual(distributeContracts(7, 1, 0.5), [7]);
});

test("distributeContracts zero total is empty", () => {
  assert.deepEqual(distributeContracts(0, 3, 0.5), []);
});

// ---- distributeOffsets (interval spacing) ---------------------------------

test("distributeOffsets front slice is immediate and last lands at the window", () => {
  const offsets = distributeOffsets(3, 300_000);
  assert.equal(offsets[0], 0, "first slice fires immediately");
  assert.equal(offsets[offsets.length - 1], 300_000, "last slice at window end");
});

test("distributeOffsets spaces slices evenly across the window", () => {
  const offsets = distributeOffsets(5, 400_000);
  assert.deepEqual(offsets, [0, 100_000, 200_000, 300_000, 400_000]);
});

test("distributeOffsets single slice ignores the window", () => {
  assert.deepEqual(distributeOffsets(1, 300_000), [0]);
});

test("distributeOffsets zero window collapses all slices to 0", () => {
  assert.deepEqual(distributeOffsets(3, 0), [0, 0, 0]);
});

// ---- buildSpraySchedule (combined) ----------------------------------------

test("buildSpraySchedule front-loads quantities and spaces offsets", () => {
  const schedule = buildSpraySchedule({
    totalContracts: 10,
    windowMs: 300_000,
    slices: 3,
    frontLoadBias: 0.6,
  });
  assert.equal(schedule.length, 3);
  assert.equal(sum(schedule.map((s) => s.quantity)), 10);
  assert.equal(schedule[0].offsetMs, 0, "first slice immediate");
  assert.ok(isNonIncreasing(schedule.map((s) => s.quantity)));
  assert.ok(
    schedule[1].offsetMs > 0 && schedule[2].offsetMs > schedule[1].offsetMs,
    "later slices are progressively later",
  );
  assert.deepEqual(
    schedule.map((s) => s.index),
    [0, 1, 2],
  );
});

test("buildSpraySchedule caps slices at the contract count", () => {
  const schedule = buildSpraySchedule({
    totalContracts: 2,
    windowMs: 120_000,
    slices: 8,
  });
  assert.equal(schedule.length, 2, "can't have more slices than contracts");
  assert.equal(sum(schedule.map((s) => s.quantity)), 2);
});

test("buildSpraySchedule zero target yields no slices", () => {
  assert.deepEqual(buildSpraySchedule({ totalContracts: 0, windowMs: 1000 }), []);
});

// ---- due-slice release (interval gating) ----------------------------------

function pending(index: number, quantity: number, offsetMs: number): SpraySliceState {
  return { index, quantity, offsetMs, status: "pending" };
}

test("only slice 0 is due at elapsed 0", () => {
  const slices: SpraySliceState[] = [
    pending(0, 5, 0),
    pending(1, 3, 150_000),
    pending(2, 2, 300_000),
  ];
  const due = getDueSlices(slices, 0);
  assert.equal(due.length, 1);
  assert.equal(due[0].index, 0);
});

test("a later slice becomes due once its offset elapses", () => {
  const slices: SpraySliceState[] = [
    { ...pending(0, 5, 0), status: "placed" },
    pending(1, 3, 150_000),
    pending(2, 2, 300_000),
  ];
  assert.equal(getDueSlices(slices, 150_000).length, 1);
  assert.equal(getDueSlices(slices, 150_000)[0].index, 1);
});

test("isSliceDue is false once a slice is no longer pending", () => {
  assert.equal(isSliceDue({ ...pending(0, 5, 0), status: "placed" }, 10_000), false);
  assert.equal(isSliceDue({ ...pending(0, 5, 0), status: "filled" }, 10_000), false);
});

// ---- partial-fill accounting ----------------------------------------------

test("summarizeSprayProgress accepts a partial fill as a complete spray", () => {
  // Slice 0 filled, slices 1 & 2 aborted (name ran away): got most early.
  const slices: SpraySliceState[] = [
    { ...pending(0, 5, 0), status: "filled", filledQuantity: 5 },
    { ...pending(1, 3, 150_000), status: "aborted" },
    { ...pending(2, 2, 300_000), status: "aborted" },
  ];
  const progress = summarizeSprayProgress(slices);
  assert.equal(progress.filledContracts, 5);
  assert.equal(progress.remainingContracts, 0);
  assert.equal(progress.isComplete, true, "partial fill is a final, complete state");
  assert.equal(progress.totalContracts, 10);
});

test("summarizeSprayProgress is incomplete while any slice is still working", () => {
  const slices: SpraySliceState[] = [
    { ...pending(0, 5, 0), status: "filled", filledQuantity: 5 },
    { ...pending(1, 3, 150_000), status: "placed" },
    pending(2, 2, 300_000),
  ];
  const progress = summarizeSprayProgress(slices);
  assert.equal(progress.filledContracts, 5);
  assert.equal(progress.remainingContracts, 5, "placed + pending still owed");
  assert.equal(progress.isComplete, false);
});

test("summarizeSprayProgress uses filledQuantity for partial contract fills", () => {
  const slices: SpraySliceState[] = [
    { ...pending(0, 5, 0), status: "filled", filledQuantity: 3 },
  ];
  assert.equal(summarizeSprayProgress(slices).filledContracts, 3);
});

// ---- abort (signal change / stop / thesis flip) ---------------------------

test("abortOpenSlices marks pending & placed as aborted, keeps fills", () => {
  const slices: SpraySliceState[] = [
    { ...pending(0, 5, 0), status: "filled", filledQuantity: 5 },
    { ...pending(1, 3, 150_000), status: "placed", orderId: "111" },
    pending(2, 2, 300_000),
  ];
  const aborted = abortOpenSlices(slices);
  assert.equal(aborted[0].status, "filled", "filled slice untouched");
  assert.equal(aborted[1].status, "aborted", "placed slice aborted");
  assert.equal(aborted[2].status, "aborted", "pending slice aborted");
  // Pure: original array not mutated.
  assert.equal(slices[1].status, "placed");
  assert.equal(slices[2].status, "pending");
});

test("abortOpenSlices makes the spray complete (nothing left working)", () => {
  const slices: SpraySliceState[] = [
    { ...pending(0, 5, 0), status: "filled", filledQuantity: 5 },
    pending(1, 3, 150_000),
  ];
  assert.equal(summarizeSprayProgress(slices).isComplete, false);
  assert.equal(summarizeSprayProgress(abortOpenSlices(slices)).isComplete, true);
});
