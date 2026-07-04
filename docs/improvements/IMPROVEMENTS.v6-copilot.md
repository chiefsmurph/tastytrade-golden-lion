# Improvements v6 — Copilot pass

> **Discovery log (2026-07-03).** Written after a full independent read of `src/` and all previous improvement docs + STATUS.md. Every item below was cross-checked against v1–v5 and STATUS.md before inclusion — nothing here duplicates an open, shipped, or deferred item. Where a finding is adjacent to an existing one, the relation is stated inline. No production pull was available for this pass, so nothing is marked **[prod]** — all findings are code-reading or structural.

Baseline at time of writing: `main` at `acccb95`, typecheck clean, 88/88 tests across 16 files, all v5 items folded into STATUS.md.

---

## Code quality / correctness

### 1. `writeRegistry` / `readRegistry` has a real concurrent-write race — the secret auto-seed path was missed when v3's race was struck

The v3 item "two seed paths race on `position-registry.json`" was struck as moot once it was confirmed that each account type takes exactly one seed path per cycle. But a second concurrent writer exists that was not considered: **`maybeAutoSeedFromSecretPositions`** (`secret-auto-seed.ts`) fires whenever the secret Socket.IO connection pushes a positions update — outside the main cycle, on an independent async event. It calls `seedSymbol` → `recordPositionOpened`, which is a read-modify-write on the registry file. The main cycle's `syncPositionOpens` runs at roughly the same wall-clock time (once per cycle during market hours, at the same general cadence as the socket feed). Because Node.js is single-threaded, the interleave is:

```
syncPositionOpens: readFile() [pending]
maybeAutoSeedFromSecretPositions: readFile() [pending]
  → both resolve with the same snapshot
syncPositionOpens: writeFile(snapshot + its changes)
maybeAutoSeedFromSecretPositions: writeFile(snapshot + its changes)
  → second write clobbers the first's additions
```

Fix: serialize all registry mutations through a single promise queue (one outstanding write at a time, next queued read starts after the write completes), and use atomic rename via temp file so a crash mid-write doesn't corrupt the file. The position-registry functions are small enough that wrapping them in a module-level `Mutex` (a simple chained-promise approach — no external deps needed) takes under 20 lines.

*Distinct from v3's struck race (which was within-cycle, same event loop turn). This race spans events; can fire in production daily.*

---

### 2. IPC concurrent commands can double-place money-touching orders

The scheduler's `inFlight` flag prevents concurrent scheduled cycles. IPC calls bypass it entirely. If a client calls `bot:purchaseSymbol RUM 500 call` twice in fast succession (or two separate clients do so simultaneously), both invocations execute in parallel — two buy orders land for the same symbol. There is no command queuing, no per-command mutex, no idempotency key, and no check against currently-in-flight IPC operations.

This also means a `bot:runCycle` IPC call and a scheduled cycle can overlap (the IPC call bypasses `inFlight`), interleaving two sets of allocation orders for the same account.

Fix: a simple module-level `executionLock` (`let activeCyclePromise: Promise<unknown> | null = null`) that all money-touching IPC handlers (`bot:runCycle`, `bot:seedSymbol`, `bot:purchaseSymbol`) acquire before executing and release on completion. Read-only handlers (`bot:getRunCyclePreview`, `bot:getLastRunCycle`, etc.) can stay unguarded.

*Not mentioned in any previous doc. Relates to security / operational safety, not just correctness.*

---

### 3. No SIGTERM / graceful shutdown — live orders orphaned on pm2 restart

The process receives `SIGTERM` (pm2 restart, deploy, OOM kill) with no handler. Node.js default: finish the current synchronous tick, then exit. Any in-flight `await` in the execution path (order submission, `waitForOrderFillById`, `cancelOrderById`) is abandoned. A working buy or sell order sits live with no tracking: the registy may have recorded a "placed" entry before the crash, but the NDJSON entry is never appended (`appendRunHistory` is after execution). The next boot's `cancelAllLiveOrders` may or may not sweep the orphaned order, depending on whether it filled in the interim.

The 07-02 logs show 38 process restarts. Each restart was a window for this.

