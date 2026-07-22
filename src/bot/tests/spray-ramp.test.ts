import test from "node:test";
import assert from "node:assert/strict";
import {
  chaseCeiling,
  chaseTickSize,
  cumulativeAllowed,
  dwellMs,
  fFraction,
  frontLoadExponent,
  minOptionTick,
  rampShape,
  shouldAdvanceTick,
} from "../actions/spray-ramp";

// ── Ramp target math ────────────────────────────────────────────────────────

test("rampShape is front-loaded: allows more early than a linear ramp", () => {
  // With front-load > 0, shape(t) >= t for all t in (0,1): more unlocked earlier.
  for (const t of [0.1, 0.25, 0.5, 0.75]) {
    assert.ok(
      rampShape(t, 0.6) >= t - 1e-9,
      `shape(${t}) should be >= linear t with front-load`,
    );
  }
  // Endpoints are pinned.
  assert.equal(rampShape(0, 0.6), 0);
  assert.equal(rampShape(1, 0.6), 1);
});

test("frontLoad 0 is a straight linear ramp (exponent 1)", () => {
  assert.equal(frontLoadExponent(0), 1);
  for (const t of [0.2, 0.5, 0.8]) {
    assert.ok(Math.abs(rampShape(t, 0) - t) < 1e-9, `linear at t=${t}`);
  }
});

test("higher front-load unlocks strictly more of the target early", () => {
  const t = 0.2;
  const low = rampShape(t, 0.2);
  const high = rampShape(t, 0.9);
  assert.ok(high > low, "steeper front-load allows more at the same early t");
});

test("cumulativeAllowed is monotonic non-decreasing and reaches total at window end", () => {
  const input = { totalContracts: 10, windowMs: 300_000, frontLoad: 0.6 };
  let prev = -1;
  for (let ms = 0; ms <= 300_000; ms += 10_000) {
    const allowed = cumulativeAllowed(ms, input);
    assert.ok(allowed >= prev, `non-decreasing at ${ms}ms (${allowed} < ${prev})`);
    assert.ok(allowed <= 10, "never exceeds total");
    prev = allowed;
  }
  assert.equal(cumulativeAllowed(300_000, input), 10, "full at window end");
  assert.equal(cumulativeAllowed(999_999, input), 10, "stays full past window");
});

test("cumulativeAllowed front-loads: >= half the target by 25% of the window", () => {
  const input = { totalContracts: 12, windowMs: 400_000, frontLoad: 0.7 };
  const quarter = cumulativeAllowed(100_000, input);
  assert.ok(quarter >= 6, `expected >= 6 by 25% window, got ${quarter}`);
});

test("cumulativeAllowed handles degenerate inputs", () => {
  assert.equal(cumulativeAllowed(0, { totalContracts: 0, windowMs: 1000 }), 0);
  assert.equal(cumulativeAllowed(50, { totalContracts: 5, windowMs: 0 }), 5, "zero window => fully unlocked");
  assert.equal(cumulativeAllowed(-10, { totalContracts: 5, windowMs: 1000 }), 0);
});

// ── f-scaled dwell curve ────────────────────────────────────────────────────

test("fFraction is 0 at mid, 1 at ask, linear between", () => {
  assert.equal(fFraction(1.0, 1.0, 2.0), 0, "at mid => 0");
  assert.equal(fFraction(2.0, 1.0, 2.0), 1, "at ask => 1");
  assert.equal(fFraction(1.5, 1.0, 2.0), 0.5, "halfway => 0.5");
  // Below mid clamps to 0, above ask clamps to 1.
  assert.equal(fFraction(0.5, 1.0, 2.0), 0);
  assert.equal(fFraction(3.0, 1.0, 2.0), 1);
});

test("fFraction degrades to at-ask (patient) on a crossed/degenerate book", () => {
  assert.equal(fFraction(1.0, 2.0, 2.0), 1, "ask == mid => treat as at-ask");
  assert.equal(fFraction(1.0, 3.0, 2.0), 1, "crossed => treat as at-ask");
});

test("dwell increases with f: fast near mid, patient near ask", () => {
  const cfg = { baseMs: 20_000, k: 3 };
  const nearMid = dwellMs(0.0, cfg);
  const halfway = dwellMs(0.5, cfg);
  const nearAsk = dwellMs(1.0, cfg);
  assert.equal(nearMid, 20_000, "base dwell at f=0");
  assert.ok(halfway > nearMid, "more patient as f rises");
  assert.ok(nearAsk > halfway, "most patient at the ask");
  assert.equal(nearAsk, 20_000 * (1 + 3), "base·(1+k) at f=1");
});

test("shouldAdvanceTick re-anchors to the LIVE book (runner => advance fast)", () => {
  const cfg = { baseMs: 20_000, k: 3 };
  // Limit 1.00. On a RUNNER the mid rose to 1.00 (our limit == new mid), so
  // f≈0 => short dwell => after ~base ms we advance.
  assert.equal(
    shouldAdvanceTick(21_000, 1.0, /*mid*/ 1.0, /*ask*/ 1.4, cfg),
    true,
    "runner: limit at the risen mid => f low => advance after base",
  );
  // Same 21s dwell but on a STAGNANT name where our limit sits at the ask
  // (f=1 => dwell = base·4 = 80s) => NOT ready.
  assert.equal(
    shouldAdvanceTick(21_000, 1.4, /*mid*/ 1.2, /*ask*/ 1.4, cfg),
    false,
    "stagnant: limit at ask => f high => stay patient",
  );
});

// ── ceiling / spread gate / tick ────────────────────────────────────────────

test("chaseCeiling never exceeds the ask", () => {
  assert.equal(chaseCeiling(1.0, 1.2, 0.5), 1.2, "ceiling is the ask");
});

test("chaseCeiling returns null when the spread is blown out past the gate", () => {
  // bid 1.00 / ask 2.00 => spread 66% of mid; a 20% gate rejects it.
  assert.equal(chaseCeiling(1.0, 2.0, 0.2), null);
  // Same book, generous 80% gate => allowed.
  assert.equal(chaseCeiling(1.0, 2.0, 0.8), 2.0);
});

test("chaseCeiling returns null on an unusable book (no ask)", () => {
  assert.equal(chaseCeiling(1.0, 0, 0.5), null);
});

test("minOptionTick and chaseTickSize honor SEC minimums and split the gap", () => {
  assert.equal(minOptionTick(1.0), 0.05);
  assert.equal(minOptionTick(5.0), 0.1);
  // mid 1.00, ceiling 2.00, 10 steps => 0.10 tick (> the 0.05 floor).
  assert.ok(Math.abs(chaseTickSize(1.0, 2.0, 10) - 0.1) < 1e-9);
  // Tight gap floors at the SEC minimum.
  assert.equal(chaseTickSize(1.0, 1.02, 10), 0.05);
});
