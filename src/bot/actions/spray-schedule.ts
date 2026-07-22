// Front-loaded spray-buy SCHEDULE math (pure).
//
// When golden-lion wants to buy MORE than one contract of an option, dumping
// the whole clip into a thin book at one instant is a bad idea for two reasons:
//   1. Liquidity — a fat market-taking clip walks the book and gets bad fills.
//   2. Timing — we don't actually know whether now, +30s, or +5min is the
//      better entry, so betting the entire entry on one instant is a coin flip.
//
// A spray-buy splits the target into time-spaced LIMIT slices. It is FRONT-
// LOADED (biggest clip first, immediate; smaller clips later) so a fast runner
// is mostly captured right away while later slices still hedge a near-term dip.
// Later slices are allowed to go unfilled (the name ran away) — that is a fine
// outcome: we got most of the size early and did not chase.
//
// This module is PURE (module vars + exported fns, no classes / `this`, no
// clock, no IO). The stateful cross-cycle store (spray-store.ts) and executor
// (spray-buy.ts) build on it. Keeping the arithmetic here means the front-load
// distribution, interval spacing, and abort/partial-fill accounting are all
// unit-testable in isolation.

export interface SpraySliceSpec {
  // 0-based slice index; slice 0 is the immediate, largest clip.
  index: number;
  // Contracts to buy on this slice (integer, >= 1).
  quantity: number;
  // Milliseconds after the spray START at which this slice becomes due.
  // Slice 0 is always 0 (fire immediately).
  offsetMs: number;
}

export interface SprayScheduleInput {
  // Total contracts to acquire across the whole spray (>= 1).
  totalContracts: number;
  // Total window over which to spread the slices, in milliseconds (>= 0).
  windowMs: number;
  // Front-load bias in [0, 1]. 0 => even split; 1 => maximally front-loaded
  // (first slice as big as the bias allows). Defaults to 0.5.
  frontLoadBias?: number;
  // Desired number of slices. The realized count is clamped to
  // [1, totalContracts] (can't have more slices than contracts, since every
  // slice buys at least one whole contract). Defaults to 3.
  slices?: number;
}

const DEFAULT_FRONT_LOAD_BIAS = 0.5;
const DEFAULT_SLICE_COUNT = 3;

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

// Distribute `total` contracts across `sliceCount` slices with a front-load
// bias. Every slice gets at least 1 contract; the remainder is handed out with
// a geometrically-decaying weight so earlier slices get the bigger clips. The
// returned array sums EXACTLY to `total` and is monotonically non-increasing.
export function distributeContracts(
  total: number,
  sliceCount: number,
  frontLoadBias: number,
): number[] {
  const n = Math.max(1, Math.floor(sliceCount));
  const t = Math.max(0, Math.floor(total));
  if (t <= 0) return [];
  if (n === 1) return [t];
  if (t <= n) {
    // One contract per slice for the first `t` slices; no empty slices.
    return Array.from({ length: t }, () => 1);
  }

  const bias = clamp(frontLoadBias, 0, 1);

  // Floor everyone at 1, then split the surplus by a decaying weight. The decay
  // ratio goes from 1 (even, bias 0) toward a steep 0.35 (bias 1). A larger
  // bias => earlier slices claim a larger share of the surplus.
  const surplus = t - n;
  const ratio = 1 - bias * 0.65; // bias 0 -> 1.0 (even), bias 1 -> 0.35
  const weights: number[] = [];
  let w = 1;
  let weightSum = 0;
  for (let i = 0; i < n; i += 1) {
    weights.push(w);
    weightSum += w;
    w *= ratio;
  }

  // Largest-remainder apportionment of the surplus so the total is exact and
  // earlier (larger-weight) slices win the leftover units.
  const raw = weights.map((weight) => (surplus * weight) / weightSum);
  const base = raw.map((value) => Math.floor(value));
  let assigned = base.reduce((sum, value) => sum + value, 0);
  const remainders = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  let r = 0;
  while (assigned < surplus) {
    base[remainders[r % remainders.length].index] += 1;
    assigned += 1;
    r += 1;
  }

  const result = base.map((extra) => extra + 1);

  // Enforce non-increasing order without changing the total: any inversion
  // (a later slice larger than an earlier one, which the apportionment can
  // occasionally produce on ties) is smoothed by pulling a unit forward.
  for (let i = 1; i < result.length; i += 1) {
    if (result[i] > result[i - 1]) {
      const move = result[i] - result[i - 1];
      result[i - 1] += move;
      result[i] -= move;
    }
  }

  return result;
}

