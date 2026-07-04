# Improvements — consolidated status

**This is the live tracker.** `IMPROVEMENTS.v1`–`v6` are the point-in-time discovery logs (how each item was found); their inline checkboxes are NOT kept current. Read this file for what's done and what's left. Last reconciled 2026-07-04 against committed code (v5 items folded in same day; v6 folded in 2026-07-04).

Three buckets, as requested: **DONE** (shipped this session, under the `monday-2026-07-06` tag) · **BEFORE MONDAY–ELIGIBLE** (safe to land in Monday's deploy — pure cleanup, docs, tests, diagnostics) · **AFTER MONDAY** (needs Monday's data, or behavior-changing enough that it should follow verification).

*(fable)* = use Fable 5 for implementation — safety-critical logic, multi-site correctness bugs where a subtle mistake silently gives wrong answers, or new architectural mechanisms with non-obvious invariants. Everything else is fine on Sonnet/Opus.

Reality check: of ~45 distinct items catalogued across v1–v4, roughly **18 are done** — almost all bugs/safety/plumbing. The **strategy/profitability work is largely untouched** and lives in the AFTER-MONDAY bucket by design (most needs live data to tune). v5 (2026-07-03 second pass) added **20 new items** — 10 code, 10 profitability. v6 (copilot pass, same day) added **20 more** — 8 code/ops, 9 strategy, 3 infra — none overlapping v1–v5; all folded into the buckets below.

---

## ✅ DONE (committed, in Monday's tag)