Fix: register `process.on('SIGTERM', gracefulShutdown)` and `process.on('SIGINT', gracefulShutdown)`. The handler should: (1) call `stopMarketOpenScheduler()` to prevent new cycles, (2) wait for `inFlight` to clear with a 30s timeout, (3) call `cancelAllLiveOrders` on each managed account, (4) call `process.exit(0)`. Check `ecosystem.config.cjs` for `kill_timeout` and align it. This is additive — no trading behavior change.

---

### 4. Strategy evaluation is stale by the time close orders execute — winners can be missed, recovered positions still close

`buildRunCycleContext` runs `evaluateTradingStrategy` for each group at cycle-start time `T₀`, using bid prices from that moment. `executePositionEvaluations` then runs minutes later. The close path re-fetches a fresh bid/ask (`closePosition` builds a new midpoint from the current quote), but it does NOT re-check whether the strategy trigger (`CLOSE_POSITION`) is still valid at the new prices.

Consequences:
- A position that dipped to -30% at T₀ (stop triggered) but recovered to -22% by T₃ still gets closed — a false stop.
- A position that was fine at T₀ but slid to -30% by T₃ misses its stop until the next cycle — a 4-minute gap in stop protection.
- A position that hit the take-profit at T₀ but corrected to below the target by T₃ sells into a correction.

Fix: in `closePosition`, before placing the sell order, re-run `evaluateTradingStrategy` using the fresh `bidPrice` and `askPrice` fetched at execution time. If the re-evaluation flips to `MANAGE_ALLOCATION` (recovered from stop) or the stop is no longer triggered, skip the close and log the flip. Hard EOD liquidation (12:55 PM margin) should bypass this re-check — time-based liquidation should always fire.

*Not mentioned in any previous doc. Related but different from v4's "stop-loss subordinate to cooldown" bug (that's about ordering within the strategy function; this is about the time gap between evaluation and execution).*

---

### 5. Run history NDJSON files grow without bound — `getRecentRunHistory` becomes O(N) on every call

`appendRunHistory` adds one entry per cycle per account, forever. `getRecentRunHistory` reads the **entire** file (`fs.readFile`), splits on newlines, parses all entries, reverses, and slices to the requested limit. `getClosedPositionsToday` calls this with `limit=200`. As the file grows (estimated ~500KB/day/account at current throughput), this goes from fast today to sluggish within months.

No rotation, no TTL trim, no archiving strategy. The day report NDJSON files have the same pattern.

Fix options (pick one or combine):
- **Rotation**: on each call to `appendRunHistory`, if the file exceeds N MB (e.g., 50), archive the current file to a timestamped path and start a new one.
- **Tail-only reads**: instead of `readFile`, read the last N KB with a ranged read and parse from there — sufficient for `getRecentRunHistory(200)`. The file can be large; only the tail is needed.
- **Indexing**: maintain a sidecar index file (`runs.index.ndjson`) with `{timestamp, byteOffset}` per entry. `getRecentRunHistory` becomes a seek+read using the index.

The tail-read approach is the lowest-effort change and has zero effect on the write path.

*Not mentioned in any previous doc. Latent perf bug that gets worse every day.*

---

### 6. `placeRouteOrders` hardcodes `source: "tastytrade-golden-lion"` — scheduled cycles, IPC buys, and seeds are indistinguishable in broker history

`placeRouteOrders` (`manage-allocation.ts`) always submits orders with `source: "tastytrade-golden-lion"`. Seed paths use distinct `orderSource` strings (`MARGIN_SEED_FROM_CASH_ORDER_SOURCE`, `SECRET_AUTO_SEED_ORDER_SOURCE`), but those flow through `seedSymbol` → its own order payload, not through `placeRouteOrders`. Regular allocation buys (scheduled cycle or `bot:purchaseSymbol` IPC call) are identical in the broker's order history. There is no way to post-hoc identify which orders came from the scheduler vs. a manual IPC purchase, and no run-to-order cross-reference (the run history records estimated order values, not broker order IDs for the buy side — buy-side `placedOrder: true` is recorded without order ID, unlike closes which capture it).

Fix: thread `orderSource` (or a `cycleId`) through `manageAllocationForGroup` → `placeRouteOrders` and set it on the order payload. Also capture the returned order ID in `placeRouteOrders` and surface it in `AllocationRouteResult.orderId` alongside `orderResponse`, so run history can cross-reference to broker fills the way close orders already do.

*Related to v4's "buy results overstate fills" (also open) but a different field — that item is about price/quantity accuracy; this is about traceability.*

---

