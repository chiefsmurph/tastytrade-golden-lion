# Stuff to do before Monday 2026-07-06

Work queue for the weekend (written Friday 2026-07-03, market closed). These are correctness/safety fixes from [IMPROVEMENTS.v4](../improvements/IMPROVEMENTS.v4.md) that ride with Monday's deploy alongside the IV-gate go-live. Companion runbook: [2026-07-06-monday.md](2026-07-06-monday.md) — when an item below lands, check whether it belongs in the runbook's section 2 (behavior changes) or section 3 (verification signatures).

Attribution note for Monday's analysis: most of these are pure safety/diagnostics, but the **margin DTE cap fix changes live behavior** (margin starts buying ≤7-DTE contracts as designed, instead of 15–30) — it and the IV gate are the two behavior changes to keep in mind when reading Monday's fills.

## The list

- [x] **Margin DTE cap fix** *(done 07-03: `accountType` threaded through `GroupExecutionTargetInputs` → `getPositionGroupExecutionTargets`; regression tests in `position-group-targets.test.ts`)* — the one-liner at `evaluate-trading-strategy.ts:370` that's been open since v2: `getPositionGroupExecutionTargets` drops `accountType`, so per-group DTE takes the cash branch and margin pays a month of theta on a same-day strategy. Thread `accountType` through `GroupExecutionTargetInputs` → `getPositionGroupExecutionTargets` → `getTimeOfDayExecutionTargets`, plus a test. Highest value-per-line in the repo. (v4 strategy #2)

- [x] **Dry-run cash-cap bug** *(done 07-03: planning loop passes `accountMarginOrCash`)* — one line: the planning loop in `run-cycle-context.ts:591-597` passes only `{ dryRun: true }`, so `manageAllocationForGroup` defaults to the cash 5% per-action cap for margin plans (real execution is correct). Pass `accountMarginOrCash` so margin plans stop lying in run history. (v4 new-findings #1)

- [x] **Close-side cancel race** *(done 07-03: `cancelOrderById` returns confirmation, chase breaks on failure leaving the existing order working; regression test "no double-sell" in `close-position.test.ts`)* — `cancelOrderById` in `close-position.ts` swallowed cancel failures and the chase loop placed the next sell regardless; a failed cancel + new order can double-sell. Mirrored the buy-side fix. Was the last unguarded double-order path. (v4 code item)

- [x] **`waitForOrderFill` honesty** *(done 07-03: both duplicated copies replaced by shared `waitForOrderFillById` in `order-utils.ts` — polls `getOrder(id)` not the full list, 404/vanished = NOT filled, terminal statuses = false, transient errors keep polling, 2s interval; 7 unit tests)* — both copies polled the full order list every second and treated a vanished order as *filled*. (v4 code item)

- [x] **Startup config log + obsolete-env-name warnings** *(done 07-03: `src/startup-config.ts`, wired into `index.ts`, tests in `startup-config.test.ts`; smoke-run caught the two dead vars in the local `.env`)* — log the resolved config once at boot; warn loudly on recognized-but-obsolete names (`BASE_URL`, `API_*`, `BOT_MAX_OPTION_SPREAD_PCT`, `TASTYTRADE_*`, pre-refactor `BOT_*` strategy names…). **Do this one first — it protects the deploy itself**: if the server `.env` has any stale names Monday morning, the bot says so at boot instead of silently reverting to defaults. (v4 config-drift item)

- **Smaller items**
  - [x] TZ warning at boot *(done 07-03: `getTimezoneWarning`; loud `[config] TIMEZONE` line if not Pacific. Chose warn over hard-refuse so a false positive can't brick the bot — a hard refuse can be layered on later.)*
  - [x] `getScaledThresholds` inversion clamp *(done 07-03: min clamped to `maxDownPct - 0.01`; regression test in `risk-limits.test.ts`)*
  - [x] Dead-code cleanup *(done 07-03: removed unused `closeEvaluations`, fixed the "N/5"→"N/10" log, corrected the window comment in `position-gate.ts`, added the `weightedAverageFill`-fallback warn in `evaluate-position.ts`)*
  - [x] Money-math tests *(done 07-03: `allocate-contracts.test.ts` covers the remainder loop; `position-gate-tiers.test.ts` covers all six tier selections + the boolean boost)* — still untested: `signal-interpreter` weight math, `overnight-reduction` age-floor math, `normalizeGroupExecutionTargetExposures` (lower value, left for later).
  - [x] `getMidpointPrice` dedup *(done 07-03: moved to `order-utils.ts`, imported by both action files)* — remaining dedup (`readEnvPct`/`toBooleanFlag` ×2, the two exposure normalizers) still open; lower value, left for later.

- [x] **Route-chase semantics redesign (v4 strategy #9)** *(done 07-03: `getRouteChasePlan` + tests)* — bid rests / mid concedes ≤3 ticks / ask starts at mid and fast-chases. **Included in Monday's deploy** (decision 07-03): the old bid-chases-ask behavior is a mislabeled bug, not a design under test; with only one day of data there's no clean signal to protect; and the three Monday behavior changes aren't confounded because every route/gate/DTE decision is logged per-order. Expect visibly slower morning accumulation (morning route weights are bid-heavy at 0.70, and "bid rests" now means it waits instead of chasing up) — correct behavior, but a real character change to watch alongside the morning IV gate.

## Explicitly NOT before Monday

Behavior-changing strategy work that genuinely needs Monday's data first (Tuesday+ deploys): stop-loss-above-cooldown + grace period, re-entry cooldown, secret staleness gate, take-profit scale-out, conviction-sized seeds, liquidity steps 2–3, and the Quote-event capture in the streamer sampler. The `monday-2026-07-06` tag still marks the deploy point — everything above the tag is this strategy work.
