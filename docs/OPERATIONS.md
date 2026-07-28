# Operations — daily EOD routine + periodic review

Standing doc (written 2026-07-05). Two cadences: a ~10-minute end-of-day check every trading day, and a data-review session after ~1–2 weeks of accumulated ledger/log data. The one-time Monday go-live runbook is [plans/2026-07-06-monday.md](plans/2026-07-06-monday.md); this is what replaces it once Monday is verified.

## Daily EOD routine (~10 min, after 1:05 PM PT)

Ordered by "if this is wrong, stop and fix before reading further" — same philosophy as the Monday verification hierarchy.

### 1. Did anything break? (2 min)

- **Secret-server log stream**: any `tastytrade-silver-lynx ERROR [...]` lines? (`cycle-exception`, `cancel-orders-failed`.) Each one is a real incident — investigate before anything else. INFO lines (`hard-risk-close`, `position-closed`, `position-built`) are normal activity.
  - **Zero lines all day is itself a finding**: the client emits a `client:act` event and logs a local breadcrumb on every `notifyEvent`. Breadcrumbs in pm2 out-log but nothing on the secret server = auth or handler problem server-side — first check `SECRET_SOCKET_AUTH_KEY` is set and the boot log shows `[secret] attemptAuth sent` (the server silently ignores `client:act` from unauthenticated sockets; root cause of the 07-06→07-12 silence). No breadcrumbs either = the events never fired (fine on a quiet day) or the socket was down.
- **Error-typed run-history entries**: `node run bot:getRecentRunHistory 60` — any entries with an `error` field mean a cycle exploded mid-execution; orders may have been placed before the throw.
- **Restart count**: `grep -c 'Exiting for PM2 restart' <pm2 error log>` — expect ~0–3. A spike means the crash-loop is back and every downstream signal that day is suspect.

### 2. Is margin flat? (1 min)

- `node run core:getPositionsAndBalances <MARGIN_ACCOUNT>` — margin must hold **zero** option positions after 1:00 PM PT. Anything held overnight on margin is the exact failure the 12:50 EOD arm exists to prevent. If a position survived: pull the day's chase logs for that symbol, find where the liquidation stalled, and treat it as a sev-1 for the next session.

### 3. What did we make or lose, and why? (3 min)

