# Stuff to do before Monday 2026-07-06

Work queue for the weekend (written Friday 2026-07-03, market closed). These are correctness/safety fixes from [IMPROVEMENTS.v4](../improvements/IMPROVEMENTS.v4.md) that ride with Monday's deploy alongside the IV-gate go-live. Companion runbook: [2026-07-06-monday.md](2026-07-06-monday.md) — when an item below lands, check whether it belongs in the runbook's section 2 (behavior changes) or section 3 (verification signatures).

Attribution note for Monday's analysis: most of these are pure safety/diagnostics, but the **margin DTE cap fix changes live behavior** (margin starts buying ≤7-DTE contracts as designed, instead of 15–30) — it and the IV gate are the two behavior changes to keep in mind when reading Monday's fills.

## The list

- [x] **Margin DTE cap fix** *(done 07-03: `accountType` threaded through `GroupExecutionTargetInputs` → `getPositionGroupExecutionTargets`; regression tests in `position-group-targets.test.ts`)* — the one-liner at `evaluate-trading-strategy.ts:370` that's been open since v2: `getPositionGroupExecutionTargets` drops `accountType`, so per-group DTE takes the cash branch and margin pays a month of theta on a same-day strategy. Thread `accountType` through `GroupExecutionTargetInputs` → `getPositionGroupExecutionTargets` → `getTimeOfDayExecutionTargets`, plus a test. Highest value-per-line in the repo. (v4 strategy #2)

- [x] **Dry-run cash-cap bug** *(done 07-03: planning loop passes `accountMarginOrCash`)* — one line: the planning loop in `run-cycle-context.ts:591-597` passes only `{ dryRun: true }`, so `manageAllocationForGroup` defaults to the cash 5% per-action cap for margin plans (real execution is correct). Pass `accountMarginOrCash` so margin plans stop lying in run history. (v4 new-findings #1)

- [ ] **Close-side cancel race** — `cancelOrderById` in `close-position.ts` swallows cancel failures and the chase loop places the next sell regardless; a failed cancel + new order can double-sell. Mirror the buy-side fix (`manage-allocation.ts:331-337`): return success, break the chase on failure. Last unguarded double-order path. (v4 code item)

- [ ] **`waitForOrderFill` honesty** — both copies poll the full order list every second and treat a vanished order (cancelled/expired/rejected) as *filled*. Use `getOrder(id)`, treat not-found as not-filled, lengthen the poll interval. (v4 code item)

- [x] **Startup config log + obsolete-env-name warnings** *(done 07-03: `src/startup-config.ts`, wired into `index.ts`, tests in `startup-config.test.ts`; smoke-run caught the two dead vars in the local `.env`)* — log the resolved config once at boot; warn loudly on recognized-but-obsolete names (`BASE_URL`, `API_*`, `BOT_MAX_OPTION_SPREAD_PCT`, `TASTYTRADE_*`, pre-refactor `BOT_*` strategy names…). **Do this one first — it protects the deploy itself**: if the server `.env` has any stale names Monday morning, the bot says so at boot instead of silently reverting to defaults. (v4 config-drift item)

- [ ] **Smaller items**
  - [ ] TZ assertion at boot — refuse to trade unless `America/Los_Angeles`; every schedule assumes it and nothing checks.
  - [ ] `getScaledThresholds` inversion clamp — stacked conservative multipliers (up to ~3.4×) can push `minDownPct` above `maxDownPct`, silently emptying the seed window; clamp or log explicitly + test.
  - [ ] Dead-code cleanup — unused `closeEvaluations` (`execute-position-evaluations.ts:210`), the "booleans N/**5**" log for a 0–10 score (`secret-auto-seed.ts`), the 9:30-vs-6:30 window comment in `position-gate.ts`, warn when `weightedAverageFill` falls back to current bid (`evaluate-position.ts:113-116` — silently pins return at 0% and disables that group's circuit breakers).
  - [ ] Money-math tests — `allocateContractsByWeight` remainder loop, `computePositionGate` tier selection + boolean boost, `signal-interpreter` weight math, `overnight-reduction` age-floor math, `normalizeGroupExecutionTargetExposures`.
  - [ ] Duplicate-helper extraction — `getMidpointPrice` ×2, `readEnvPct`/`toBooleanFlag` ×2, the two exposure normalizers (which also iterate in different sort orders — plan vs execution remainder-groups differ).

## Explicitly NOT before Monday

Behavior-changing strategy work waits for Monday's data/verification (Tuesday+ deploys): stop-loss-above-cooldown + grace period, re-entry cooldown, secret staleness gate, take-profit scale-out, conviction-sized seeds, liquidity steps 2–3, and the Quote-event capture in the streamer sampler.
