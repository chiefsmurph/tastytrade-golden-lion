import test from "node:test";
import assert from "node:assert/strict";

import { getPstTimeInMinutes } from "~/bot/day-report-store";
import { EOD_FORCED_CLOSE_MINUTE } from "~/strategy/spread-thresholds";

// The scheduler stops calling runBotCycle once the regular equities session
// closes at 1:00 PM PT. The day-report writer therefore has to pass its time
// gate *before* 1:00 PM PT, on a still-live cycle — the June-30-frozen files
// were the symptom of a gate pinned to 1:00 PM PT that no running cycle could
// ever reach (v8 item #12).

const ONE_PM_PT_MINUTES = 13 * 60;

// PDT is UTC-7 (June/July). Build explicit instants so the assertions hold
// regardless of the test machine's local timezone.
function atPdt(time: string): Date {
  return new Date(`2026-07-06T${time}:00-07:00`);
}

test("day-report gate fires on the last live cycle, before the 1:00 PM PT close", () => {
  // The trigger must land strictly before the market close, or no running cycle
  // can satisfy it.
  assert.ok(
    EOD_FORCED_CLOSE_MINUTE < ONE_PM_PT_MINUTES,
    "day-report trigger must be before the 1:00 PM PT session close",
  );

  // At the EOD forced-close minute (12:55 PM PT) the gate is open...
  assert.ok(getPstTimeInMinutes(atPdt("12:55")) >= EOD_FORCED_CLOSE_MINUTE);
  // ...and it stays open through the final pre-close cycles.
  assert.ok(getPstTimeInMinutes(atPdt("12:59")) >= EOD_FORCED_CLOSE_MINUTE);
});

test("day-report gate is closed before the EOD forced-close window", () => {
  // A mid-morning / early-afternoon cycle must not record the end-of-day report.
  assert.ok(getPstTimeInMinutes(atPdt("06:30")) < EOD_FORCED_CLOSE_MINUTE);
  assert.ok(getPstTimeInMinutes(atPdt("12:30")) < EOD_FORCED_CLOSE_MINUTE);
  assert.ok(getPstTimeInMinutes(atPdt("12:54")) < EOD_FORCED_CLOSE_MINUTE);
});