- `node run bot:getPnlLedger <ACCOUNT> <today>` per account — the `byDecisionType` rollup is the day in one glance: how much came from take-profits vs. was given back to stops vs. EOD liquidations vs. overnight reductions.
- Spot-check 1–2 ledger rows against broker fill history (the ledger misses closes that fill after the chase's final re-fetch — known gap until confirmed-fill tracking lands, v5 code #3). If a broker fill has no ledger row, note it; a pattern means the gap is material.
- `node run bot:getDayTrend` — unrealized drift vs. yesterday's baseline for what's still held (cash overnights).

### 4. Did the machinery behave? (3 min)

Greps against the day's pull (`scripts/pull-today.sh` → `data-pull/<date>/`; pm2 line prefixes are PT, embedded JSON timestamps are UTC):

- **Re-eval saves**: `grep 'strategy flipped to MANAGE_ALLOCATION'` — each line is a recovered position the stale stop did *not* sell. Zero is fine.
- **EOD timing**: margin close decisions at ~12:50, chase done before 1:00. A chase still walking at 12:59 = escalate.
- **Zero-target skips**: count `"target exposure is zero"` in `plan.diagnostics` — small residual expected; a spike with a stable process re-opens the base-tier question (v4 strategy #1).
- **Per-leg spread flags** (multi-expiry groups) and **executed-vs-configured route weights** — scan for the 20pp+ divergence flag and collapsed weight splits; these are the tuning inputs, not incidents.
- Anything odd → cross-reference run history (`bot:getRecentRunHistory`) before touching config; every decision the bot made is recorded with its reasoning.

### 5. Log the day (1 min)

One line in a running note (date · net realized $ · decision-type mix · incidents · anything weird). Two weeks of these lines is the agenda for the review below.

## Periodic review (~after 1–2 weeks of data)

The point: nearly every open strategy item in [improvements/STATUS.md](improvements/STATUS.md) says "tune from distributions." After ~10 trading days the ledger and logs contain those distributions. Block 1–2 hours and answer these **from data, not intuition** — each question names its data source.

### P&L attribution (source: `data/ledger/*.ndjson`)

1. **Which decision types make money?** Sum `realizedPnlDollars` by `decisionType`. If stops dominate losses far beyond what take-profits capture, the stop design (grace period, mid-based floor — v4 #5) moves to the front of the queue.
2. **Take-profit timing**: distribution of `closeHourPst` and `realizedPnlPct` on take-profits — are winners sold at ~8% that kept running (case for scale-out, v4 #8, and min-hold-time, v6 #14)?
3. **DTE and P&L**: `dteAtEntry` vs. P&L — does the ≤7 DTE margin regime actually win, and should late-morning delta ramp up (v5 #10)?
4. **Churn/fee pressure**: count round trips per symbol per day; many small trips on sub-$1 contracts = the fee-model item (v5 #2) is costing real money.
5. **Position age**: `positionAgeDays` vs. P&L on cash overnights — is the overnight-hold thesis paying (needs the overnight P&L snapshot, v6 #12, if it landed)?

### Signal and gate quality (source: run history NDJSON)

6. **Gate score vs. outcome**: join ledger rows to `gateScoreAtClose` / gate data in run history — do high-boolean entries actually outperform? ("Strongest booleans at the bottom" — did the 07-02 MARA pattern repeat?)
7. **Zero-target residual**: has it collapsed for real, or does the unsignalled base tier (v4 #1) need building?
8. **Dip-boost bar**: with `dipTargetBoostPct` logged, was ≥4 booleans the right bar or should it be ≥7?
9. **Underlying context**: `underlyingPriceAtCycleTime` across cycles — were averaging-down buys landing into free-fall? This is the go/no-go for enforcing the stabilization gate (v5 #6) beyond log-only.

### Execution quality (source: candidate + route logs)

10. **Liquidity floors**: distributions of `dayVolume` / `openInterest` / `bidSize` / `askSize` on chosen candidates → set the step-2 OI floor (v4 #4) from percentiles, not guesses.
11. **Route performance**: fills per route; how often did resting bids fill vs. get cancelled by the next cycle's sweep? Quantifies what persistent resting orders (v5 strategy #1) would buy.
12. **Weight fidelity**: executed-vs-configured splits — are small orders collapsing to bid/mid only (v6 #18 data)?
13. **IV gate fit**: how much did rank<20 actually block, and are the seed fallback bars (50/70) ever reachable (v4 #3 follow-up)?

### Process

14. Re-read the daily one-liners from step 5 — recurring "weird" notes are the discovery backlog for the next improvements pass.
15. Reconcile: STATUS.md AFTER-MONDAY items whose data question is now answered move to "build"; anything two weeks of data didn't touch probably wasn't worth tracking — cut or demote it.

## Server / pm2 gotchas (learned 2026-07-05, the hard way)

The deploy box runs **multiple pm2 apps under one daemon** — golden-lion is not alone. Rules that follow from that:

- **Never `pm2 kill` casually** — it takes down *every* app the daemon manages, not just ours. Prefer `pm2 delete tastytrade-silver-lynx` + `pm2 start ecosystem.config.cjs` for our app alone.
- **If the roster is ever lost**: `pm2 resurrect` restores from `~/.pm2/dump.pm2`. If a bad `pm2 save` overwrote it, the previous roster is in `~/.pm2/dump.pm2.bak` — copy it back and resurrect. Last resort: `ls ~/.pm2/logs/` is a complete roster of every app name that ever ran.
- **`pm2 save` snapshots the *current* list** — never save while apps are missing; you overwrite the good dump (`.bak` then holds the only copy).
- **Node version**: the deploy shell's default node was v20 (no global `WebSocket` → the streamer throws `WebSocket is not defined`). The app needs v24; `ecosystem.config.cjs` pins `interpreter: process.execPath`, so **always run `pm2 start` from a shell where `node -v` says v24** (`nvm use 24`, or better `nvm alias default 24` once). The pm2 `startup` boot hook snapshots PATH at generation time — regenerate it after changing the default node.

## Cadence summary

| When | What | Time |
|---|---|---|
| Every trading day ~1:05 PM PT | Sections 1–5 above | ~10 min |
| Weekly (Friday) | Skim the week's daily one-liners; anything trending? | ~10 min |
| After ~10 trading days | Full periodic review; re-prioritize STATUS.md from data | 1–2 h |
