# Week in review — 2026-07-06 → 2026-07-10

> Compiled 2026-07-10 evening from seven parallel analysis passes over the full week of
> production data (`scripts/pull-today.sh` → `data-pull/<date>/`, local-only/gitignored).
> Raw per-pass reports with exact figures live locally in `data-pull/2026-07-10/analysis/`.
> This doc uses percentages, counts, and qualitative sizing only.
>
> Accounts: margin (EOD-flat by ~12:55 PT) and cash (holds overnight). pm2 log prefixes are
> Pacific; JSON timestamps are UTC. Session 06:30–13:00 PT.

## Deploy timeline (verified from boot `startup-config` lines)

| Day | Boots | Build live | Notes |
|---|---|---|---|
| Mon 07-06 | 28 (storm) | Weekend set: route-chase redesign, IV-rank gate, margin DTE ≤ 7, allocation-buy multiple | 23 crash-exits from the dxLink session-limit fault (pre-fix), 5 operator restarts |
| Tue 07-07 | 1 | **v8 set** from ~08:23 PT (mid-session deploy) | Tight margin entry-spread cap (0.10) already set in prod env from this boot — one day earlier than planned |
| Wed 07-08 | 1 | **v9 set** from 06:56 PT | |
| Thu 07-09 | 0 | v9 | Ran continuously — genuinely zero restarts |
| Fri 07-10 | 1 | v9 | 09:12 PT restart = clean operator SIGINT (3s turnaround, warm cache rehydrate); NOT a crash |

The position-gate liquidation fix (`47e00ff`: suppress `willBuy` when `buyEligible` explicitly
false, add `qualityToBuy`, score max 10→11) was pushed **after Friday's close** — it is next
week's change. §5 below records the baseline it will be judged against.

---

## 1. Shipped-change verification — 17/18 WORKING, 1 SILENT-by-design

Every item from the weekend set, v8 (13 items), and v9 (5 items) was checked against its log
signature per day, respecting the deploy timeline. **No item reverted to old behavior after its
deploy.** Full signature tables in the local raw report `01-change-verification.md`.

### Weekend set (live all week)
| Item | Verdict | Evidence |
|---|---|---|
| Margin DTE cap ≤ 7 | WORKING | `targetDTE` never exceeded 7 any day |
| IV-rank gate resurrected | WORKING | zero `market-metrics 400` errors; real ranks logged; skips firing (but see §3 on null ranks) |
| Closing-only TTL retry cache | WORKING | fires only on days a broker halt existed |
| Preflight `errors[]` in seed skips | WORKING | bracketed broker codes (`[closing_only]`) appended as designed |
| Overnight-hold open snapshot | WORKING | 2/day (one per account) every day since ship |

