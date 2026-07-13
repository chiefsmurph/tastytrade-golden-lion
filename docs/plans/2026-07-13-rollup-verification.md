# 2026-07-13 — thesis-rollup go-live: what to verify, and the morning-margin decision tree

Written 2026-07-13. Today was the first session on the consolidated feed thesis. Read today's
data (and watch tomorrow morning) against this doc. Daily mechanics are in
[../OPERATIONS.md](../OPERATIONS.md); this is the one-time verification layered on top.

## What went live, in what order

- **This morning's deploy**: feed signal renames, rollup scoring (`manualThesisCount` 0–10
  preferred → `buyFraction` fallback → legacy flags), `thesisCount >= thesisMax` margin-seed
  bar, morning-weighted exposure curves (margin 60% at open → 80% by 9:00 → 100% by 10:30),
  authenticated notifications (`attemptAuth` + queued emits).
- **Pending server pull (do after close)**: `8ccf13f` — legacy per-flag scoring deleted
  entirely; missing rollup now scores 0 with a loud tripwire warning
  (`[secret] N/M positions arrived WITHOUT thesis rollup fields`). Behavior-identical while
  the feed sends the rollup on every position, which it does.

## Verification checks (today's pull / tomorrow live)

1. **Scores are real again** — % of margin cycles with `goodBooleanScore` 0, vs the **68%
   gate-zeros baseline** from last week (plan diagnostics + `margin-position-gate` lines).
   Scores now read `/10` (manual thesis; +2 icing → max 12).
2. **Rollup fields present** — zero tripwire warnings in the out-log. Any occurrence = feed
   regression; the affected tickers score 0 (safe, but signal-blind — tell the feed side).
3. **Margin seeding bar** — seed logs should show the `thesisCount >= thesisMax` reasoning.
   4/4 seeds; anything less doesn't. If NO margin seeds fire for days, check whether 4/4 is
   realistically reachable intraday (tuning question, not a bug).
4. **Notifications land** — `tastytrade-golden-lion INFO [...]` on the secret server stream +
   `(sent)` breadcrumbs in pm2. `(queued)` breadcrumbs that never flush = auth problem.
5. **Ledger sanity** — `bot:getPnlLedger <acct> <date>`: `gateScoreAtClose` now on the 0–12
   scale; decision-type mix sane.

## The morning-margin question (decision tree)

Two levers targeting quiet mornings shipped together — attribute carefully:

- **Gate fix** (scores non-zero) and **exposure curve** (margin told to be ~fully deployed by
  10:30) land at once. Judge the gate fix by score distributions; judge the curve by buy
  *timing and sizes* given non-zero scores.

Then walk this tree with the data:

1. **Scores still mostly 0?** → feed/rollup problem (check tripwire, `getSecretSocketStatus`,
   feed timing before 7:00). Nothing else matters until this is green.
2. **Scores healthy but no orders placed before ~9:00?** → something upstream binds: IV gate
   (rank < 20 skips), morning spread ramp (5%→20% by 7:15), or feed updates arriving late.
   The skip reasons in plan diagnostics name the binder.
3. **Orders placed early but unfilled?** → the remaining suspect: morning route weights are
   bid-heavy (0.70 at open) — resting bids wait instead of chasing. This is the deliberate
   untouched lever ("bid-lean adds" / front-loaded ramp family). One session of route-fill +
   ledger data decides whether to shift morning weights toward mid/ask.
4. **Orders placed AND filled early?** → done; the morning-margin question is answered. Move
   to P&L quality (does early margin buying actually make money — ledger `closeHourPst` vs
   `realizedPnlPct`).

## Score-scale cheat sheet (post-rollup)

| Signal | Value |
|---|---|
| Score source | `manualThesisCount` raw (0–10) → `buyFraction`×10 → 0 |
| willBuy icing | +2 when `buyFraction` > 1.0 (max 12) |
| Dip boost gate | score ≥ 4 |
| Seed multiplier | ≥3 → 0.95× · ≥5 → 0.85× · ≥7 → 0.7× |
| Deep-loss seed bar | ≥ 6 |
| Boost on maxTargetPct | 0.03/pt |
| Surplus | min(score/10, 1) × 0.30 |
| Margin seed | `thesisCount >= thesisMax` (4/4 today) |
| allBooleansGood | `buyFraction >= 1.0` |
