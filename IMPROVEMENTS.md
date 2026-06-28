# Improvements Tracker

## Code Quality

- [x] **Bug: Race condition in tick-up chasing** — `cancelOrderById` return value was ignored; if cancel failed both old and new orders were live simultaneously. Fixed in `manage-allocation.ts`.
- [x] **Bug: Debug log spamming every run cycle** — `console.log({ currentPositions })` removed from `get-position-evaluations.ts`.
- [x] **Bug: `any` type + status-check inconsistency** — `lastOrderResponse` typed properly; null status check aligned with `close-position.ts` pattern in `manage-allocation.ts`.
- [ ] **Structured logging** — Replace 103 `console.log` calls with a leveled logger (e.g. `pino`) using `info/warn/error/debug`. Add a `runId` per cycle for traceability.
- [x] **Break up `run-cycle.ts`** — Split into `run-cycle-context.ts` (build), `run-cycle-logging.ts` (log), `run-cycle-seed.ts` (seed). `run-cycle.ts` reduced from 1,116 to 214 lines.

## Strategy

- [x] **IV-based entry gate** — Gate entries on underlying IV Rank (from `marketMetricsService`). Skip if `ivRank < BOT_MIN_IV_RANK_PCT` (default 20). Degrades gracefully if metrics unavailable. Per-expiration IVX from Greeks events used as tiebreaker when two expirations are within 3 DTE of each other.
- [x] **OTM delta-targeted strike selection for margin accounts** — Margin account buys OTM calls (intraday gamma play, always closes EOD). Cash account keeps ITM calls (overnight delta hold). Strike chosen by closest delta to `BOT_MARGIN_TARGET_CALL_DELTA` (default 0.35) using live Greeks from the quote streamer. Falls back to first OTM strike by price if no delta data yet.
- [ ] **Dynamic profit targets based on IV rank** — Current targets (40% at open → 7% by 12:55 PM) are hardcoded. Scale proportionally to IV rank so you capture faster decay on high-IV days and don't hold losers waiting for unachievable targets on low-IV days.
- [ ] **Time-based stop instead of hard 30% loss stop** — If a position is down >20% but still has >2 hours before the close cutoff, hold rather than crystallizing the loss. Short-dated options often recover. Only hard-stop at 30% within the last 90 minutes.
- [ ] **Cap tick-chasing at 3–4 ticks above mid** — Current max is 10 ticks toward ask. Beyond 3–4 ticks above mid the edge on the trade is likely gone; better to skip than overpay.
- [ ] **Front-load exposure ramp** — Options premium is richest in the first 30–60 minutes due to overnight gap risk. Consider 60–70% exposure at open and a 70–80% max by 11:30 AM instead of ramping to 100%, to capture richer premium and reduce end-of-day pin risk.
