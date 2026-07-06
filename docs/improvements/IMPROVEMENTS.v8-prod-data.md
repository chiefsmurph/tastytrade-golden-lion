# Improvements v8 — First production-data pass

> **Discovery log (2026-07-06).** Source material: the first full trading day run against the verified Monday build (`27037be`), analyzed in [../plans/2026-07-06-monday-results.md](../plans/2026-07-06-monday-results.md). Unlike v1–v7 (code-reading passes), **every item here is backed by production evidence** — a dollar cost, a log count, or an observed ledger row — not a hypothesized failure. Cross-checked against STATUS.md and v1–v7; adjacencies are stated. Several items *promote* an already-catalogued item from "hypothesis" to "confirmed with a cost."
>
> The day in one line: net **−$131.59** (margin −$169.59 / cash +$38.00), the whole tradeable day was **WEN** in both accounts, and the margin loss was a single 15-lot WEN position stopped out at EOD into an 18%-wide bid.

---

## Strategy / profitability

### 1. Entry spread gate (20%) is too loose — it admits names that are born pre-stopped

**File:** [src/strategy/entry-filters.ts](src/strategy/entry-filters.ts), [src/strategy/option-candidate/selection.ts](src/strategy/option-candidate/selection.ts)

WEN cleared the 20% `STRATEGY_MAX_OPTION_SPREAD_PCT` gate at ~18% spread. All day its **ask sat +1% to +7% while its bid ran −9% to −18%** — pure spread, not a move. The −10% post-cutoff *bid* stop then force-sold 15 lots into that bid at EOD for **−$160.86**. An 18%-spread name is stopped the moment the spread alone exceeds the stop threshold; the entry gate and the stop floor are coupled (30% entry vs −30% bid stop is the general form). Today put a dollar figure on it.

**Fix direction:** a tighter buy-side spread threshold (distinct from the close-side), and/or gate entries on the now-live liquidity data — WEN's chosen contracts showed `dayVolume` as low as **4–20** and `askSize` as low as **1**. This is exactly the step-2 floor gate below.