### 7. The spread gate threshold and stop-loss floor are structurally coupled but tuned independently — the invariant is unverified

A position bought at the ask with a spread of `S%` has an immediate bid return of approximately `−S%` (since bid = mid × (1 − S/2) ≈ ask × (1 − S)). The intraday stop fires at `−STRATEGY_INTRADAY_STOP_LOSS_PCT` (default 30%) measured at bid. Therefore, after entering at maximum allowed spread `S_max`:

```
stop headroom = stop_floor − entry_spread_cost = 30% − S_max%
```

With `S_max = 30%` (the full-day cap), a fresh position enters *at its own stop floor*. The buy-side morning spread ramp (v3 fix, shipped) applies a tighter entry cap before 8:00 AM (5%→30%), which creates some margin. But by 8:00 AM, the cap is 30% = the stop floor. On a 30%-spread option bought at 8:01 AM, the stop is immediately armed.

The correct invariant:

```
maxEntrySpreaderPct < stopLossFloor − expectedNormalBidMoveVsAsk
```

where `expectedNormalBidMoveVsAsk` is a rough estimate of how much the bid can move against the fill in normal market conditions (not a down move — just bid/ask dynamics). Currently this invariant is not stated, not tested, and not validated at startup. Add a startup assertion that verifies `STRATEGY_MAX_OPTION_SPREAD_PCT < STRATEGY_INTRADAY_STOP_LOSS_PCT` with a clear error message explaining the coupling, and surface the effective headroom in the config log.

*The v3 morning spread ramp addressed the early-morning case. This is the all-day structural coupling. Not mentioned in any previous doc.*

---

### 8. The put side is treated identically to calls — strategy parameters are call-calibrated throughout, with no guard

The bot tracks `UNDERLYING::put` groups, normalizes sides in position evaluation, and seeds puts via the auto-seed path if the secret feed signals a put side. But every strategy parameter — delta target (`BOT_MARGIN_TARGET_CALL_DELTA = 0.35`), ITM cash selection, overnight hold thesis, the take-profit curve, and the stop-loss floors — is calibrated for long calls. No put-specific parameters exist.

If a put position enters the portfolio (manually, or because `normalizeSideForSeed` returned `"put"` from the feed), `evaluateTradingStrategy` evaluates it using call-appropriate metrics without any put-side adjustment. The delta selection in `entry-filters.ts` (`getMarginTargetCallDelta`) applies to calls only; the cash ITM selection logic applies "ITM for overnight delta" — which means the *opposite* for puts (deep OTM puts are high-delta, not ITM calls). The result would be a put position managed as if it were a call: wrong expiration selection, wrong delta targeting, wrong stop/target calibration.

Fix short-term: add a guard in `manageAllocationForGroup` and `closePosition` that detects a put group being entered into a puts-unsupported account type and logs a prominent warning + skips allocation. Fix long-term: add put-specific parameters in `entry-filters.ts` and `risk-limits.ts`, controlled by separate env vars, before enabling puts as a first-class strategy.

*Not mentioned in any previous doc. Low frequency today (call-dominant) but a silent wrong-answer if puts appear.*

---

## Operational / infrastructure

### 9. IPC server has no access control — any local user with socket access can place orders

The Unix domain socket at `CORE_IPC_SOCKET` (defaulting to `.tastytrade-golden-lion.sock` in the process cwd) accepts any connection from any process with read/write access to the socket file. There is no authentication, no rate limiting, and no audit log on IPC commands. `bot:purchaseSymbol` and `bot:seedSymbol` will place real option orders for any caller.

On a single-user development machine this is low risk (file permissions = OS-level protection). On a shared server (VPS with multiple accounts), any user who can reach the file can trade.

Mitigations (in increasing strength):
1. **File permissions**: `chmod 600` the socket after binding. The IPC server currently creates the socket without explicit permission-setting; add `fs.chmodSync(socketPath, 0o600)` immediately after `server.listen(socketPath)`.
2. **Peer credential check**: on Linux, `SO_PEERCRED` lets the server verify the connecting process's UID via `socket.remoteAddress` → `getsockopt`. Only accept connections from the process owner.
3. **HMAC token**: require all commands to include a `token` field (derived from a shared secret in `.env`) and reject requests without a valid HMAC. Prevents escalation even if an attacker gets socket access.

Minimum-effort fix: item 1 + a startup log line noting the effective socket permissions.