### v8 set (live from 07-07 ~08:23 PT) — 13/13 WORKING
Highlights (full table locally):
- **dxLink session ownership (#6/#7)**: session-limit kicks **60 → 0** and stayed 0 all week;
  boots 28 → 1/1/0/1. Friday demonstrated the complete new lifecycle: graceful SIGINT teardown,
  warm cache rehydrate (19 positions, age 2s), and an after-hours token-expiry fault recovered by
  **in-process reconnect in 5s with no process exit** — under the old code that was a restart.
- **Account-aware liquidity/spread gate (#1/#2)**: live and binding — margin ceiling observed at
  0.05–0.10 vs cash 0.20; hundreds to ~1,800 wide-spread candidate rejections per day. On 07-08/07-09
  it kept the bot **entirely out** (zero allocation buys either account) — intended behavior, and
  the WEN-class loss did not recur.
- **Dip boost on mid, not ask (#3)**: fired with ask ≈ 0 and mid clearly negative — impossible
  under the old ask basis.
- **Per-underlying contract cap (#4)**: textbook clamp observed (held 8, requested 3, clamped to 2
  at the cap of 10).
- **Registry broker-reconcile (#11)**: first post-deploy cycle marked-closed the exact stale
  07-02 entries (`closedVia:"broker-reconcile"`); no legitimate overnight holds pruned.
- **Day-report writer (#12)**: file was frozen at June-30 → fresh row every trading day since.
- **Ledger entry-side enrichment (#13)**: `entrySpreadPct`/`gateScoreAtEntry` populated on all
  post-deploy opens (nulls only on pre-deploy positions, expected).
- Notify breadcrumbs, eod-stop vs eod-liquidation taxonomy split, ledger in pull script: all confirmed.

### v9 set (live from 07-08 06:56 PT) — 4 WORKING, 1 SILENT
| # | Item | 07-07 baseline | After | Verdict |
|---|---|---|---|---|
| 1 | Overnight-reduction dedup + cutoff | **85 orders placed**, 2 filled (2.4%), running past 13:00 | **1 / 1 / 3 placed**; dedup skip fires ~73–81×/day; none after 13:00 PT | WORKING |
| 2 | 422 cycles tagged | 5 zeroed cash cycles masquerading as data | single 422 written as `entryType:"error"`; zero on 07-09/07-10 | WORKING |
| 3 | Terminal-order cancel cache | **7,930** "not cancellable" retries (237 distinct orders re-hammered) | **1 / 0 / 1** per day | WORKING |
| 4 | Buy-at-cutoff guard | buy at 12:30:17 PT → force-liquidated 22 min later | guard fired 10× on 07-10 (8-min buffer); zero late buys after deploy | WORKING |
| 5 | Dip-boost bid-safety gate | (motivating case pre-dates it) | **zero fires** — every wide-bid candidate was already suppressed upstream by the wide-spread gate (0.14) | SILENT (correct redundancy; independent value unproven — needs a wide-bid/narrow-spread case) |

---

## 2. Week scorecard & trade taxonomy

23 filled closes (11 margin, 12 cash). Sources: realized-P&L ledger (verified: the 07-10 pull is a
strict superset of earlier pulls; margin's blank 07-08/07-09 is correct — zero closes those days).

- **The week was net negative, and one underlying — WEN — is the entire story.** WEN's six closes
  (two wide-spread entries from 07-06 bleeding out through 07-08) exceed the week's combined net
  loss by themselves; **ex-WEN the book was net positive**. The week ended on two green days
  (07-09, 07-10) once WEN inventory cleared.
- **Structure is the problem, not the tail**: 35% win rate at a 0.64 payoff ratio (avg win smaller
  than avg loss) is negative-expectancy at these frequencies. Winners are small and capped; the
  single largest loss outweighed all eight winners combined.
- **Taxonomy**: margin damage concentrated in `eod-stop` (mostly the Monday WEN block); cash damage
  in `stop-loss` (mostly WEN) plus a slow overnight-reduction bleed. Take-profits fire but are small.
  Every close carried a classified reason — no "other" bucket.
- **Holding profile matches the account model exactly**: margin median hold 0 days (all intraday);
  cash median 1.5 days (up to 4).
- **Post-v9 trend**: worst-single-close-per-day shrank from ~−28% (Mon) to a +19% winner (Fri).
  No new WEN-class wide-spread margin entry closed after the tight gate went live. The 07-08 red day
  was the *legacy* cash WEN flushing, not a new bad entry.

---

## 3. Entry quality — spread at entry vs outcome

18 new group entries this week. Joined entry context (ledger `entrySpreadPct`, gate score, ivRank)
to outcomes:

- **The week's realized loss is exactly two wide-spread WEN entries** (margin 18.2% spread,
  cash **46.2%** spread at gate score 0). Every other entry netted positive in aggregate.
- **Persistent wide spread — not the entry snapshot — is the killer.** Counterexample: one margin
  entry at 26% spread *won* because its spread collapsed to 6% by cycle time; WEN/LAC stayed wide
  (14–113% at cycle) and were force-liquidated. Implication: an entry-time cap is necessary but not
  sufficient — a live re-check of the *held* contract's spread is what would have stopped the
  two-day bleed.
- **Born-pre-triggered confirmed but confined to >30% spreads**: only the two >30% entries started
  within 15 points of the −30% bid stop. Everything ≤26% started ≥17 points clear.
- **Gate score did not discriminate outcome this week; spread did.** High-gate entries appear in
  both the biggest win and the biggest loss.
- **Two gate-bypass holes found**:
  1. **Average-down add path** gates on the held contract, so it added into WEN cash at 46% spread
     (both red flags — spread and gate 0 — ignored by that path).
  2. **Seed / afternoon entries** sidestep the tight margin ceiling — LAC entered margin at 22%
     spread at 12:16 PT (small loss).
- **The IV gate is currently toothless for this universe: 91% of seed decisions had `ivRank: null`,
  which passes the gate unconditionally.** It fired ~96 times when a rank existed but neither
  blocked nor caught any actual entry in the table.

---

## 4. Circuit breakers & EOD mechanics

- **Cutoff-buy hazard fixed** (see §1 v9 #4). Last margin buy Friday was 09:20 PT — hours clear of
  the EOD window.
- **Zero re-entry churn all week** — no close-then-rebuy sequence anywhere. **Correction to the
  07-07 record**: the "ACHR re-entered after take-profit" finding was actually a *partial* TP
  (8 of 9 contracts) leaving a 1-contract residual that later eod-stopped. The live pattern to fix
  is **partial-TP residual stubs**, not re-entry cooldowns.
- **Dynamic profit target decays as designed**: an early close hit +47.6% against the morning bar;
  a late-morning one closed +8% against the decayed bar.
- **Stops mostly did their job where the underlying genuinely deteriorated** — the clearest case:
  a margin stop at −15% on a name whose identical cash-held contract gapped to bid −44% the next
  open. Holding was the catastrophic branch.
- **But bid-based stops misfire on blown spreads, in both directions**: one stop triggered at a
  −36.6% bid on a 60% spread and actually filled at −4.9% (false trigger, benign fill); another
  liquidated into a −64% phantom bid for −57% realized. And the worst fill of the week printed
  ~34 points *below* the displayed bid. **A spread-sanity check before honoring a bid-based
  trigger/fill is the highest-value breaker fix.**
- **Cash's overnight-hold model paid a gap tax every single night** — every overnight position
  gapped down on the bid at the next open (worst cases −30 to −61 points, some phantom-low reopen
  quotes, but the direction was uniformly negative). Margin's flat-by-close discipline avoided this
  entirely. Worth a deliberate review of the cash overnight thesis.

---

## 5. Signal feed & gate scores — baseline for next week's `47e00ff` fix

This week ran the pre-fix scoring (log strings show `/10`). Baseline to beat:

| Metric (week) | Value |
|---|---|
| Cash gate evaluations scoring 0 | **68%** (1,246 / 1,821) |
| OPEN window (6:30–8:00 PT) zero rate | **87%** |
| Score-0 gate-cycles inside liquidation windows (open+EOD) | **377 = 18% of all gate-cycles** (the slice the willBuy-suppression directly targets) |
| Cash cycles with a "target exposure is zero" diagnostic | **86%** (433/501) |
| Cross-account seeds actually placed | **1** (held-contract fallback) |

Key qualifications:
- **Per-boolean values are not logged**, so exact re-scoring under the new formula is impossible
  from this data; judge the fix by the drop in OPEN/EOD-window zeros on days the feed has depth.
- **~42% of the zeros are feed-content zeros the fix cannot touch**: 07-08 ran essentially all day
  on a **1-position feed** (100% zeros mid-session), 07-09 on 2. The realistic win is concentrated
  on days with feed depth (07-06/07-07/07-10-style).
- **Connectivity was never the problem**: staleness never crossed the 600s threshold; both
  restarts rehydrated warm. Zero-target is a *score/content* problem.
- **Corroboration the thesis-vs-intent gap is real**: auto-seed fires (which key on `qualityToBuy`)
  logged healthy scores 4–9 at the same moments the cash gate for the same universe read 0.
- **Seeding is high-effort, near-zero yield: 636 auto-seed fires → 30 placed (~5%).** New Friday
  blocker: on the richest feed day of the week (~18 symbols), every candidate's cost exceeded the
  configured max-seed-order-cost and the cash per-action buying-power cap → **181 fires, 0 placed**.
  Even with gate scores fixed, seeding stays dead unless those caps are revisited.

---

## 6. Execution quality & order hygiene

- **The bot got dramatically quieter as the week's fixes landed** (see §1 v9 table). Remaining
  order volume by Friday is genuine trading activity, not mechanical churn.
- **Route drift is mild**: executed vs configured bid/mid/ask ≈ 15/36/49 vs 19/34/47 — the
  floor+greedy rounding shaves bid slightly; not the feared bid-only collapse. Caveat: buys fired
  on only 3 of 5 days and clustered mid-morning, so the bid-heavy open weighting was barely
  exercised.
- **Closes fill on 0–1 chase steps**; nothing hit the 10-step cap; no close failed to fill.
- **The leak is close-side quote quality, not chasing**: 6 of 23 filled closes printed *below* the
  displayed bid; four filled into 60–117% one-sided books. The phantom-quote guard (disabled in
  prod) is **entry-side only** — it flagged `phantomQuote:true` ~280–2,000×/day on candidates while
  **the close/sell path has no spread or phantom guard at all**. That is the structural root of the
  Monday/Tuesday bad-fill pattern, and the ingredients remain fully present.
- **Analytics gotcha for future passes**: `executionSummary.closeOrderCount` over-counts fills by
  ~30× (it counts attempts/re-skips per cycle). The ledger is the only ground truth for filled
  closes; distinct order IDs for placements.

---

## 7. Ops & data integrity

- **Restart census**: 28 (storm, pre-fix) → 1 → 1 → **0** → 1. Both mid-week restarts were clean
  operator deploys; Friday's 09:12 PT restart had no preceding fault and rehydrated warm in 3s.
- **Error-log profile is stable and mostly benign** post-Monday: chain/expiration fallback noise,
  multi-expiration masking (known v7 item, new symbol OPEN joined LCID/EOSE), secret-socket churn,
  occasional ivRank-unavailable. The only new late-week error type was the healthy token-expiry →
  in-process-reconnect recovery.
- **Records reconcile cleanly**: day-reports present every trading day since the v8 fix; ledger
  matches run-history close fills day-by-day; cycle counts 98–107/day with max gap <5 min (even
  through Monday's storm).
- **Open ops items**:
  1. **`BOT_DO_NOT_TOUCH_GROUPS` is not enforced by the overnight-reduction path.** The strategy
     path honored the flag on Friday's protected group, but `executeOvernightReductions` iterates
     all evaluations with no do-not-touch filter and force-closed it at 12:56 PT (4 min under the
     13:00 reduction cutoff). Same class of gap should be checked in any other order-placing path
     (seeds, IPC helpers).
  2. That group is consequently **stale-OPEN in position-registry.json** (close happened after the
     last reconcile; expected to self-heal next session — verify Monday).
  3. **Secret-socket churn trending up** through the week (Friday worst: 8 disconnects / 37
     connect_errors, all recovered in seconds). Benign today; watch.

---

## 8. Consolidated next-actions (candidate v10 list, rough priority)

1. **Close-side spread/phantom guard** — three independent passes converged on this as the top
   money leak (bad stop triggers, phantom-bid fills, one-sided-book liquidations). Even a bid-size
   sanity check before urgent crosses would help.
2. **Enforce do-not-touch in overnight-reduction** (and audit all order-placing paths for the same
   bypass).
3. **Held-contract spread re-check on the average-down add path** — the entry cap can't stop adds
   into a contract whose spread has blown out (the 46%-spread add).
4. **Extend the tight margin entry ceiling to seed/afternoon paths** (the 22%-spread 12:16 PT
   entry).
5. **Partial-TP residual handling** — close the full group or explicitly manage the stub (this
   replaces the previously-planned post-TP re-entry cooldown, which the data says isn't needed).
6. **Seed affordability** — max-seed-order-cost + per-action cap currently reject entire rich-feed
   days; either raise the caps, allow cheaper-candidate fallback, or accept seeding is off.
7. **Decide the IV gate's null policy** — 91% of seed decisions pass unconditionally on null rank;
   fail-closed, alternative metric, or drop the gate.
8. **Review the cash overnight-hold thesis** — a uniform overnight bid-gap tax all week; quantify
   over more weeks before structural change.
9. **Monday verification for `47e00ff`** — compare against §5 baseline (68% zero rate, 87%
   open-window zeros, 377 liquidation-window zeros, 86% cash zero-target cycles); expect wins
   concentrated in open/EOD windows on feed-depth days; verify seed-decision thresholds against the
   new 0–11 scale.
10. **Watch items**: dip-boost bid-safety gate still unproven (needs a wide-bid/narrow-spread
    case); secret-socket churn trend; registry reconcile of Friday's forced close.