// Space `sliceCount` slices across `windowMs`. Slice 0 is always at offset 0
// (immediate). The remaining slices are evenly spread over the window so the
// LAST slice lands at (or before) windowMs. With one slice the window is
// irrelevant (single offset 0).
export function distributeOffsets(sliceCount: number, windowMs: number): number[] {
  const n = Math.max(1, Math.floor(sliceCount));
  const window = Math.max(0, Math.floor(windowMs));
  if (n === 1) return [0];
  const step = window / (n - 1);
  return Array.from({ length: n }, (_, i) => Math.round(i * step));
}

// Build the full front-loaded slice schedule. Combines the contract split and
// the offset spacing. Returns [] for a non-positive target.
export function buildSpraySchedule(input: SprayScheduleInput): SpraySliceSpec[] {
  const total = Math.max(0, Math.floor(input.totalContracts));
  if (total <= 0) return [];

  const requested = Math.max(1, Math.floor(input.slices ?? DEFAULT_SLICE_COUNT));
  const sliceCount = clamp(requested, 1, total);
  const bias = input.frontLoadBias ?? DEFAULT_FRONT_LOAD_BIAS;

  const quantities = distributeContracts(total, sliceCount, bias);
  const offsets = distributeOffsets(quantities.length, input.windowMs);

  return quantities.map((quantity, index) => ({
    index,
    quantity,
    offsetMs: offsets[index],
  }));
}

export interface SprayProgress {
  totalContracts: number;
  filledContracts: number;
  // Contracts still owed on slices that have neither filled nor been aborted.
  remainingContracts: number;
  isComplete: boolean;
}

export type SpraySliceStatus = "pending" | "placed" | "filled" | "aborted";

export interface SpraySliceState extends SpraySliceSpec {
  status: SpraySliceStatus;
  // Broker order id once the slice has been placed (string form).
  orderId?: string;
  // Contracts actually filled on this slice (0 until confirmed).
  filledQuantity?: number;
}

// A slice is DUE when the current elapsed time is at/after its offset and it is
// still pending. Slice 0 (offset 0) is due immediately.
export function isSliceDue(slice: SpraySliceState, elapsedMs: number): boolean {
  return slice.status === "pending" && elapsedMs >= slice.offsetMs;
}

// The slices that should be released THIS tick, given elapsed time. Front slice
// first. Callers place these as LIMIT orders. Aborting the spray means simply
// not calling this again (the store marks the rest aborted).
export function getDueSlices(
  slices: SpraySliceState[],
  elapsedMs: number,
): SpraySliceState[] {
  return slices.filter((slice) => isSliceDue(slice, elapsedMs));
}

// Roll up fill/abort accounting. `filledContracts` counts confirmed fills;
// `remainingContracts` is what is still owed on slices that are neither filled
// nor aborted. A spray is COMPLETE when no slice is still pending or placed
// (everything either filled or aborted) — partial fills are an accepted, final
// outcome, not an error.
export function summarizeSprayProgress(slices: SpraySliceState[]): SprayProgress {
  let filledContracts = 0;
  let remainingContracts = 0;
  let anyOutstanding = false;

  for (const slice of slices) {
    if (slice.status === "filled") {
      filledContracts += slice.filledQuantity ?? slice.quantity;
    } else if (slice.status === "aborted") {
      // Aborted slices owe nothing further.
    } else {
      // pending or placed: still outstanding.
      remainingContracts += slice.quantity;
      anyOutstanding = true;
    }
  }

  const totalContracts = slices.reduce((sum, slice) => sum + slice.quantity, 0);
  return {
    totalContracts,
    filledContracts,
    remainingContracts,
    isComplete: !anyOutstanding,
  };
}

// Mark every still-open (pending or placed) slice as aborted. Used on a signal
// change / stop / thesis flip: we keep whatever already filled and walk away
// from the rest — no chasing. Returns a NEW array (pure); does not mutate input.
export function abortOpenSlices(slices: SpraySliceState[]): SpraySliceState[] {
  return slices.map((slice) =>
    slice.status === "pending" || slice.status === "placed"
      ? { ...slice, status: "aborted" as const }
      : slice,
  );
}