Shipped this session:
- **IV-rank gate resurrected** — `symbols` param was serialized as `symbols[]=X` → bare 400 → null since v1; fixed + 0–1→0–100 scale normalization + live-pinned test. (v4 #3)
- **Margin DTE cap enforced** — `accountType` threaded through group targets; margin no longer buys 15–30 DTE. (v2 #4, v3, v4 #2)
- **Dry-run plans use real per-action caps** — planning loop passed cash cap for margin. (v4 #1-bugs)
- **Close-side cancel race fixed** — confirmed-cancel-or-break; no double-sell. (v3, v4 #33)
- **`waitForOrderFillById`** — single-order poll, 404/vanished ≠ filled; both duplicated copies replaced. (v3, v4 #35)
- **Route-chase redesign** — bid rests / mid ≤3 ticks / ask starts at mid + fast-chase; no more bid-chases-ask. (v1, v3, v4 #9)
- **Open interest split from volume** + **bid/ask sizes captured** + per-candidate & considered-set liquidity logging (step 1). (v4 #4)
- **Startup config log + obsolete-env-name warnings.** (v4 #51 — partial; see below)
- **Timezone boot warning** if not Pacific. (v3, v4 #93)
- **`getScaledThresholds` inversion clamp** — seed window can't silently empty. (v4 #43)
- **Dead code**: unused `closeEvaluations` removed, `N/5`→`N/10` log, `weightedAverageFill`-fallback warn, stale window comment. (v4 #47)
- **`getMidpointPrice` deduped** into order-utils. (v2, v4 #91 — partial)
- **Money-math tests**: `allocateContractsByWeight`, `computePositionGate` tiers. (v3, v4 #94 — partial)

Shipped in the 2026-07-02 session (already `[x]` in v3):
- Buy-side morning spread ramp · EOD/take-profit closes bypass spread gate · position-registry self-heal (`syncPositionOpens`) · held-contract fallback (both paths) · secret cache persist+rehydrate · quote-streamer crash-loop backoff · honest BP skip messages · basic stock-yes tier + boolean boost.

---

## 🟡 BEFORE MONDAY–ELIGIBLE (safe, not yet done)

Pure cleanup / docs / tests / diagnostics — no behavior change, so they can ride Monday's tag if we want. None are load-bearing.

- **Finish the config-drift docs** — CLAUDE.md/README still document pre-refactor `BOT_*` names and moved paths; update to `CORE_*`/`STRATEGY_*`. (v3, v4 #51 remainder)
- **Finish helper dedup** — `readEnvPct`/`toBooleanFlag` still ×2 (`position-gate` + `secret-auto-seed`). Pure refactor. (v2, v4 #91). *Note: unifying the two exposure normalizers is listed here too but is NOT purely safe — they iterate in different orders, so that one is AFTER.*
- ~~**More money-math tests**~~ ✅ — 29 tests added: `signal-interpreter` (buy-weight normalization, aggressiveness tiers, secret route-weight math), `overnight-reduction` (age-floor interpolation, window bracketing, protective-signal pause, floor convergence), `normalizeGroupExecutionTargetExposures` (proportional rescale, last-group remainder absorbs rounding drift, zero/no-target guards). (v4 #94)
- **`blendBySchedule` pre-sort** — sorts a constant array 5×/cycle; micro-perf. (v2)
- **Structured logging (`pino`) + per-cycle `runId`** — infra, low risk but a big diff; do anytime, low priority. (v1, v4 #81)

New in v5 (2026-07-03 second pass — see [IMPROVEMENTS.v5.md](IMPROVEMENTS.v5.md)):
- ~~**Delete the per-quote-event debug log**~~ ✅ — `market-data.ts:114` deleted. (v5 code #2)
- ~~**Remove the dead weighted close price**~~ ✅ — `getWeightedOrderPrice` removed; `buildClosingOrderPayload` no longer takes route weights. (v5 code #8)
- ~~**Error run-history entries for failed cycles**~~ ✅ — `appendRunHistoryError` added; cycle body wrapped in try/catch. (v5 code #9)
- ~~**`blendBySchedule` pre-sort**~~ ✅ — sort removed, invariant documented. (v2)
- ~~**Finish helper dedup**~~ ✅ — `src/core/env-utils.ts` created; `readEnvPct`/`toBooleanFlag` consolidated. (v2, v4 #91)
- ~~**DI + tests for `placeRouteOrders`**~~ ✅ — `PlaceRouteOrdersDependencies` added; `createOrder`/`cancelOrder`/`waitForFill` injectable; 6 tests covering zero-qty skip, bid rest, ask fill, chase, cancel-fail safety, multi-order. (v5 code #4)
- **Realized-P&L attribution ledger** *(fable)* — persist per-round-trip P&L tagged by decision type/route/hour/DTE/gate score; landing it before Monday means Monday's session is captured. Bigger diff, zero trading behavior change. (v5 strategy #9)

New in v6 (2026-07-03 copilot pass — see [IMPROVEMENTS.v6-copilot.md](IMPROVEMENTS.v6-copilot.md)):
- ~~**SIGTERM / graceful shutdown handler**~~ ✅ — `src/index.ts` registers SIGTERM/SIGINT; stops scheduler, waits up to 30s for in-flight, cancels all live orders. (v6 code #3)
- ~~**Thread `orderSource` + capture buy-side order ID**~~ ✅ — `RunAllocationOrder` added to run history (symbol, route, orderId, limitPrice, quantity, placedOrder per route); all allocation routes now appear in NDJSON for cross-referencing broker history. (v6 code #6)
- ~~**Spread/stop coupling startup assertion**~~ ✅ — warns at boot if `STRATEGY_MAX_OPTION_SPREAD_PCT >= STRATEGY_INTRADAY_STOP_LOSS_PCT`; `intradayStopLossFloor` added to resolved config log; both getters exported and bid-vs-mid basis documented in comments. (v6 code #7)
- **Webhook notifications for critical events** — stop-loss fires, EOD liquidations, feed silence, cycle exceptions, NLV drops all go unnotified; `notifyEvent` helper POSTs to `CORE_WEBHOOK_URL` if set, no-ops otherwise. Opt-in, additive. (v6 ops #10)
- ~~**Document bid-vs-mid basis in stop/target comments**~~ ✅ — comment added to `getIntradayStopLossFloor`/`getEodStopLossFloor` noting both compare against `currentBidPrice`. (v6 strategy #17)
- ~~**Document aggressiveness thresholds in `signal-interpreter.ts`**~~ ✅ — comment added to `computeAggressivenessBoost` flagging −100/−200/−2%/−5%/>80 as unvalidated defaults. (v6 strategy #19)
- ~~**Log underlying price in run history**~~ ✅ — `underlyingPriceAtCycleTime: number | null` added to `RunGroupReturn`; all unique symbols fetched in parallel via `getUnderlyingPrice` just before `computeGroupReturns` in `run-cycle-context.ts`. (v6 strategy #20)

---

## 🔴 AFTER MONDAY (needs data, or behavior-changing → follow verification)

### Blocked on Monday's data (don't guess — tune from distributions)
- **Unsignalled base tier vs no-trade** — the "target exposure is zero" #1-skip decision; verify it collapses now that the crash loop is fixed before building anything. (v3, v4 #1)
- **Seed IV-fallback bars (50/70)** — MARA read 35; may be unreachable. (v4 #3 followup)
- **Liquidity gating steps 2–3** — OI floor + phantom-quote guard, then liquidity score + size-aware chasing; thresholds from step-1 logs. (v4 #4)
- **Dip-boost ≥4 vs ≥7 boolean bar.** (open tuning Q)

### Behavior-changing strategy work (build any time, deploy after Monday clears)
- **Stop-loss grace period + mid-based catastrophic floor, and move the stop above the 10-min cooldown** *(fable)* — the LCID-churn fix; the one item robust to whatever Monday shows (best "build now" candidate). (v1, v3, v4 #5 + #39)
- **Re-entry cooldown after a close** — `isClosedToday` exists, zero consumers. (v2 #1, v3, v4 #6)
- **Secret-signal staleness gate** — `secondsSinceLastPositionsUpdate` tracked, gates nothing; stale `willBuy` still scores. (v2, v4 staleness)
- **Take-profit scale-out** — partial-close plumbing exists; sell half at target, trail the rest. (v3, v4 #8)
- **Conviction-sized seeds** — qty fixed at 1; size to a $ target, apply boolean surplus to the seed cap. (v3, v4 #7)
- **Account-level daily-loss circuit breaker** *(fable)* — flip to close-only when NLV drops X% from day start. (v3, v4 #10)
- **Margin-from-cash seed: add the held-contract fallback** (asymmetry with the cash path). (v4 #11)
- **Health gate: require only bracketing checkpoints**, not every DTE ≤ target (weekly liquidity for monthly buys). (v3, v4 #89)
- **Gate exposure *scaling* is cancelled by normalization** *(fable)* — only the ceiling clamp works today; fix needs cap-aware normalization (real bug, but behavior-changing). (v4 #31)
- **Buy results overstate fills / understate spend** — `placedOrder:true` unconditional, value from starting price not final chase; corrupts budget + run history. (v3, v4 #37)
- **Dynamic profit targets scaled by IV rank** — now unblocked (IV flows); behavior. (v1)
- **Front-loaded exposure ramp** — richer morning premium; interacts with the route change, want data. (v1, v4 #83)
- **Bid-lean adds on profitable positions** — only shifts weights when losing today. (v2, v4 #84)
- **Seed-time "no accumulation" gate is dead code** — replace dummy-metrics strategy check with a real minute-of-day cutoff. (v3, v4 #90)
- **Per-cycle memoization** — each cycle does the expensive plan/eval work 2–3×; perf, touches execution path. (v3, v4 #88)
- **`_PCT` env-var unit standardization** — three unit conventions through look-alike readers; a rename, risky right before a deploy. (v3, v4 #92)
- **Unify the two exposure normalizers** *(fable)* — same algorithm, different iteration order → plan vs execution can diverge. (v3, v4 #91)

### New in v5 (2026-07-03 second pass — see [IMPROVEMENTS.v5.md](IMPROVEMENTS.v5.md))

Bugs/correctness:
- **One-sided quote guard** — `getBidAskForSymbol` resolves on the first event with a bid *or* ask; bid-only events yield fake 0% spreads that pass the spread gate. (v5 code #1)
- **Record registry closes/opens on confirmed fill, not placement** *(fable)* — phantom `closedAt`/`openedAt` from resting limits; matters more once the re-entry cooldown ships. (v5 code #3)
- **Side-aware keying** *(fable)* — cross-account map, gate lookup, DO_NOT_TOUCH annotation, overnight override, and registry keys all drop `::side`; put/call groups on one underlying collide. (v5 code #5)
- **Consolidate the two `getPositionAgeDays`** — same name, calendar-day vs fractional-elapsed semantics feeding different multipliers. (v5 code #6)
- **Single cancel sweep per cycle** — the second `cancelAllLiveOrders` inside `executePositionEvaluations` is redundant in the cycle path. (v5 code #7; subsumed by resting-orders work below)
- **Single streamer session per chain snapshot** — merge the serial 5s+7s samples into one union subscription; halves per-symbol streamer time. (v5 code #10)

Strategy/profitability:
- **Persistent resting orders (diff-based order management)** *(fable)* — bid route's "patient" order lives ≤1 run interval because every cycle opens cancel-all; keep unchanged working orders for real queue priority. (v5 strategy #1)
- **Fee-aware targets + min-premium floor** — no commission/fee model anywhere; on sub-$1 contracts friction is ~half the late-day 7% target. (v5 strategy #2)
- **Cost-basis exposure accounting** *(fable)* — market-value exposure means decay reopens headroom and the bot refills burnt premium all day; the mechanism the daily-loss breaker doesn't catch. (v5 strategy #3)
- **Conviction-first allocation order** — plan and allocator currently give capital to the deepest loser first; rank by gate/conviction instead. (v5 strategy #4)
- **Per-expiration circuit breakers** — group-blended metrics let a long-dated leg mask a collapsing short-dated one; trigger stops/targets per expiration. (v5 strategy #5)
- **Underlying stabilization gate for averaging down** — no code looks at the underlying's tape before adds/seeds; log-only first. (v5 strategy #6)
- **Invert the IVX tiebreak** — selection prefers the *richest* vol on near-tie DTE; a premium buyer overpaying by design. (v5 strategy #7)
- ~~**Urgency-tiered close chase**~~ ✅ — EOD arms at 12:50, hard-risk closes tick every 10s and cross to bid on final move; spread bypass follows arm time. (v5 strategy #8)
- ~~**Re-evaluate strategy before executing close**~~ ✅ — fresh `evaluateTradingStrategy` call before each sell; recovered stops skip with log; EOD bypass at 12:55; 2 regression tests added (90/90). (v6 code #4)
- **Time-scaled margin delta target** — flat 0.35 delta while DTE ramps to ≤7 and the forced close approaches; ramp toward 0.50–0.55 late morning. (v5 strategy #10)

### New in v7 (2026-07-04 brother's branch review — see [IMPROVEMENTS.v7-brother-sm.md](IMPROVEMENTS.v7-brother-sm.md))

Bugs/correctness:
- ~~**`inferIsRegularSession` ignores explicit `state` field**~~ ✅ — `state: "Open"/"Closed"` now short-circuits the 7.5h heuristic; 8 unit tests added. (v7 #1)
- **`UNDERLYING::side` groups average across expirations** — a profitable long-dated leg masks a stopping short-dated leg; log per-leg return breakdown and flag spread ≥ 20pp as a diagnostic precursor to v5 strategy #5. (v7 #2)
- ~~**`ecosystem.config.cjs` interpreter path pinned to deploy host**~~ ✅ — changed to `"node"`. (v7 #3)

Ops/observability:
- ~~**`core:cancelAllLiveOrders` not documented**~~ ✅ — added to README Core / Market Data Examples with emergency-cancel note. (v7 #4)
- **No `config:show` IPC command** — startup banner covers boot-time snapshot; no mid-session query for effective strategy/risk parameters. Add read-only `config:show` via existing env helpers. (v7 #5)
- **No named env-var profile sets** — 20+ env vars must be tuned individually; a conservative/balanced/aggressive `.env.profile.*` convention + docs lets posture flip atomically. (v7 #6)

Framing:
- **"Preview is a promise, not a contract" — document the divergence risk** — preview quotes at T₀, execution re-fetches at T₁; add timestamp + divergence note to preview output. Related to v4 #88 and #91. (v7 #7)
- **Monday verification hierarchy** — 4-check log-reading guide ordered by "if this fails, stop" priority; capture in `docs/plans/`. (v7 #8)

---

### New in v6 (2026-07-03 copilot pass — see [IMPROVEMENTS.v6-copilot.md](IMPROVEMENTS.v6-copilot.md))

Bugs/correctness:
- **Registry concurrent-write race** *(fable)* — `maybeAutoSeedFromSecretPositions` fires on Socket.IO events outside the cycle; its `recordPositionOpened` can interleave with `syncPositionOpens` read-modify-write and clobber entries. Serialize mutations through a module-level promise queue + atomic rename. (v6 code #1)
- **IPC command mutex** *(fable)* — concurrent IPC calls (`bot:purchaseSymbol`, `bot:runCycle`) bypass the scheduler's `inFlight` flag; two clients can double-place orders. Simple `executionLock` promise chain on money-touching handlers. (v6 code #2)
- **Put side is call-calibrated throughout** — delta targeting, ITM selection, stop/target all assume calls; a put group is silently managed with wrong parameters. Short-term: guard + skip puts with warning. (v6 code #8)
- **IPC socket has no access control** — any local process with socket access can place real orders; minimum fix is `chmod 600` after bind. (v6 ops #9)
- **Run history NDJSON grows without bound** — `getRecentRunHistory` reads the entire file every call; tail-read is the lowest-effort fix. (v6 code #5)
- **`getClosedPositionsToday` rescans 200 entries per IPC call** — add in-process cache keyed on date+account; subsumed if v5 P&L ledger lands. (v6 ops #11)

Strategy/profitability:
- **Overnight hold P&L attribution** — no `dayEndSnapshot`/`openSnapshot` data; impossible to verify the overnight-hold thesis. Additive NDJSON only. (v6 strategy #12)
- **Run-history feedback loop** — per-symbol win rate today, seed success rate, exposure utilization are all computable from existing `getRecentRunHistory`; none are read back by the engine today. (v6 strategy #13)
- **Minimum hold time for profitable winners** — take-profit fires immediately; a trending move gets sold 8 min in. Guard: don't close a winner opened <30 min ago unless return ≥ 2× target or EOD forces it. (v6 strategy #14)
- **Aggressiveness boost largest for lowest-conviction signals** — flat +100/+200 `buyWeight` addition has 100–200% effect on low-weight signals, ≤14% on high-weight; scale boost by remaining headroom instead. (v6 strategy #15)
- **Cross-account aggregate exposure untracked** *(fable)* — each account independently allocates up to `maxTargetPct` on the same symbol; add optional `STRATEGY_MAX_COMBINED_SYMBOL_EXPOSURE_PCT`. (v6 strategy #16)
- **Small-order execution weight mismatch** — floor+greedy can silently collapse a 3-contract order to bid/mid only; log actual executed weight split alongside configured weights. (v6 strategy #18)
