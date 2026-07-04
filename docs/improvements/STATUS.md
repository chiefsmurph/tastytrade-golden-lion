# Improvements — consolidated status

**This is the live tracker.** `IMPROVEMENTS.v1`–`v4` are the point-in-time discovery logs (how each item was found); their inline checkboxes are NOT kept current. Read this file for what's done and what's left. Last reconciled 2026-07-03 against committed code.

Three buckets, as requested: **DONE** (shipped this session, under the `monday-2026-07-06` tag) · **BEFORE MONDAY–ELIGIBLE** (safe to land in Monday's deploy — pure cleanup, docs, tests, diagnostics) · **AFTER MONDAY** (needs Monday's data, or behavior-changing enough that it should follow verification).

Reality check: of ~45 distinct items catalogued across v1–v4, roughly **18 are done** — almost all bugs/safety/plumbing. The **strategy/profitability work is largely untouched** and lives in the AFTER-MONDAY bucket by design (most needs live data to tune).

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
- **More money-math tests** — `signal-interpreter` weights, `overnight-reduction` age-floor, `normalizeGroupExecutionTargetExposures`. (v4 #94)
- **`blendBySchedule` pre-sort** — sorts a constant array 5×/cycle; micro-perf. (v2)
- **Structured logging (`pino`) + per-cycle `runId`** — infra, low risk but a big diff; do anytime, low priority. (v1, v4 #81)

---

## 🔴 AFTER MONDAY (needs data, or behavior-changing → follow verification)

### Blocked on Monday's data (don't guess — tune from distributions)
- **Unsignalled base tier vs no-trade** — the "target exposure is zero" #1-skip decision; verify it collapses now that the crash loop is fixed before building anything. (v3, v4 #1)
- **Seed IV-fallback bars (50/70)** — MARA read 35; may be unreachable. (v4 #3 followup)
- **Liquidity gating steps 2–3** — OI floor + phantom-quote guard, then liquidity score + size-aware chasing; thresholds from step-1 logs. (v4 #4)
- **Dip-boost ≥4 vs ≥7 boolean bar.** (open tuning Q)

### Behavior-changing strategy work (build any time, deploy after Monday clears)
- **Stop-loss grace period + mid-based catastrophic floor, and move the stop above the 10-min cooldown** — the LCID-churn fix; the one item robust to whatever Monday shows (best "build now" candidate). (v1, v3, v4 #5 + #39)
- **Re-entry cooldown after a close** — `isClosedToday` exists, zero consumers. (v2 #1, v3, v4 #6)
- **Secret-signal staleness gate** — `secondsSinceLastPositionsUpdate` tracked, gates nothing; stale `willBuy` still scores. (v2, v4 staleness)
- **Take-profit scale-out** — partial-close plumbing exists; sell half at target, trail the rest. (v3, v4 #8)
- **Conviction-sized seeds** — qty fixed at 1; size to a $ target, apply boolean surplus to the seed cap. (v3, v4 #7)
- **Account-level daily-loss circuit breaker** — flip to close-only when NLV drops X% from day start. (v3, v4 #10)
- **Margin-from-cash seed: add the held-contract fallback** (asymmetry with the cash path). (v4 #11)
- **Health gate: require only bracketing checkpoints**, not every DTE ≤ target (weekly liquidity for monthly buys). (v3, v4 #89)
- **Gate exposure *scaling* is cancelled by normalization** — only the ceiling clamp works today; fix needs cap-aware normalization (real bug, but behavior-changing). (v4 #31)
- **Buy results overstate fills / understate spend** — `placedOrder:true` unconditional, value from starting price not final chase; corrupts budget + run history. (v3, v4 #37)
- **Dynamic profit targets scaled by IV rank** — now unblocked (IV flows); behavior. (v1)
- **Front-loaded exposure ramp** — richer morning premium; interacts with the route change, want data. (v1, v4 #83)
- **Bid-lean adds on profitable positions** — only shifts weights when losing today. (v2, v4 #84)
- **Seed-time "no accumulation" gate is dead code** — replace dummy-metrics strategy check with a real minute-of-day cutoff. (v3, v4 #90)
- **Per-cycle memoization** — each cycle does the expensive plan/eval work 2–3×; perf, touches execution path. (v3, v4 #88)
- **`_PCT` env-var unit standardization** — three unit conventions through look-alike readers; a rename, risky right before a deploy. (v3, v4 #92)
- **Unify the two exposure normalizers** — same algorithm, different iteration order → plan vs execution can diverge. (v3, v4 #91)
