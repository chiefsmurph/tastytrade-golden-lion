// Spray-buy RAMP + DWELL math (pure).
//
// This replaces the old front-loaded static-slice model. Instead of pre-cutting
// the target into N discrete LIMIT slices that get "left behind" when the price
// runs away, the spray now defines a TIME-RAMPED CUMULATIVE TARGET and drives a
// SINGLE tick-chasing order against the SHORTFALL each run cycle. Everything
// keys off OBSERVED fills, so it is idempotent and can never double-count on a
// cancel-vs-fill race.
//
// Two pure pieces live here:
//
//   1. cumulativeAllowed(elapsedMs, windowMs, total, frontLoad)
//      A front-loaded rising target: how many contracts you are ALLOWED to have
//      filled by a given point in the spray window. Most of the size is unlocked
//      early (front-loaded), the rest ramps in over the window, reaching `total`
//      at (or before) the window end. This is what makes a fast runner mostly
//      captured immediately while still spreading the tail.
//
//   2. dwell(f, baseMs, k)  and  fFraction(currentLimit, mid, ask)
//      The f-scaled dwell: f is how far the working limit sits between the LIVE
//      mid (f=0) and the LIVE ask (f=1). Dwell (how long to rest a limit before
//      advancing it a tick) INCREASES with f — near mid we advance fast (fill
//      prob low, each tick cheap), near ask we are patient (fill prob high, each
//      tick is real money). Because f is recomputed against the LIVE book every
//      cycle, a runner whose mid keeps rising above our limit keeps us "near
//      mid" → fast; a stagnant name lets us climb to near-ask → patient. No
//      separate momentum detector is needed.
//
// PURE: module constants + exported fns, no clock, no IO, no classes / `this`.
// The stateful cross-cycle store (spray-store.ts) and executor (spray-buy.ts)
// build on this. Keeping the arithmetic here means the ramp shape and the dwell
// curve are unit-testable in isolation.

export interface RampInput {
  // Total contracts to acquire across the spray window (>= 1, integer).
  totalContracts: number;
  // Total window over which the cumulative target ramps to full, in ms (>= 0).
  windowMs: number;
  // Front-load exponent driver in [0, 1]. 0 => LINEAR ramp (even over time);
  // 1 => maximally front-loaded (most of the target unlocked in the first
  // fraction of the window). Defaults to 0.6.
  frontLoad?: number;
}

const DEFAULT_FRONT_LOAD = 0.6;