*First time this is raised. OWASP A01 (Broken Access Control).*

---

### 10. No alert or push notification on critical trading events

The bot runs silently. When a stop-loss fires, the EOD liquidation closes a position, the secret feed is down >20 minutes, a cycle throws an unhandled exception, or `cancelAllLiveOrders` fails — none of these produce an external notification. The only visibility mechanism is polling the IPC server or grepping the pm2 log file.

For a production system managing real capital, the gap between "something went wrong" and "operator finds out" is measured in cycles (4 min intervals). On 07-02, the quote-streamer crash loop ran for a significant period before being discovered via manual review.

A webhook-based notification layer (e.g., POST to a Slack/Discord/ntfy URL stored in env) would close this gap. Target events:
- Stop-loss or EOD liquidation close executed
- Secret feed silent for >N minutes (already tracked via `secondsSinceLastPositionsUpdate`)
- Unhandled cycle exception (the error run-history entry proposed in v5 code #9 is the hook)
- `cancelAllLiveOrders` fails or returns >0 unconfirmed cancels
- Account NLV drops >X% intraday (setup for the daily-loss breaker, v4 strategy #10)

Implementation: a `notifyEvent(type, payload)` helper that POSTs to `CORE_WEBHOOK_URL` if set, silently no-ops if not. Zero trading behavior change; opt-in via env.

*Not mentioned in any previous doc. Operational safety.*

---

### 11. `getClosedPositionsToday` re-scans up to 200 run-history entries on every call — no caching

`getClosedPositionsToday` calls `getRecentRunHistory(200, accountNumber)` which reads the entire NDJSON file, then filters, groups, and aggregates. This is called on-demand (via IPC `bot:getClosedPositionsToday`) but also has the potential to be called inside a cycle context in the future. There is no caching, no incremental update, and no write-time bookkeeping.

As run history grows (see item #5), this scan gets proportionally slower. Additionally, the P&L computation inside the function (`realizedPnlDollars`, `realizedPnlPct`) requires joining close orders with group state from the same entry — correct, but not memoized.

This is the motivation behind v5 strategy #9 (realized P&L attribution ledger, BEFORE MONDAY eligible). If that lands, `getClosedPositionsToday` becomes a simple read of the ledger file. If it doesn't land yet, add an in-process cache (`Map<date_account, result>`) keyed on date+account that invalidates when a new run-history entry is appended, so repeated IPC calls within the same session don't re-scan.

*Adjacent to v5 strategy #9 but the caching concern is distinct (the ledger fixes the root cause; this is the interim mitigation).*

---

## Strategy / profitability

### 12. The overnight hold thesis is never measured — there is no attribution of overnight vs. intraday P&L

Cash account positions are held overnight for "delta hold." The hypothesis is that the overnight hold generates positive P&L from gap-up moves. There is no code that records what price each position was at market close (last run of the day) vs. market open (first run of the day), so there is no way to compute the P&L attributable to the overnight period vs. intraday trading.

`getClosedPositionsToday` computes realized P&L at close time, but the *source* of that P&L (gap-up from overnight vs. intraday continuation) is invisible. After weeks of running, there is zero data to verify that the overnight hold generates positive expectancy vs. simply closing at day-end.

Fix: record a `dayEndSnapshot` in the last cycle of each session (e.g., when `timeInMinutes >= accumulationCutoffMinute` and account type is `cash`) capturing `{symbol, bidPrice, askPrice, midPrice, weightedAverageFill, quantityWeight}` per group. Record an `openSnapshot` in the first cycle of the next session (e.g., when positions are present and the last dayEndSnapshot is from the prior calendar day). The gap-open P&L = `(openSnapshot.bidPrice - dayEndSnapshot.bidPrice) / dayEndSnapshot.weightedAverageFill`. Append both to a per-account overnight-attribution NDJSON. This produces the data needed to tune — or abandon — the overnight hold thesis based on evidence.

*Not mentioned in any previous doc. Foundational measurement gap for a central design decision.*

---

### 13. Run history data is never read back to adapt strategy — zero feedback loop

The bot generates hundreds of structured NDJSON entries per day capturing group returns, route weights, skip reasons, gate scores, boolean scores, seed decisions, and realized P&L. None of this data is ever read back by any part of the trading engine. Every cycle starts fresh, blind to what has happened before.

Simple in-session patterns that *could* be computed from recent history and used to gate or scale decisions:

- **Per-symbol win rate today**: if LCID has been stopped out twice today, lower the `goodBooleanScore` minimum before allowing a third entry on LCID (not a general boolean gate — a symbol-specific re-entry quality gate that escalates the bar after repeated losses).
- **Recent seed success rate**: if the last 5 seeds across both accounts resulted in 0 fills (all cancelled next cycle), the held-contract fallback or a pause-and-reassess mode makes more sense than continuing to seed.
- **Today's exposure utilization**: if the account has been unable to deploy more than 40% of target exposure for the last hour (all groups hitting "target exposure is zero" or health gate fails), log a diagnostic summary at each cycle so it's visible in a single glance rather than requiring grep.

None of these require persisted machine learning — they're simple running statistics over the last N run-history entries, computed at cycle start using the existing `getRecentRunHistory` function.

*Not mentioned in any previous doc. Closes the feedback loop that all tuning work assumes exists.*

---

### 14. No minimum hold time for profitable positions — fast take-profits sacrifice multi-bagger moves

The take-profit target fires and closes 100% of the group immediately when `currentBidReturn >= dynamicTakeProfitTarget`. A position that pops 40% in 8 minutes gets sold. The v4/STATUS scale-out item (AFTER MONDAY) proposes selling half and trailing the rest — but even that doesn't address the case where the position is moving rapidly: the scale-out at 40% still books half at 40% when it could have been 80%+ by noon.

A complementary rule: a **minimum hold time before ANY close of a profitable position** — e.g., don't close a winner that was opened fewer than 30 minutes ago unless it's above 2× the take-profit target or the EOD close is forced. The intuition: a position that hits 40% in 8 minutes is in a strong trending move; the right action is to trail it, not sell it. The current logic rewards speed equally regardless of whether the move is a spike or a sustained trend.

Implementation: track entry time via `lastActionTime` (already in `PositionMetrics`). In `evaluateTradingStrategy`, before returning the take-profit `CLOSE_POSITION`, check if `timeSinceOpen < MIN_PROFIT_HOLD_MINUTES` AND `currentReturn < HIGH_WATER_ACCELERATED_CLOSE` (e.g., 2× target). If both conditions hold, return `MANAGE_ALLOCATION` with reason "winner hold timer: move may continue." The EOD time-based close overrides this, so the hold timer can't trap a position past the cutoff.

*Related to v4 "take-profit scale-out" (AFTER MONDAY, on the structural side) but the minimum-hold-time mechanic is distinct and can be implemented independently.*

---

### 15. Aggressiveness boost from secret signals is proportionally *larger* for low-conviction signals than high-conviction ones

`computeAggressivenessBoost` adds +100 (level 1) or +200 (level 2) to `buyWeight` before normalizing via `normalizeBuyWeight(/ 400)`. The effect on the normalized weight:

| base buyWeight | +0 boost | +100 boost | +200 boost |
|---|---|---|---|
| 100 (low) | 0.25 | 0.50 (+100%) | 0.75 (+200%) |
| 300 (high) | 0.75 | 1.00 (+33%) | 1.00 (+33%) |
| 350 (very high) | 0.875 | 1.00 (+14%) | 1.00 (+14%) |

A low-conviction position (buyWeight=100) gets a 100–200% normalized-weight boost from level-2 aggressiveness signals. A high-conviction position (buyWeight=350) gets ≤14%. The boost is structurally most aggressive on the weakest base signals — the opposite of a conviction-scaling design.

Alternative: compute the boost as an additive fraction of the remaining headroom to max weight rather than a flat addition:

```ts
boost = level * 100 * (1 - normalizeBuyWeight(buyWeight));
// → scales down as baseWeight approaches the ceiling
```

Or cap the boosted weight at 2× the un-boosted normalized weight so the aggressiveness modifier amplifies relative conviction rather than flattening absolute conviction.

*Not mentioned in any previous doc. Subtle but systematic distortion in the signal-weighting.*

---

### 16. Cross-account aggregate position sizing is untracked — combined exposure can exceed any per-account limit

`computePositionGate` enforces a per-account `maxTargetPct` ceiling (e.g., 35% of that account's capital for a strong-yes signal). But the cash and margin accounts can simultaneously allocate up to their respective `maxTargetPct` to the same underlying symbol. If both accounts each allocate 35% of their capital to MARA, and the accounts are comparable in size, total MARA exposure across both is ~35% of *combined* capital. There is no cross-account aggregate exposure check.

The v2 "margin seeding ignores the margin account's own stress" item (partially addressed by the daily-loss breaker proposal) touches this space, but the aggregate-limit concern is distinct: it applies even when neither account is stressed, just both are near their individual ceilings on the same name.

Fix: in `buildRunCycleContext`, before computing per-group gate results, read the sibling account's evaluations (already fetched for the cross-account confirmation check) and compute each symbol's combined exposure fraction (this account + sibling) vs. combined capital. Surface it in the gate log. Add an optional env var `STRATEGY_MAX_COMBINED_SYMBOL_EXPOSURE_PCT` (e.g., 0.50) that caps the per-group `targetAccountExposure` when the combined fraction would exceed it.

*Not mentioned in any previous doc.*

---

### 17. The take-profit ramp and the stop-loss floors use different measurement bases — asymmetric by design but undocumented

`getDynamicTakeProfitTarget` returns a time-weighted blend from 40% → 7% measured against `weightedAverageFill` (the cost basis). The intraday stop (`getIntradayStopLossFloor`) is −30% measured at `currentBidPrice` vs `weightedAverageFill`. The EOD stop is −10%, also at bid.

The asymmetry: take-profit uses the mid return (roughly), but the stop uses the bid return. For a 20%-spread option:
- Mid return = (mid − fill) / fill
- Bid return = mid return − ~10% (half the spread)

This means the effective stop floor at mid is approximately −30% + 10% = −20%, not −30%. And the effective take-profit at mid is 40% → 7%, which matches the reporting. The system reports bid-based losses in run history but computes P&L targets on a bid basis — these are consistent. But the *stop* and the *target* are measured the same way (bid vs fill), so there's no real asymmetry in the measurement base.

However, the documentation everywhere in the codebase and comments says things like "40% take-profit" without specifying bid/mid/ask basis. An operator reading the config could interpret `STRATEGY_INTRADAY_STOP_LOSS_PCT=30` as "the position can lose 30% of premium mid-to-mid before stopping," but the actual behavior is "the position stops when the bid (which is below mid) drops 30% below fill." This is a documentation gap, not a bug, but it means anyone tuning the stop vs. target balance is reasoning from a misleading mental model.

Fix: add a comment to `getIntradayStopLossFloor` and its env var documentation explicitly stating "measured at the live bid price, not mid — the effective mid-based floor is approximately (stopPct − halfSpread)." Add the same clarification to the startup config log output.

*Not a bug, but a documentation gap that affects every future tuning decision for the stop and take-profit parameters.*

---

### 18. Bid/ask route weight blending ignores the dollar quantum of the order — a 1-contract order gets the same route split as a 10-contract order

`allocateContractsByWeight` divides capital proportionally across bid/mid/ask route weights and floors each to integer contracts. For a small order (e.g., 3 contracts total), the weight distribution is:

- bid 33% → 1 contract
- mid 33% → 1 contract
- ask 33% → 1 contract

For a larger order (e.g., 9 contracts total):
- bid 33% → 3 contracts
- mid 33% → 3 contracts
- ask 33% → 3 contracts

The route split is the same proportionally, which is the intent. But consider a 2-contract order with 40/40/20 bid/mid/ask weights:
- bid: 0.8 → floor → 0 contracts
- mid: 0.8 → floor → 0 contracts
- ask: 0.4 → floor → 0 contracts (greedy loop assigns 2 to the largest shortfall → bid gets 1, mid gets 1)

The greedy remainder loop assigns the 2 contracts to bid and mid by shortfall, which is correct. But now ask gets 0 contracts despite a 20% weight. The position was sized for 2 contracts with mid-leaning execution, but the smallest-quantity case can silently collapse all execution to whichever route has the largest-shortfall contract first. This creates a systematic execution bias at small position sizes that is invisible in the logs because the logged weights (0.40/0.40/0.20) don't reflect the actual execution split (0.50/0.50/0.00).

Fix: log the actual executed weight split (per-route contracts / total contracts) alongside the configured weights, so discrepancies are visible. Consider rounding weights at small quantities to the available contract slots rather than using the generic greedy algorithm (e.g., for total ≤ 3 contracts, explicitly assign 1 contract to the route with the highest weight above a threshold, rest to mid).

*Not mentioned in any previous doc. Affects every small allocation.*

---

### 19. The `computeAggressivenessBoost` thresholds for `daytradeScore` and `returnPerc` are undocumented assumptions — not tuned from data

`computeAggressivenessBoost` fires level-1 at `daytradeScore ≤ −100` and level-2 at `≤ −200`; level-1 at `returnPerc < −2%` and level-2 at `< −5%`. These numbers appear in the code without explanation or reference. There is no note on whether these were tuned from historical data, chosen as round numbers, or inherited from an earlier design. They have never been validated against actual trading outcomes (the run history would provide this data, but nothing reads it back — item #13 above).

The `superRecScore > 80` level-1 threshold similarly appears without rationale.

These are the only thresholds in the codebase with no basis documented. Every other threshold (take-profit curve, stop floors, boolean score tiers, IV gate levels, seed windows) has at least a comment explaining the intent. Add comments to `signal-interpreter.ts` explaining the intended semantics of each threshold, flag them as "unvalidated defaults — tune from run-history distributions," and add them to the list of parameters that the v5 strategy #9 ledger should produce distributions for.

*Not mentioned in any previous doc. Epistemic housekeeping.*

---

### 20. The underlying stabilization gate (v5 strategy #6, AFTER MONDAY) has an implementable precursor available now: log the underlying price at cycle time

v5 strategy #6 proposes gating averaging-down buys on the underlying's intraday tape (e.g., underlying above its N-minute low). The stated plan is log-only first, then enforce. But currently, the underlying price is not logged anywhere in the run-history entry. `RunHistoryEntry` has no `underlyingPrice` field; `RunGroupReturn` has no underlying price field. Every piece of context needed to compute "was this an averaging-down buy into free fall?" is absent from the post-hoc record.

Adding `underlyingPriceAtCycleTime: number | null` to `RunGroupReturn` is additive (no behavior change, no schema break — NDJSON is additive), costs one `getUnderlyingPrice(symbol)` call per group per cycle (the underlying price is already fetched in `option-service.ts` for candidate selection — it could be threaded through rather than fetched again), and produces the dataset needed to both tune the gate threshold AND validate it retrospectively.

This is a BEFORE MONDAY–eligible change: zero trading behavior change, additive to the run-history schema.

*Related to v5 strategy #6 but a distinct, immediately-actionable precursor. Not mentioned in previous docs.*

---

## Triage notes

**Before-Monday–eligible (no trading behavior change):**
- Code #3 (SIGTERM handler — additive, safety-critical before a live session with new route code)
- Code #6 (thread `orderSource` + capture buy-side order ID — additive, traceability)
- Code #7 (spread/stop coupling startup assertion + config log — additive, one line)
- Operational #10 (webhook notification — additive, opt-in)
- Strategy #17 (document bid-vs-mid basis in stop/target comments — docs only)
- Strategy #19 (document aggressiveness thresholds — docs only)
- Strategy #20 (log underlying price in run history — additive schema change)

**Worth a hard look before Monday even though it changes behavior:**
- Code #4 (re-evaluate strategy before close) — a cycle where a stop recovered mid-cycle is the exact scenario Monday's new route code creates (bid orders rest longer, positions can trade at prices between T₀ and T₃ without a close executing). Low implementation risk; meaningful for the first live session of the route redesign.

**After Monday (correctness bugs that need investigation/validation):**
- Code #1 (registry concurrent-write race — real but low-frequency)
- Code #2 (IPC command mutex — real but requires understanding which commands can safely parallelize)
- Code #5 (NDJSON rotation — urgent at scale, not urgent this week)
- Operational #11 (getClosedPositionsToday caching — straightforward, not urgent)

**After Monday (strategy/profitability — needs Monday's data first):**
- Strategy #12 (overnight P&L attribution — build anytime; data starts accumulating day 1)
- Strategy #13 (run-history feedback loop — design work; start with metrics from the existing history)
- Strategy #14 (minimum hold time for winners — behavior change; validate against run history)
- Strategy #15 (aggressiveness boost fix — behavior change; measure distribution from logs first)
- Strategy #16 (cross-account aggregate limits — additive gate; implement when combined-account scale matters)
- Strategy #18 (small-order execution weight logging — additive logging first, then decision)