*Promotes the [stop-loss/spread coupling] item (v4 #5, project memory) from hypothesis to confirmed-with-cost. AFTER MONDAY → now has its go-signal.*

---

### 2. Promote liquidity gating from log-only (step 1) to floor gates (step 2)

**File:** [src/strategy/option-candidate/selection.ts](src/strategy/option-candidate/selection.ts)

The step-1 liquidity logging (shipped for Monday) worked cleanly — 44 `manage-allocation-candidate` lines with **real integer** `bidSize`/`askSize`/`dayVolume`/`openInterest`. It immediately caught the WEN problem (thin volume, sizeless asks). The data to set step-2 floors now exists. WEN is the worked example: it should not have been buy-eligible.

**Fix direction:** implement `STRATEGY_MIN_OPEN_INTEREST` (start ~100) and the phantom-quote guard (sizeless quote while market open ⇒ distrust this cycle's spread pass), per the runbook §4 rollout. Hard rule: unknown degrades gracefully (pass + log), never treated as zero — don't recreate the IV-gate silent-block bug.

*This is runbook §4 step 2 / v4 strategy #4. Monday was the "collect step-1 data" gate; it passed.*

---

### 3. The dip boost measures the wrong side of the market — it's blind to spread pain

**File:** [src/strategy/risk-limits.ts](src/strategy/risk-limits.ts), [src/bot/run-cycle-context.ts](src/bot/run-cycle-context.ts)

`STRATEGY_MARGIN_DIP_TARGET_BOOST_MAX_PCT=0.25` was enabled all day and **never fired** — all 30 logged `dipTargetBoostPct` values were `0`. Reason: the boost triggers on **ask-return** down >2%, but WEN's pain was entirely bid-side (ask stayed +1–7%). WEN's `goodBooleanScore` was 6 (≥4 bar met), so the boolean threshold was *not* the binding constraint — the trigger metric was. A boost meant to lean into dips can't see the most common dip (a widening bid).

**Fix direction:** re-derive "dip" on the mid or bid return, not the ask. Re-open tuning question #3 (≥4 vs ≥7 booleans) only after the metric is fixed — today's data can't answer it because the gate upstream never opened.

*New. Adjacent to the gate/boost logic in cash-position-gate.ts. AFTER MONDAY (behavior-changing).*

---

### 4. The allocation-buy multiple compounds — 3× reached a 15-lot in ~70 minutes

**File:** [src/bot/actions/manage-allocation.ts](src/bot/actions/manage-allocation.ts)

`STRATEGY_MAX_ALLOCATION_BUY_POSITION_MULTIPLE=3` caps each add at 3× *current* position value. Because it re-reads current value each cycle, adds compound (2→6→18…): margin went from a first small WEN add (~11:22) to **15 contracts by 12:30**. The multiple made the *first* add small, as intended, but did not bound the *total* — and the total is what got stopped out for −$160. (WEN dipped rather than ripped, so the multiple's intended cost case — Q6 — didn't apply; this is the opposite failure.)

**Fix direction:** consider anchoring the multiple to a session-start baseline, or adding an absolute per-underlying contract/notional cap, so a fast series of "small" adds can't compound into an oversized lot in one name.

*New. Adjacent to the pct exposure caps (which bind later, once a position matures). AFTER MONDAY.*

---

### 5. Buy-eligibility funneled the entire day into one name

**File:** [src/bot/run-cycle-context.ts](src/bot/run-cycle-context.ts) (group prioritization)

Five underlyings were *evaluated* (`EOSE` 105, `WEN` 87, `ENVX` 65, `SOC` 17, `HTZ` 2) but only **WEN** was ever *considered for a new buy* (44 candidate lines, 0 for the others). The rest were held/cooldown/closing-only. So 100% of the day's new risk went into a single, illiquid name. This isn't a naive concentration-cap gap — it's that with one buy-eligible name and no liquidity gate, there was no diversification and no quality floor.

**Fix direction:** mostly resolved by item 2 (a liquidity floor would have made WEN ineligible, leaving the day flat rather than concentrated-and-illiquid). Worth a per-underlying exposure ceiling as a backstop for days when only one name signals.

*New/observational. Folds into item 2. Log-first evidence already exists.*

---

## Infra / reliability

### 6. dxLink session-limit restart loop — the day's top reliability item

**File:** [src/core/quote-streamer-recovery.ts](src/core/quote-streamer-recovery.ts)

All 23 `Exiting for PM2 restart` events were `[quote-streamer] Fatal condition` driven by **60** `UNAUTHORIZED: The number of user sessions has exceeded the configured limit, user=tasty/U0001058779` kicks → "Bye" → zero events → restart. It's self-reinforcing: a restart opens a *new* dxLink session before the old one expires server-side, so restarts pile up sessions and re-trigger the kick. The 07-02 backoff throttled it (0–2/30min) and kept the **prime window 06:30→10:24 clean** (14 restarts overnight/pre-market, 9 in a 10:24–12:55 cluster). It also caused the only strategy side-effect: the `cached source positions: 0` morning window (6–9 AM) is partly this restart tail blanking the in-memory cache before the feed populates.

**Fix direction:** (a) explicitly tear down the dxLink streamer session on shutdown (SIGTERM path) so a restart doesn't orphan a session; (b) determine whether a **second consumer** holds a session on login `U0001058779` (desktop/web platform, the secret server, a second bot instance) — the clean 06:30→10:24 window suggests an external client that comes and goes.

*New. This is the 2026-07-06 analog of the 07-02 restart storm — same symptom, different root cause. Highest priority; should not wait for the 1–2-week review.*

---

### 7. Process-exit-restart is the wrong recovery for a session-limit fault

**File:** [src/core/quote-streamer-recovery.ts](src/core/quote-streamer-recovery.ts)

Separate from *why* the sessions pile up (item 6): the watchdog's response to a streamer fault is `process.exit → PM2 restart`, which for a session-limit fault **is the thing that creates more orphaned sessions**. The recovery amplifies the fault. A restart is the right hammer for an unrecoverable in-process state, but a streamer that lost its socket can often be reconnected in-process.

**Fix direction:** for streamer-connectivity faults specifically, attempt an in-process reconnect-with-backoff (close old session cleanly, re-auth, resubscribe) before falling back to a process exit. Reserve process-exit for faults that in-process recovery can't clear.

*New. Adjacent to item 6 — different fix (recovery strategy vs. session hygiene). AFTER MONDAY (touches the hot quote path — verify carefully).*

---

## Ops / observability

### 8. Socket notifications have no local breadcrumb — EOD check #16 is unverifiable from the bot's own logs

**File:** [src/bot/notify.ts](src/bot/notify.ts)

Margin ran urgent EOD closes (`isUrgentClose: true`), which [execute-position-evaluations.ts:273](src/bot/execute-position-evaluations.ts#L273) routes to a `hard-risk-close` notification. But there are **zero** local traces of `hard-risk-close` / `position-closed` / `position-built` in the pm2 out log — `notify.ts` emits to the secret server without logging locally. OPERATIONS §1 and runbook check #16 both assume you can confirm notifications fired; today you could not, without the secret server's stream.

**Fix direction:** in `notify.ts`, log a one-line local breadcrumb on each emit (`[notify] hard-risk-close WEN …`) — and, ideally, whether the socket send succeeded. Makes the daily EOD check self-contained.

*New. Observability. Merge-safe (additive log line).*

---

### 9. `eod-stop` conflates the post-cutoff price stop with the clock-based EOD liquidation

**File:** [src/bot/pnl-ledger.ts:64](src/bot/pnl-ledger.ts#L64)

```js
if (reason.startsWith("End-of-day risk management")) return "eod-stop";
```

Both the −10% *post-cutoff bid stop* and the *12:50 clock liquidation* produce reasons starting with "End-of-day risk management," so both collapse to `decisionType: "eod-stop"`. Today's two margin closes were price stops ("… (-12.29% <= -10%)"), but a pure clock-liquidation would be indistinguishable in the ledger. This breaks the exact attribution the periodic review asks for (OPERATIONS §3/§6: "how much was given back to stops vs. EOD liquidations"). It's also why runbook check #15 (expecting an `eod-liquidation` type) read as a mismatch.

**Fix direction:** give the clock-driven liquidation a distinct reason prefix / `decisionType` (e.g. `eod-liquidation`) upstream in the strategy, and split them in `classifyDecisionType`. Then the `byDecisionType` rollup separates "stopped out at EOD" from "flattened by the clock."

*New. Adjacent to the ledger work (v5 code #3). Small, high-leverage for P&L attribution.*

---

### 10. `scripts/pull-today.sh` doesn't pull `data/ledger/` — the artifact the EOD routine depends on

**File:** [scripts/pull-today.sh](scripts/pull-today.sh)

The ledger is now the centerpiece of the daily EOD routine (OPERATIONS §3) and the periodic review (§P&L attribution), but the pull script copies only `runs/`, `day-reports/`, and `position-registry.json`. I had to scp `data/ledger/*.ndjson` by hand to get today's P&L.

**Fix direction:** add a `data/ledger/` copy to `pull-today.sh` (filtered to the day where possible; the files are small enough to copy whole).

*New. Tooling. Merge-safe.*

---

## Data / bookkeeping

### 11. Position-registry leaks closed margin positions — impossible OPEN entries persist for days

**File:** [src/bot/position-registry.ts](src/bot/position-registry.ts)

`position-registry.json` shows margin `MARA` and `CLSK` from **2026-07-02** still marked `OPEN` (no `closedAt`), four sessions later. Margin (`5WI88116`) liquidates all positions daily, so these cannot be open — their close-back was never written. (Cash `EOSE` OPEN from 07-02 is legitimate; cash holds overnight.) If any downstream logic trusts the registry as ground truth (sizing, do-not-touch, dedupe), it's reading phantom holdings.

**Fix direction:** reconcile the registry against live broker positions at cycle start — prune entries the broker no longer reports (or write `closedAt` when a close fills, whichever the writer currently misses). Add a startup log of tracked-but-not-held entries.

*New. Correctness. Investigate whether any consumer trusts stale entries before deciding severity.*

---

### 12. Day-report writer is dead — `data/day-reports/*.ndjson` frozen at June 30

**File:** [src/bot/record-day-report.ts](src/bot/record-day-report.ts), [src/bot/day-report-store.ts](src/bot/day-report-store.ts)

Both day-report files carry **June-30** timestamps and null fields — nothing written since. Either the writer regressed, or day-reports were superseded by the ledger and should be removed to avoid a misleading "empty report."

**Fix direction:** decide the intent. If day-reports are meant to summarize the day, wire `record-day-report` back into the cycle (it may have been dropped in a refactor). If the ledger + `getDayTrend` replace it, delete the store and its callers.

*New. Bug or dead-code — resolve which.*

---

### 13. Ledger entry-side enrichment is never populated

**File:** [src/bot/pnl-ledger.ts](src/bot/pnl-ledger.ts)

Every ledger row has `entrySpreadPct: null` and `gateScoreAtEntry: null`. The close-side capture is complete (`realizedPnlDollars`, `gateScoreAtClose`, spread at cycle, DTEs), but the entry-side context isn't backfilled. This blocks the periodic-review join in OPERATIONS §6 ("do high-boolean *entries* actually outperform?") and any "did we enter at a bad spread?" analysis — which today's WEN loss makes urgent.

**Fix direction:** capture entry spread and gate score into the registry at open, and copy them onto the ledger row at close (the registry is the natural carrier since it already spans open→close).

*New. Adjacent to items 9 and 11. Unlocks entry-quality attribution.*

---

## Rollup

13 items, all evidence-backed. Suggested priority for the STATUS.md AFTER-MONDAY bucket:

- **Now (don't wait for the review):** #6 dxLink session hygiene, #11 registry leak (correctness).
- **Next (this week):** #2 liquidity floors + #1 tighter entry spread (the −$160 lesson), #10 pull-script, #8 notify breadcrumb, #9 close taxonomy.
- **Tune with more data:** #3 dip-boost metric, #4 alloc-multiple bound, #5 concentration backstop, #13 entry enrichment (enables the attribution), #12 day-report decision, #7 streamer reconnect.
