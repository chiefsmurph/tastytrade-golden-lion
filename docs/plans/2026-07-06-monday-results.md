# Monday 2026-07-06 — verification results

Companion to the runbook [2026-07-06-monday.md](2026-07-06-monday.md). Written after close (data pulled 13:13 PT, options just closed). This is the one-time go-live verdict; the recurring cadence now lives in [../OPERATIONS.md](../OPERATIONS.md).

**Deployed SHA:** `27037be` — *"feat: short-circuit closing-only underlyings with a TTL retry cache"*, committed **09:29 PT (mid-session)**. Server == local main. Caveat: pre-09:30 cycles ran the prior build; the closing-only short-circuit only applied after the ~09:33 boot.

**Pull:** `scripts/pull-today.sh 2026-07-06` + `data/ledger/` (not covered by the script — pulled by hand). 107 margin / 105 cash cycles. Error log **36K** (was 11MB on 07-02).

## Verdict

| Tier | | Summary |
|---|---|---|
| 1 — Deploy took | 🟢 GREEN | Config clean, IV gate live, recommended env set |
| 2 — Process stable | 🟡 YELLOW | 07-02 crash loop gone; **new dxLink session-limit restart loop** |
| 3 — Behavior live & safe | 🟢 GREEN | DTE cap, EOD-flat, re-eval guard, routes, liquidity logs all confirmed |
| 4 — Strategy sane | 🟢 GREEN | Zero-target collapsed, honest skips, fallbacks, ledger populated |

**Realized P&L: net negative — margin red, cash green** (margin ≈ −22% on the 15-lot WEN; cash +23% / +21% on the two ENVX exits). (Cash carries WEN + HTZ overnight, unrealized.) The tradeable day was essentially **WEN** in both accounts, plus exiting 07-02 cash holds.

## Checklist results (maps to runbook §3)

| # | Check | Result |
|---|---|---|
| 1 | Restart storm gone | ⚠️ 23 exits — but **new root cause** (see below), not the 07-02 loop; backoff working, prime window clean |
| 2 | Warm cache after restarts | ✅ 22 rehydrates (age 11–30s); cache stayed populated (34–38) through midday restarts |
| 3 | "Target exposure zero" collapses | ✅ margin **4/140 (~3%**, was 35%), cash **163/1575 (~10%**, was ~78%) |
| 4 | ivRank live | ✅ real values 42–83; **zero `market-metrics 400`**; 0 below-min skips is legit (all ≥42) |
| 5 | Dip boost active | ⚠️ enabled (0.25) but **never fired** — all `dipTargetBoostPct=0` (see WEN) |
| 6 | Honest skip messages | ✅ present (name "time-of-day exposure headroom") |
| 7 | Held-contract fallbacks | ✅ `manage-allocation-held-contract-fallback` ×12; seed-side ×0 (no seeds) |
| 8 | Error log small | ✅ 36K vs 11MB |
| 9 | Liquidity data flowing | ✅ 44 candidate lines, **real integer** bidSize/askSize (153, 740, 1318…) |
| 10 | Margin DTE ≤ 7 | ✅ `targetDTE` only ever **7 or null** — cap enforced |
| 11 | Startup config clean | ✅ 0 OBSOLETE, 0 TIMEZONE warnings, `America/Los_Angeles` |
| 12 | Route pricing behaves | ✅ all three routes used (9 ask / 4 bid / 7 mid) |
| 13 | EOD timing | ✅ margin **flat by 12:54 PT** (groupCount 1→0 after the 12:50 close) |
| 14 | Re-eval skips | ✅ WEN "strategy flipped to MANAGE_ALLOCATION at execution time" at 12:30 — guard worked |
| 15 | Ledger populated | ✅ real rows (field is `realizedPnlDollars`); gap: `entrySpreadPct`/`gateScoreAtEntry` null |
| 16 | Notifications arrived | ❓ **not locally verifiable** — emitted to the secret server; 0 local traces. Check its log stream. |
| 17 | Pacific gates at correct wall-clock | ✅ cutoffs/arm fired at correct PT times; no TZ warning |

## The day's lesson: WEN and the spread trap

Margin's loss was a single **15-contract WEN lot stopped out at EOD (−12.3% bid, ≈ −22% realized)**. The mechanism is [stop-loss/spread coupling](../improvements/) in the flesh:

- WEN's option spread was **~18%** — it *just* cleared the 20% entry gate (`STRATEGY_MAX_OPTION_SPREAD_PCT`), with day-volume as thin as **4–20** contracts.
- All day WEN's **ask stayed +1% to +7%** (≈flat on the mid) while the **bid ran −9% to −18%** — pure spread, not a real move.
- The account accumulated to 15 lots via **normal MANAGE_ALLOCATION** (the ask looked healthy), reaching size in ~70 min (11:22→12:30).
- The **−10% post-cutoff *bid* stop** then force-sold into that wide bid at EOD. An 18%-spread name is **born pre-stopped**.

Cash, by contrast, was **green**, both from ENVX exits (overnight-reduction +23%, take-profit +21%). ENVX's close was blocked 06:30–08:07 by the morning spread gate (91%→32% spread), then filled cleanly at 10:33 once it tightened — the gate delayed, didn't trap.

## New findings → action items

1. **dxLink session-limit restart loop** *(infra, sev-2 — top item)*. All 23 restarts were `[quote-streamer] Fatal condition` from `UNAUTHORIZED: The number of user sessions has exceeded the configured limit, user=tasty/U0001058779` (60 raw kicks). Self-reinforcing: a restart opens a new streamer session before the old expires server-side, so restarts pile up sessions and re-trigger the kick. The 07-02 backoff throttled it (0–2/30min) and **kept the prime window 06:30→10:24 clean** (13 overnight, 9 midday). → Investigate streamer session teardown on SIGTERM, and whether a second consumer shares login `U0001058779` (desktop app? secret server? 2nd instance?). Prefer streamer reconnect-with-backoff over process-exit-restart for streamer faults.
2. **Entry spread gate too loose** *(strategy)*. 20% let WEN in at ~18%, pre-arming the bid stop. Candidates for [STATUS.md](../improvements/STATUS.md) AFTER-MONDAY: tighter buy-side spread threshold, and/or feed the now-live liquidity data (vol 4–20 on WEN) into the step-2 floor gate.
3. **Dip boost is ask-blind** *(strategy)*. The boost triggers on **ask**-return down >2%; WEN's pain was entirely bid-side (wide spread), so it never fired despite `goodBooleanScore=6` (≥4 met). The trigger metric, not the boolean bar, is the binding question — revisit whether "dip" should be measured on mid/bid.
4. **Day-reports NDJSON is stale** *(bug, minor)*. `data/day-reports/*.ndjson` still shows June-30 timestamps — not being written. Separate from the ledger (which works). Worth a look at the writer.
5. **Ledger entry-side enrichment gap** *(minor)*. `entrySpreadPct` and `gateScoreAtEntry` are null on every row — the close-side capture works but entry context isn't backfilled.

## Tuning questions (runbook §5)

1. **Strong booleans at the bottom?** Mixed for WEN — `daytradeScore` swung −58…+46 with no clean pattern (unlike 07-02 MARA 9–10). Not repeated.
2. **Cash seed through a dip end-to-end?** Not exercised — **0 seeds even attempted** (seedSkipped=0 both sides); no qualifying dip (WEN ask stayed positive).
3. **≥4 boolean bar for dip boost?** Moot today — boost never fired (ask-return condition, not the boolean bar).
4. **Seed IV-fallback bars (50/70) reachable?** No new evidence; ranks in play were 42–83 (booleans weren't dark).
5. **Zero-target residual noise vs. base tier?** Collapsed hard (3%/10%). Residual concentrated in the cold-cache morning window (6–9 AM) — consistent with restart tail, not a base-tier gap. Re-check once the session loop is fixed.
6. **Multiple=3 costing money on rips?** N/A — WEN dipped, didn't rip. But the multiple did **not** prevent a 15-lot accumulating in ~70 min.

## Handoff

Monday is **verified**: the runbook ([2026-07-06-monday.md](2026-07-06-monday.md)) is retired; daily operation follows [../OPERATIONS.md](../OPERATIONS.md) from here. New items 1–5 above go to [../improvements/STATUS.md](../improvements/STATUS.md) (AFTER-MONDAY bucket) — the dxLink session loop is the one that shouldn't wait for the 1–2-week review.