// Fraction of the target unlocked IMMEDIATELY at t=0 (the "slice 0" clip). A
// higher front-load unlocks a bigger immediate chunk. This is what lets a fast
// runner be mostly captured right away while the tail still ramps in. Always
// unlocks at least one contract so the chaser has something to place on cycle 0.
function immediateFraction(frontLoad: number): number {
  const b = clamp(frontLoad, 0, 1);
  // b=0 (linear) => 0 immediate (pure time ramp); b=1 => 0.5 immediate.
  return b * 0.5;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

// Map the [0,1] front-load driver to a concave power exponent in (0, 1]. A
// larger front-load => a SMALLER exponent => a curve that rises steeply early
// and flattens late (front-loaded). front-load 0 => exponent 1 => a straight
// linear ramp. front-load 1 => exponent 0.25 => strongly front-loaded.
export function frontLoadExponent(frontLoad: number): number {
  const b = clamp(frontLoad, 0, 1);
  return 1 - b * 0.75; // b=0 -> 1 (linear); b=1 -> 0.25 (steep early)
}

// The unit-interval ramp SHAPE: for a normalized time t in [0,1], returns the
// fraction of the total that is allowed to be filled by then, in [0,1]. Concave
// and front-loaded: shape(0)=0, shape(1)=1, and shape(t) >= t for a front-load
// > 0 (more allowed earlier than a linear ramp would give).
export function rampShape(t: number, frontLoad: number): number {
  const clampedT = clamp(t, 0, 1);
  return Math.pow(clampedT, frontLoadExponent(frontLoad));
}

// Cumulative CONTRACTS allowed to be filled by `elapsedMs` into the window.
// Front-loaded and monotonically non-decreasing; 0 at elapsed 0 is NOT forced —
// slice-0 equivalent immediacy comes from the ramp already unlocking a chunk at
// t=0+ via the concave shape, plus the executor placing an order as soon as any
// shortfall exists. Reaches `total` at (and stays at `total` past) windowMs.
// Rounds DOWN so we never authorize more than the shape strictly allows.
export function cumulativeAllowed(
  elapsedMs: number,
  input: RampInput,
): number {
  const total = Math.max(0, Math.floor(input.totalContracts));
  if (total <= 0) return 0;
  const windowMs = Math.max(0, input.windowMs);
  const frontLoad = input.frontLoad ?? DEFAULT_FRONT_LOAD;

  // A zero (or past-window) elapsed on a zero window means "fully unlocked".
  if (windowMs <= 0 || elapsedMs >= windowMs) return total;
  const t = clamp(elapsedMs / windowMs, 0, 1);
  const rampAllowed = Math.floor(rampShape(t, frontLoad) * total);
  // Immediate floor: the front-loaded "slice 0" clip is available from t=0, and
  // always at least one contract so cycle 0 has a shortfall to place.
  const immediate = Math.max(1, Math.floor(immediateFraction(frontLoad) * total));
  const allowed = Math.max(rampAllowed, elapsedMs >= 0 ? immediate : 0);
  return clamp(allowed, 0, total);
}

// f = how far the working limit sits between the LIVE mid and the LIVE ask.
// 0 at (or below) mid, 1 at (or above) ask. Degrades safely when the book is
// crossed/degenerate (ask <= mid) → treat as at-ask (f=1, be patient).
export function fFraction(currentLimit: number, mid: number, ask: number): number {
  if (!(ask > mid)) return 1;
  return clamp((currentLimit - mid) / (ask - mid), 0, 1);
}

export interface DwellInput {
  // Base dwell in ms at f=0 (near mid): the fastest advance interval.
  baseMs: number;
  // Steepness of the patience ramp. dwell = base·(1 + k·f²). Larger k => much
  // more patient near the ask. Defaults to 3.
  k?: number;
}

const DEFAULT_DWELL_K = 3;

// f-scaled dwell: base·(1 + k·f²). Increasing in f (quadratic), so near mid the
// dwell is ~base (advance fast) and near ask it is base·(1+k) (be patient).
// Recompute f against the LIVE mid/ask every cycle so it re-anchors to a moving
// book — that live re-anchoring is what turns momentum into speed for free.
export function dwellMs(f: number, input: DwellInput): number {
  const base = Math.max(0, input.baseMs);
  const k = input.k != null && input.k >= 0 ? input.k : DEFAULT_DWELL_K;
  const clampedF = clamp(f, 0, 1);
  return base * (1 + k * clampedF * clampedF);
}

// Whether the working order has dwelled long enough at its current limit to
// advance a tick, given the LIVE book (so a runner that lifts the mid keeps f
// low → short dwell → we advance sooner). `sinceLastMoveMs` is how long the
// current limit has rested.
export function shouldAdvanceTick(
  sinceLastMoveMs: number,
  currentLimit: number,
  mid: number,
  ask: number,
  dwell: DwellInput,
): boolean {
  const f = fFraction(currentLimit, mid, ask);
  return sinceLastMoveMs >= dwellMs(f, dwell);
}

// The spread-gate ceiling for a chase: never chase past the ask, and never
// chase into a spread wider than the entry gate allows. Returns the highest
// limit the chaser may use, or null when the book is unusable / the spread is
// blown out past the gate (caller should NOT place).
export function chaseCeiling(
  bid: number,
  ask: number,
  maxSpreadPct: number,
): number | null {
  if (!(ask > 0)) return null;
  if (bid > 0 && ask > bid && maxSpreadPct > 0) {
    const spreadPct = (ask - bid) / ((ask + bid) / 2);
    if (spreadPct > maxSpreadPct) return null;
  }
  return ask;
}

// SEC-style minimum tick for an option at a given price (mirrors the
// manage-allocation chaser's rule): 5c under $3, 10c at/above.
export function minOptionTick(price: number): number {
  return price < 3.0 ? 0.05 : 0.1;
}

// Dynamic tick size for the chase: split the mid→ceiling gap into MAX_STEPS
// increments (aggressive on wide spreads, gentle on tight), floored at the SEC
// minimum. Mirrors calculateDynamicTickSize in manage-allocation so both chase
// paths behave identically.
export function chaseTickSize(mid: number, ceiling: number, maxSteps: number): number {
  const minTick = minOptionTick(mid);
  if (!(ceiling > mid) || !Number.isFinite(ceiling)) return minTick;
  const steps = Math.max(1, Math.floor(maxSteps));
  return Math.max((ceiling - mid) / steps, minTick);
}
