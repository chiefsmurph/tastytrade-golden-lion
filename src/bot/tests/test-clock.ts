// Shared test clock. NOT a test file (no `.test.ts` suffix), so the runner
// ignores it.
//
// WHY THIS EXISTS. The engine reads time-of-day off the LOCAL clock:
//   - `getTimeInMinutes` = `currentTime.getHours() * 60 + currentTime.getMinutes()`
//     (evaluate-trading-strategy.ts, close-position.ts)
//   - `getMorningSpreadThresholdPct` (spread-thresholds.ts) and
//     `isRegularSessionByLocalClock` (liquidity-gate.ts) do the same.
// So a fixture built from a UTC (`...Z`) literal is read by production as a
// DIFFERENT time of day in every timezone, and a fixture built from a bare
// `new Date()` is read as a different time of day every hour. Either one turns
// the suite's result into a function of where and when it happens to run —
// measured on this repo, the same commit produced 4, 3, 1 or 0 failures purely
// from the runner's `TZ` and wall clock.
//
// RULE: one time base per fixture, and that base is LOCAL. Build every fixture
// timestamp here (or with `new Date(y, m, d, ...)`), never from a `...Z` string
// that is later read via `getHours()`.
//
// The anchor is a fixed Wednesday, so the calendar date, the day of week and
// the DST offset are pinned as well — `new Date(); d.setHours(...)` still drifts
// across a DST boundary and across midnight.

/** Wednesday 2026-08-05 — an ordinary trading session, not a holiday/weekend. */
const TEST_CLOCK_YEAR = 2026;
const TEST_CLOCK_MONTH_INDEX = 7; // August (0-based)
const TEST_CLOCK_DAY_OF_MONTH = 5;

/** A local-time Date on the pinned anchor day. */
export function localTimeAt(hours: number, minutes = 0, seconds = 0): Date {
  return localTimeOn(TEST_CLOCK_DAY_OF_MONTH, hours, minutes, seconds);
}

/** A local-time Date on another day of the same pinned month/year. */
export function localTimeOn(
  dayOfMonth: number,
  hours: number,
  minutes = 0,
  seconds = 0,
): Date {
  return new Date(
    TEST_CLOCK_YEAR,
    TEST_CLOCK_MONTH_INDEX,
    dayOfMonth,
    hours,
    minutes,
    seconds,
    0,
  );
}

/** `base` shifted by whole minutes, staying on the same (local) time base. */
export function minutesBefore(base: Date, minutes: number): Date {
  return new Date(base.getTime() - minutes * 60_000);
}
