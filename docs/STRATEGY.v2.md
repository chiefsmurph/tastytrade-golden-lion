# Silver Lynx — Trading Strategy (V2)

**Status:** current as of 2026-07-14. This is the authoritative, top-to-bottom
description of how the engine decides what to trade, how much, and when. It
supersedes the scattered mechanics buried across `docs/improvements/*` and
`docs/plans/*` (those remain useful as the *why-we-changed-it* history; this is
the *how-it-works-now*).

All times are **Pacific (America/Los_Angeles)** — the box clock is pinned there
(`isRegularSessionByLocalClock`, [liquidity-gate.ts:79-93](../src/strategy/liquidity-gate.ts#L79-L93)).
The regular options session is 06:30–13:00 PT.

Exact thresholds below are the **in-code defaults**; every one is an `.env`
override (see §12). Where production runs a non-default value, it is called out.

---

## 1. Philosophy

Silver Lynx is an execution *control plane*, not a signal generator. It takes a
universe of names (positions already open, plus an optional external signal
feed) and, every N minutes during market hours, answers three questions per
position group:

1. **Should this position be closed?** (hard risk / profit capture)
2. **If not, how much more of it do we want?** (a target exposure %)
3. **What exact contract and at what price do we buy to get there?**

Everything is deterministic and logged. Every decision appends a structured
NDJSON record to `data/` for after-action review. The bot degrades gracefully
when the signal feed is absent — it still manages risk and allocation from
position data alone.

---

## 2. The two-account model

Two Tastytrade accounts run side by side with deliberately different behavior.
(Account→type mapping is broker-confirmed and lives in config; the repo `.env`
is dev-only and marks cash read-only.)

| | **Margin** | **Cash** |
|---|---|---|
| Contract | **OTM** calls, delta-targeted to `0.35` | **ITM** calls (overnight delta hold) |
| DTE target | capped at `STRATEGY_MARGIN_MAX_TARGET_DTE` (7) | floored at `STRATEGY_CASH_MIN_TARGET_DTE` (7) |
| No-buy cutoff | **12:30 PM** | **1:00 PM** |
| EOD | **liquidates everything** at 12:50 PM (`EOD_ARMED_MINUTE`) | holds overnight |
| Entry spread ceiling | tighter (prod `0.10`) — it pays the spread twice (entry + forced exit) | shared gate (default `0.30`) |
| Gate multiplier | `1.33×` the cash gate | base |
| Hard gate | requires feed `willBuy` | requires `holdScore ≥ 0.45`, `isOvernightEligible`, no `crashRegime` |

The asymmetry is the whole point: margin is forced flat intraday, so it can only
justify names that trade well *right now*; cash can wait for a fair exit, so it
tolerates wider spreads and holds delta overnight.

Cross-account coupling runs one direction primarily: the **cash** position's
drawdown and the feed signals drive **margin seeding** (§11), and margin's
fill-level drives cash seeding back.

---

## 3. The run cycle (end to end)

Each `runCycle` (scheduler: `BOT_RUN_ON_SCHEDULE`, interval `BOT_RUN_INTERVAL_MS`)
executes this sequence. See `src/bot/run-cycle-context.ts` (snapshot build) and
the `src/bot/actions/` executors.

1. **Pull state** — balances, positions, session status, cached secret signals.
2. **Build time-of-day targets** — DTE, exposure %, and bid/mid/ask route weights
   by smooth interpolation over the clock (§4).
3. **Evaluate each position group** → `MANAGE_ALLOCATION` or `CLOSE_POSITION`
   via the circuit breakers (§6).
4. **Apply the position gate** — scale each group's target exposure by the signal
   tier, quality factor, and hard gates (§7).
5. **Generate the order plan** — size by available capital and route weights;
   pick the contract (§8).
6. **Execute in order**: close orders → allocation buys → overnight reductions →
   cross-account seeds (§11).
7. **Append** a structured NDJSON run record.

Only during a live regular session — extended-hours sessions are never treated
as open.

---

## 4. Time-of-day execution targets

Built in `getTimeOfDayExecutionTargetsForMinute`
([evaluate-trading-strategy.ts:234-328](../src/strategy/evaluate-trading-strategy.ts#L234-L328))
by piecewise-linear interpolation (`blendBySchedule`). After each account's
no-buy cutoff, **all four values are forced to 0**.

### DTE schedule (raw, before per-account clamp)

| Time | Raw DTE |
|---|---|
| 06:30 | 30 |
| 09:00 | 25 |
| 10:00 | 20 |
| 11:00 | 14 |
| 11:30 | 7 |

- **Margin:** `min(raw, 7)` → effectively **7 DTE all day**.
- **Cash:** `max(raw, 7)` → **~30 DTE in the morning, easing to 7** by 11:30.

### Exposure schedule (fraction of account deployed to the strategy)

Morning-weighted since 2026-07-12 — margin must be flat by ~12:55, so early buys
are the only ones with runway; margin ramps to full by 10:30.

| Time | Margin | Cash |
|---|---|---|
| 06:30 | 0.60 | 0.55 |
| 09:00 | 0.80 | 0.70 |
| 10:00 | — | 0.80 |
| 10:30 | **1.00** | — |
| 11:00 | — | 0.90 |
| 12:45 | — | **1.00** |

This is the *account* target; each position group's slice is then scaled by its
gate (§7) and normalized across groups.

### Route weights (how the buy order is split across bid/mid/ask)

| Time | bid | mid | ask |
|---|---|---|---|
| 06:30 | 0.70 | 0.20 | 0.10 |
| 09:00 | 0.50 | 0.30 | 0.20 |
| 10:00 | 0.33 | 0.33 | 0.33 |
| 11:00 | 0.20 | 0.30 | 0.50 |
| 11:30 | 0.00 | 0.25 | 0.75 |
| tail (12:30/cutoff) | 0.00 | 0.15 | 0.85 |

Early = patient (rest at the bid); late = aggressive (chase toward the ask),
because time to get filled is running out. Ask weight is additionally capped by
position size (`applyPositionSizeWeightCaps`): ≤15% size → max 0.50 ask, ≤30% →
0.75, else 1.00, with the trimmed weight pushed into mid.

---

## 5. Position grouping & evaluation

`src/bot/evaluate-position.ts` groups raw positions by **`UNDERLYING::side`**
(e.g. `RUM::call`). For each group it computes:

- bid / mid / ask **return %** vs the **weighted-average fill (WAF)** cost basis,
- unrealized P&L, DTE, quantity-weighted average fill.

**Returns are bid-based by default** for risk decisions: `currentReturn =
(currentBidPrice − WAF) / WAF`. Tune stops against what the position is worth *at
the bid*, not the midpoint — that's what you can actually exit into.

> **Caveat, measured 2026-08-08.** On this book the bid is a *biased* estimator,
> not merely a conservative one, and the bias is account-shaped (mid-minus-bid gap:
> cash 16.7pp, margin 7.6pp). Both circuit breakers that key off `currentReturn`
> now take a second, midpoint-based condition on top of the bid one — the stop must
> be **confirmed** by the midpoint (§6b) and the take-profit may **also** be
> satisfied by it (§6c). The basis is unchanged; these are extra conditions.

`evaluate-position.ts` is also where the per-cycle stop-persistence streak (§6d) is
read and written, keyed per account + group key.

---

## 6. Strategy state machine (circuit breakers)

`evaluateTradingStrategy`
([evaluate-trading-strategy.ts:154-224](../src/strategy/evaluate-trading-strategy.ts#L154-L224))
runs these gates **in order**; the first match wins:

1. **Margin EOD liquidation** — at/after **12:50 PM** (`EOD_ARMED_MINUTE`),
   margin returns `CLOSE_POSITION` (urgent, chases fast and crosses to the bid).
   Armed at 12:50 not 12:55 so a late-starting cycle still fits a full urgent
   tick-chase before the 1:00 PM close. **Options only** — the close-instrument
   guard (§6e) withholds the order for a non-option position.
2. **Take-profit** — if bid-return ≥ the **dynamic profit target**, close.
   The target decays linearly **0.40 at 06:30 → 0.07 at 12:55**
   (`getDynamicTakeProfitTarget`): grab 40% early, but by afternoon take whatever
   7%+ you can before EOD. A **midpoint** path can also satisfy it — see §6c.
3. **Cooldown** — < 10 minutes since this group's last action → hold (no new
   order this cycle).
4. **Intraday stop** — *before* the account cutoff, if bid-return ≤ **−30%**
   (`STRATEGY_INTRADAY_STOP_LOSS_PCT`), close (urgent). Requires the **midpoint**
   to confirm (§6b) and the trigger to **persist** across cycles (§6d).
5. **EOD stop** — *at/after* the cutoff, if bid-return ≤ **−10%**
   (`STRATEGY_EOD_STOP_LOSS_PCT`), close (urgent). Never consults the midpoint,
   and is never gated by persistence.
6. Otherwise → **`MANAGE_ALLOCATION`** (proceed to sizing/buying).

> **Known coupling:** the entry spread ceiling and the bid-based −30% stop
> interact — a position entered near the spread limit can be born close to
> triggered. See [project_stop_loss_spread_coupling] in memory.

### 6b. Intraday stop: midpoint confirmation — *added 2026-08-08, **default ON***

`STRATEGY_STOP_LOSS_REQUIRE_MID_CONFIRM` (**default `true`** as of 2026-08-08; it
shipped `false` the same day and was promoted on the second window below) adds a
second condition to gate 4 only: the midpoint return must ALSO be ≤
−`STRATEGY_STOP_LOSS_MID_CONFIRM_PCT` (default **20**, clamped to the intraday
floor). It is an extra condition on the trigger, **not** a change of basis — the
floor is still read against the bid.

**What promoted it (2026-07-17 → 08-07).** The stop family is the bot's entire
loss: stop-loss (n=28) returned **−21.0%** and eod-stop (n=12) **−13.7%**, together
more than the whole net loss of the book, while every other exit class combined was
positive (take-profit n=8, **+20.4%**). And the triggers are not describing the
positions — **15 of 34 stops fired while the position was flat or UP on the offer**,
the bot's own fills came in **+14.5pp of entry better than the trigger bid in 20 of
25 cases**, and **15 of 17 intraday stops had a midpoint above −30%**. A −30% bid
stop is roughly a −15% stop in executable terms. IOVA 2026-08-03: the midpoint sat
between +2.7% and +12% all day, one cycle printed a −53.3% bid against a +68% ask,
the stop fired, and it **filled at +6.4%** — a winner sold on a phantom bid.

At the default 20% floor this defers exactly the **6** demonstrably-wrong stops in
that window (CNH, TDOC, IOVA, SG, AUR, PTON) and still fires the **11** real ones,
median realized **−29.6%**. **Do NOT raise it to 25**: that defers 11 of the 17,
including genuinely dead positions at a −22% midpoint.

The midpoint is **not truth either**, and the case for this gate is not that it
predicts better — TDOC 2026-07-30 showed a −5.8% midpoint and booked −25.0%. The
argument is narrower: *stop triggering on a number the position cannot transact at.*

**Not the entry spread gate.** Stopped positions were ENTERED at a median 9.6–13.3%
spread and only 3 of 32 were near the 30% ceiling — the spread blows out AFTER
entry. That hypothesis is measured and dead; do not re-tighten the entry gate on it.

**Why.** Over every close in the run ledger 2026-07-06 → 2026-08-07 (n=80 unique
closes, 34 of them stops) the realized fill came in a median **8.2pp of entry
ABOVE** the bid the stop triggered on (mean +14.5pp) and 2.7pp BELOW the midpoint;
median absolute error against realized was 11.6pp for the bid and **5.4pp** for the
midpoint. The bid is biased, not merely noisy — and the bias is account-shaped
(mid-minus-bid gap: cash 16.7pp, margin 7.6pp), so one shared floor trips the cash
book at roughly half the drawdown it trips margin at. **22 of the 25** intraday
stops in the window (cash 21 of 24) were not under −30% at the midpoint. Limit
case: PTON 2026-08-07 stopped on a −63.05% bid against a +136.45% ask (145.9%
spread) and realized −5.4%.

**Why a confirmation rather than a basis switch.** A pure mid-basis stop at the
same floor is the same rule as "bid AND mid both under the floor" (mid ≥ bid on any
uncrossed quote) and fires on only **3 of 25**, deferring 22 whose median realized
was −19.2% — it would sit through genuinely broken positions. A spread ceiling on
the trigger discriminates worse: capping at 50% defers 11 with median realized
−12.1%. The separate, shallower mid floor fires on **16 of 25** and defers 9 whose
median realized was −7.1%.

Deferral returns `MANAGE_ALLOCATION` with `suppressAdds: true` — a quote the stop
was just told not to trust must not be averaged down into either. Every unusable
quote (one-sided, crossed, no cost basis) **fires** the stop: the confirmation may
only ever suppress on evidence.

**Known cost, in the data:** TDOC 2026-07-30 showed a −5.8% midpoint and booked
−25.0%. That is 1 of the 9 deferrals in the window. Scope is deliberately the
intraday floor only — the EOD floor has n=9, a shallow floor where the same gap
means something different, and deferring an exit minutes from the close is a
materially worse trade than deferring one at 9am.

### 6c. Take-profit: the midpoint path — *added 2026-08-08, **default ON***

`STRATEGY_TAKE_PROFIT_ALLOW_MID` (**default `true`**) lets gate 2 also fire when the
**midpoint** clears the dynamic target by `STRATEGY_TAKE_PROFIT_MID_MARGIN_PCT`
(default **5**pp). The bid path is unchanged.

**Why.** The take-profit reads the same bid the stop does, so the same wide spreads
that make the stop fire early make the target fire late or never. Over 2026-07-17 →
08-07, across 14 symbol-days, **158 cycles sat above the dynamic target at the
MIDPOINT while the bid had not reached it, versus 5 cycles where the bid
triggered.** SGML finished 2026-08-07 at a +22.3% midpoint and never sold. Fixing
only the loss side of a bid-based engine leaves the win side censored — the bid stop
and the bid target are the same measurement error with opposite signs.

**Executability**, which is the whole design constraint. A take-profit close is
NON-urgent, so `getCloseStartPrice` posts it at the **ask** and `getSellEdgePrice`
walks it down to the **bid** over up to 10 rungs — the bid is therefore the
worst-case fill. Triggering on a midpoint the position cannot transact at would just
start a chase down, which is the exact mistake being fixed on the stop side. Two
guards, both reusing machinery that already exists:

- **The bid must be at or above breakeven.** An invariant, not a knob: a close
  classified `take-profit` must never be able to book a loss. This is also what
  keeps the phantom quotes out — PTON's −63.05% bid against a +136.45% ask has a
  hugely positive midpoint and must never be sold into.
- **The close-side spread gate is left to do its job.**
  `shouldSkipClosePositionForMorningSpread` only waives its ceiling for BID
  take-profits and urgent closes, so a mid-triggered close on a genuinely unusable
  spread is **skipped** and the position held another cycle. No fill beats a bad
  fill when nothing forces the exit.

Both bases emit the same `Profit target reached (…)` prefix, because the P&L ledger
classifies closes by that prefix (`classifyCloseDecision`); the tail names the basis
so the two stay separable in the run history. The scaled-runner target (§6a) is
still read on the bid — deliberately out of scope.

### 6d. Intraday stop: persistence across cycles — *added 2026-08-08, **default ON***

`STRATEGY_STOP_LOSS_PERSIST_CYCLES` (**default 2**; `1` restores fire-on-the-first-
print) requires the gate-4 trigger — bid floor cleared *and* midpoint confirmed — to
hold on the immediately preceding **cycle** of the same group before it closes.

**Why.** The bad triggers are single-print artifacts, not descriptions of the
position. **5 of the 5 stops with full-day quote history fired on ONE cycle out of
the 26–100 cycles that position was held**, on days whose median bid return was only
−10% to −23% — the stop is behaving as a max-of-day sampler on a noisy quote series.
**15 of 21 stops fired in the first or last 30 minutes**, where the median spread was
57% versus 24.5% midday. One extra observation costs ~one cycle (~4 min) of delay on
a real stop and removes the artifacts.

- **State** lives in
  [stop-persistence-store.ts](../src/bot/actions/stop-persistence-store.ts), keyed
  per **account + `UNDERLYING::side`** (cash and margin routinely hold the same
  underlying; a symbol-only key would let one book's noise arm the other's stop) and
  stamped with the cost basis + cycle clock. A streak is ignored when the row is
  older than the streak window (restart / overnight / re-open) or when the cost
  basis has drifted (a re-entry). Repeat evaluations *inside* one cycle re-affirm
  without advancing — `getPositionEvaluations` runs 5-6 times per cycle
  (run-cycle-context ×3, run-cycle-seed ×2, allocation-budget). Both sides of the
  counter enforce that: the write refuses to advance a streak twice inside
  `getStreakAdvanceMinMs`, and the read (`getObservedStopCycles`) returns a count
  that already INCLUDES the current cycle, so no caller can reconstruct it with a
  `+ 1` and count the same cycle twice. They share one `isSameCycleAsRow`
  predicate deliberately — when they disagreed, the gate delayed by one
  *evaluation* rather than one cycle and the whole feature was a no-op.
- **Reset** is immediate and total: the first evaluation where the trigger does not
  hold deletes the row, so confirmation is genuinely consecutive. A mid-confirmation
  deferral does **not** count as held, so a phantom bid cannot arm a stop over time.
- **While waiting**, the group returns `MANAGE_ALLOCATION` with `suppressAdds: true`.
- **Opening cycle:** a position on its first cycle has no predecessor and therefore
  **cannot stop**. Two stops in the window (AUR 2026-08-06, PTON 2026-08-07) fired on
  their opening cycle with no history at all — that is precisely what this prevents.
- **Collapse bypass:** `STRATEGY_STOP_LOSS_PERSIST_BYPASS_PCT` (default **45**, i.e.
  1.5× the floor, clamped to ≥ 1.25× the floor) fires immediately when the bid AND
  the midpoint are both at or below it. Requiring the midpoint is what makes it safe
  to arm. On the measured window it fires on **zero** stops — tail insurance for a
  real gap-down, not a knob tuned to recover the sample.
- **Inert without a cycle context.** The execution-time re-check in `closePosition`
  and the contract-selection probe re-run the engine with no store; an active gate
  there would silently cancel a stop the cycle had already confirmed.

### 6e. Close-instrument guard — *added 2026-08-15, **default ON***

**The bot may only close what it is capable of opening.** All three buy paths
hard-code `"Equity Option"`
([manage-allocation.ts:406](../src/bot/actions/manage-allocation.ts#L406),
[spray-buy.ts:180](../src/bot/actions/spray-buy.ts#L180),
[seed-symbol.ts:910](../src/bot/seed-symbol.ts#L910)), but
[`buildClosingOrderPayload`](../src/bot/actions/order-utils.ts#L63-L100) reads the
instrument type off the **position**. The bot could therefore only ever *open* an
option while faithfully *selling* whatever it found held — and the margin EOD
sweep (gate 1) repeatedly liquidated the owner's hand-bought **shares**.

This cannot be fixed in this section. `evaluateTradingStrategy` receives
`PositionMetrics` ([:306-312](../src/strategy/evaluate-trading-strategy.ts#L306-L312))
— bid, ask, weighted average fill, two timestamps — so the instrument type never
reaches the strategy layer at all. Equity nonetheless enters as a first-class
group: a share lot has no C/P suffix, so
[evaluate-position.ts:71-72](../src/bot/evaluate-position.ts#L71-L72) keys it
`TICKER::none` and every gate above treats it exactly like an option group.

The guard therefore lives at order **dispatch**
([close-instrument-guard.ts](../src/bot/close-instrument-guard.ts)), applied at
all three sites that can send a closing order:
[`execute-position-evaluations.ts`](../src/bot/execute-position-evaluations.ts)
(gates 1–5 and scale-out),
[`overnight-position-reduction.ts`](../src/bot/overnight-position-reduction.ts),
and the operator IPC close
[`close-symbol-position.ts`](../src/bot/close-symbol-position.ts).

- **Not an implicit do-not-touch.** Both would stop the sale, but do-not-touch
  groups are dropped from the execution-path exposure sums
  (`run-cycle-context.ts` → `buildInitialBudget`, and the same filter in
  `execute-position-evaluations.ts`), so the bot would start sizing its option
  buys as though that capital were free. Guarding at dispatch keeps equity in the
  exposure denominator — the capital *is* committed.
- **A missing `instrument-type` falls back to the symbol shape**, not to a
  blanket block: a well-formed OCC contract symbol still closes, so an absent
  broker field can never silently disarm a live stop.
- **One non-openable leg withholds the whole group** — the bot cannot sell only
  the option half of a mixed pile.
- Every withheld order logs one JSON line tagged
  `"token":"CLOSE_INSTRUMENT_SUPPRESSED"` with the ticker, group key, instrument
  type, dispatch site, requesting branch and quantity.
- Kill switch `BOT_CLOSE_ONLY_OPENABLE_INSTRUMENTS=false` restores the previous
  behaviour exactly.

**Future:** when the planned SMS path lets the owner direct the bot to *buy*
shares, this must become provenance-aware
([position-provenance.ts](../src/bot/position-provenance.ts)) rather than simply
widening the openable set — an owner-directed share lot is still his exit.

The **entry** half of the same hole — an equity group attracting option *buys* —
is §8c, and it reuses this section's `isOpenableInstrument` predicate rather than
restating it.

### 6f. Reading the exits in the log — token `EXIT_GATE_DECISION` — *added 2026-08-15*

§6b, §6c and §6d shipped into two files that emitted **nothing** —
[evaluate-trading-strategy.ts](../src/strategy/evaluate-trading-strategy.ts) and
[stop-persistence-store.ts](../src/bot/actions/stop-persistence-store.ts) contained
zero log statements between them — so for a week the rebuild could not be verified
in production at all. When nine stops fired 08-12/13 at −34% to −39% instead of
snapping at the −30% floor, that reading is equally consistent with a persistence
gate doing its job and with the price simply gapping through; nothing distinguished
them.

Every intraday-stop and take-profit verdict now emits **one JSON line** carrying the
token `EXIT_GATE_DECISION`
([exit-decision-log.ts](../src/strategy/exit-decision-log.ts)):

```
pm2 logs tastytrade-silver-lynx --lines 5000 --nostream | grep EXIT_GATE_DECISION
```

**Observability only — no gate reads any of it, and no threshold moved.**

| field | answers |
|---|---|
| `gate` | `intraday-stop` or `take-profit` |
| `decision` | `FIRED` or `WITHHELD` |
| `withheldBy` | `mid-confirm` (§6b) · `persistence` (§6d) · `cooldown` (gate 3) · `bid-below-breakeven` (§6c) |
| `bid` / `ask` / `mid` / `weightedAverageFill` | the quote, so the verdict is re-derivable by hand |
| `bidReturnPct` / `midReturnPct`, `bidFloorPct` / `midFloorPct`, `midConfirmed` | the §6b comparison, both sides |
| `observedCycles` / `requiredCycles` | the §6d streak, **already inclusive of the current cycle** |
| `stopTriggerHeld` | whether this evaluation ADVANCES the streak or RESETS it |
| `persistenceActive` | `false` on the `closePosition` re-check and the chain probe, where §6d is inert |
| `collapseBypassed` | the `STRATEGY_STOP_LOSS_PERSIST_BYPASS_PCT` escape hatch fired |
| `basis` / `targetPct` / `midTargetPct` | for a take-profit: bid or mid, and the target it cleared |

**Silence is unambiguous by design.** A withheld exit logs as loudly as a fired
one, so "no line" means one thing: the bid never crossed the floor while the stop
window was open. That is also why the **cooldown** short-circuit (gate 3, which
returns before the stop is consulted at all) emits a line when the bid *is* under
the floor — a cooldown standing in front of a live trigger would otherwise look
identical to a healthy position, and it silently resets the streak.

Two supporting notes:

- `PositionMetrics` gained one **optional** field, `groupKey`, purely so a line can
  name the position it is about. Nothing reads it; every decision in the engine is
  still a function of bid, ask, WAF and the clock.
- The gate order is unchanged, so an exit can be pre-empted before it is ever
  evaluated: **EOD liquidation → take-profit → cooldown → intraday stop**. Only the
  cooldown pre-emption is logged (above); the post-cutoff **EOD stop** (gate 5) has
  no gate that can withhold it and is deliberately out of scope here.
- The close-instrument guard (§6e) sits **downstream** of every verdict here, at
  order dispatch. A `FIRED` line therefore means the strategy decided to close,
  not that an order went out — pair it with `CLOSE_INSTRUMENT_SUPPRESSED` when a
  close is missing from the fills.

### 6a. Partial take-profit + runner (scale-out) — *added 2026-08-04, cash-only*

Optional, **default OFF** (`STRATEGY_PARTIAL_SCALE_OUT_ENABLED`). When enabled it
replaces the all-or-nothing take-profit (gate 2) for the **cash** account only
(cash holds overnight, so "let the rest run" is real; margin flattens at 12:50):

- **First trip to the target** → close only `STRATEGY_SCALE_OUT_FRACTION`
  (default **50%**) instead of 100%, and mark the group *scaled* in a persisted
  store ([scale-out-store.ts](../src/bot/actions/scale-out-store.ts), keyed per
  account + `UNDERLYING::side`, WAF-stamped as a re-entry guard).
- **The runner** (already scaled) ignores the base target and instead:
  - closes at a **higher target** = dynamic target ×
    `STRATEGY_SCALE_OUT_RUNNER_TARGET_MULTIPLE` (default **1.5×**), or
  - closes (urgent) on a **breakeven ratchet** if bid-return drops **≤ 0%** —
    never let a winner become a loser, or
  - otherwise **holds and suppresses further adds** so the runner just rides
    (this also keeps its WAF — and the scaled flag — stable).
- The store is cleared on a full close and pruned each cycle to the set of open
  groups, so a re-entry starts fresh. The execution-time recovery re-check in
  `closePosition` is passed the same scale-out context, so a runner's
  breakeven/target exit isn't mistaken for a "recovered" position and skipped.

Rollout: build is default-off; enable via the server `.env` flag after
validating expectancy on the live cash book. Instant kill switch: set
`STRATEGY_PARTIAL_SCALE_OUT_ENABLED=false` and restart.

---

## 7. Signal gating — the position gate

The optional external feed (Socket.IO, `src/strategy/secret/`) supplies a
`SecretSourcePosition` per ticker: buy weights, boolean thesis signals,
daytrade scores, and a consolidated rollup. `computePositionGate`
([position-gate.ts:241-315](../src/strategy/position-gate.ts#L241-L315)) turns
that into a `maxTargetPct` — the ceiling fraction of the account this one name
may occupy.

### 7a. Thesis score (0–10, +2 icing)

`THESIS_MAX = 10`. `countGoodBooleans`
([position-gate.ts:199-215](../src/strategy/position-gate.ts#L199-L215)) picks a
source in preference order:

1. **Manual thesis** — `manualThesisCount / manualThesisMax` rescaled to 0–10
   (the richer, hand-curated score).
2. **buyFraction** — the coarse rollup, `0→1.0` across the thesis flags, rescaled
   to 0–10.

**willBuy icing:** the feed only pushes `buyFraction` above 1.0 (up to 1.25)
when `willBuy` is true, which maps to **+2** on top. Icing is never *required*
for full marks. No rollup at all → score 0 (unknown scores nothing).

### 7b. Signal tiers → base `maxTargetPct`

Two orthogonal confirmations:
- **crossAccountYes** — the *other* account's position is down past a
  time-scaled dip threshold (`STRATEGY_CROSS_ACCOUNT_YES_DOWN_PCT`, 2× strict at
  open → 1× lenient by 1pm).
- **basicStockYes / strongStockYes** — from `isQualityToBuy` and
  `percentOfBalance` crossing time-scaled bars. (`daytradeScore` legs removed
  2026-07-19: the forward-return backtest showed dt −70..−150 is a death
  valley — win 16–29% — and the dt<−100 leg granted the strongest tier inside
  it. daytradeScore is telemetry-only now.)

| Condition | base maxTargetPct |
|---|---|
| crossAccountYes **and** strongStockYes | **0.35** |
| crossAccountYes **and** basicStockYes | **0.25** |
| strongStockYes alone | 0.15 |
| crossAccountYes alone | 0.15 |
| basicStockYes alone | 0.10 |
| none | 0 |

Then a per-point boost: `+ goodBooleanScore × 0.03`, capped at 1.0.

### 7c. Per-account scaling & hard gates

- **Margin** ([run-cycle-context.ts:473-558](../src/bot/run-cycle-context.ts#L473-L558)):
  `marginMaxTargetPct = willBuyBlocked ? 0 : gate.maxTargetPct × 1.33 × qualityFactor`.
  `willBuyBlocked` = feed has this ticker but `willBuy !== true`.
- **Cash** ([run-cycle-context.ts:561-596](../src/bot/run-cycle-context.ts#L561-L596)):
  `cashGateMaxTargetPct = hardBlocked ? 0 : gate.maxTargetPct × qualityFactor`,
  where hard-blocked = `holdScore < 0.45` **or** `isOvernightEligible === false`
  **or** `crashRegime`.

### 7d. Quality factor (buyMult × gateMult) — *added 2026-07-13*

Both accounts multiply their gate ceiling by a signal-quality factor:

```
qualityFactor = max(0.5, min(1.0, (buyMult × gateMult) / 4.0))
```

- `buyMult` = pre-crush recommendation strength; `gateMult` = gate favorability
  (full = 2.0), so the product tops out at 4.0 → factor 1.0.
- Floored at **0.5** so a cleared-gate position is never crushed to nothing.
- Falls through to **1.0** when either field is absent (backwards-compatible with
  older feed payloads).

The gate result feeds sizing; the target exposure the executor chases is
`finalTargets.targetAccountExposure × (margin|cash)GateMaxTargetPct`.

### 7e. Margin auto-seed thesis gate — *REMOVED 2026-08-08*

Feed-driven **margin auto-seeds** (`src/strategy/secret/secret-auto-seed.ts`,
distinct from the cross-account seeding in §11) used to require the feed's full
thesis — `thesisCount ≥ thesisMax`, observed at any point that day via a sticky
memory — on top of a live `willBuy`. **That requirement is gone. `willBuy` alone
is the signal condition now**
([`evaluateMarginSeedThesisGate`](../src/strategy/secret/secret-auto-seed.ts)).

Why: over 8 instrumented sessions (07-22, 07-23, 07-24, 07-27, 08-04 → 08-07),
measured directly off the `secret-auto-seed-margin-sticky-block` line, the gate
ran **backwards**.

| Evidence | Result |
|---|---|
| Blocked vs passed, universe-excess on the **underlying** to the margin EOD line (12:55 PT) | blocked beat passed by **+2.35pp** |
| 90% day-clustered CI | **[-3.75, -1.00]** — excludes zero |
| Drop-one-blocked-name / drop-one-day | −1.69…−2.56 / −1.56…−2.82 — sign never flips |
| Time-of-day confound | runs *against* the finding: blocked events are later (median 10:59 PT vs 08:40 PT), so a **shorter** window earned +1.71%. Time-matched +60m agrees in sign |
| Coverage | 13 of 41 distinct (day, symbol) `willBuy` candidates blocked **all day** |

Structurally the gate largely graded its own entry conditions: 3 of the 4 flags
behind `thesisCount` are upstream buy *preconditions* or the `buyWeight`
threshold, and `buyWeight` measured at +3bp forward return on the sibling stock
bot — i.e. no content.

**Caveat, stated plainly:** every number above is the *underlying's* move, not
option P&L. At the 15–30% option spreads this book pays, a 2% underlying move is
not automatically a win. The evidence is decisive against the gate's stated
purpose — name selection — not proof that the newly-admitted seeds print.

Unchanged by this: `willBuy` is still hard-required, and the downstream knife
brakes (`plateauScore ≥ SECRET_SEED_MIN_PLATEAU`, the add-governor,
`crashRegime`) still block. They are knife-shaped, not thesis-shaped.

**Revert without a deploy:** `STRATEGY_MARGIN_SEED_REQUIRE_FULL_THESIS=true`
re-arms the old gate exactly, block line included.

**Instrumentation (inverted, not deleted).** The block line that made the
measurement possible is replaced by a symmetric pair emitted at the same point,
for the same `willBuy` population, with the same fields plus `requireFullThesis`:

| Scope | Fires when |
|---|---|
| `secret-auto-seed-margin-thesis-relief` | seed proceeds, the **old gate would have blocked** it — the removal's own effect |
| `secret-auto-seed-margin-thesis-pass` | seed proceeds, the old gate would have passed it too — the mirror |
| `secret-auto-seed-margin-sticky-block` | thesis gate blocked the seed — only reachable with the revert flag on |

Relief-vs-pass is therefore a partition **by construction**: re-grading the
change next week needs no reconstruction from separate log families.

---

## 8. Contract selection & liquidity gates

Once a group is `MANAGE_ALLOCATION` with a positive target, `manage-allocation.ts`
asks the option-candidate pipeline for a contract.

- **Margin:** `strikeTarget: "otm"`, `targetDelta = 0.35`
  (`STRATEGY_MARGIN_TARGET_CALL_DELTA`).
- **Cash:** `strikeTarget: "itm"` (ITM for overnight delta).
- The ITM selector walks the closest-ITM-to-ATM strike outward by
  `STRIKES_AROUND_ATM = 2` (e.g. $10→$9→$8) and the pipeline takes the **first
  strike that passes** the gates — i.e. nearest-money-that-passes.

Three gates apply to every entry candidate:

1. **IV-rank gate** ([entry-filters.ts:15](../src/strategy/entry-filters.ts#L15)) —
   underlying `ivRank < STRATEGY_MIN_IV_RANK_PCT` (default **20**) →
   `skippedByIvGate`. IV rank is a property of the *underlying* (0–100, refreshed
   every 5 min), and it **moves through the day** — a name blocked at the open can
   clear later. This is an intentional entry filter, so **an IV skip never falls
   back** to another contract.
2. **Spread / liquidity gate** (`evaluateLiquidityGate`,
   [liquidity-gate.ts:133-193](../src/strategy/liquidity-gate.ts#L133-L193)) —
   `spreadPct ≤ maxAllowedSpreadPct`, where the ceiling is
   `min(accountCeiling, morningRamp)`:
   - shared `STRATEGY_MAX_OPTION_SPREAD_PCT` default **0.30**;
   - margin `STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT` (prod **0.10**);
   - **morning ramp** (`MORNING_SPREAD_THRESHOLDS`): 5% @06:30 → 10% @06:45 →
     15% @07:00 → 20% @07:15 → 25% @07:30 → 30% @08:00.
   - **Hard rule — graceful degradation:** unknown OI / volume / quote sizes
     *pass* with a note; never treat null as zero-liquidity (that once blocked
     every entry for months). Optional OI floor (`STRATEGY_MIN_OPEN_INTEREST`,
     default 0/off) and phantom-quote guard (off by default).

### 8a. Margin ITM fallback — *added 2026-07-14*

**Problem:** on low-priced illiquid names ($10 stock, $1-wide strikes), margin's
OTM delta-0.35 target lands on deep-OTM lottery strikes with dead ~100% spreads.
The tradeable liquidity lives ATM/ITM. Margin structurally never gets in.

**Fix** ([manage-allocation.ts:883-910](../src/bot/actions/manage-allocation.ts#L883-L910)):
when margin's OTM pick fails the spread/liquidity gate (**not** the IV gate),
retry with the ITM selector — nearest-money strike that passes the (still 10%)
margin ceiling. Gated on the signal reading as **high conviction**:

```
marginItmFallbackEligible = buyWeight > 280
```

(The `daytradeScore < -40` "HOLD" leg was removed 2026-07-19 — dip pain is
telemetry-only after the forward-return backtest.)

Momentum-flip names (weak on both axes) keep skipping rather than tying up
capital in an ITM contract they can't exit. Logged under scope
`manage-allocation-margin-itm-fallback`.

### 8b. Held-contract fallback + average-down guard — *guard added 2026-07-14*

When the fresh chain pick fails (and it's not an IV skip), the bot may re-buy the
**contract it already holds** (`getHeldContractFallbackCandidate`,
[manage-allocation.ts:547-634](../src/bot/actions/manage-allocation.ts#L547-L634)).
It picks the group's dominant holding, re-checks DTE and the same account-aware
spread gate.

This is the *only* path that scales into the illiquid ITM names §8a gets margin
into — so continued accumulation there rides this fallback, independent of the
entry conviction gate. To stop it from **averaging up**, a margin-only guard was
added: keep adding only while the held contract's **ask ≤ our weighted-average
fill** — average down, never up. Above our average, it skips with
`margin held add blocked: ask $X above our avg $Y (average down only)`. Cash's
overnight-hold accumulation is unguarded (different exit semantics).

> **Why price, not conviction:** we decided (2026-07-14) that we *do* want to keep
> averaging into a high-conviction ITM entry — but only down. Price-vs-average is
> the governor, so a fading intraday signal doesn't strand capital in an illiquid
> ITM position we can't exit, while a genuine dip still gets filled.

### 8c. Equity groups are not accumulation targets — *added 2026-08-15, **default ON***

`BOT_BUY_ONLY_OPENABLE_INSTRUMENTS` (**default `true`**). The first group-level gate
in `manageAllocationForGroup`: a group holding an instrument the bot could not have
opened itself is skipped before any chain lookup, quote or health call.

**The hole.** Every BUY path hard-codes `"Equity Option"` (`manage-allocation.ts`,
`spray-buy.ts`, `seed-symbol.ts`), so the bot can only ever open an option — but
equity enters the engine as a first-class position group. The owner hand-buys
**shares** in the margin account; a share lot has no C/P suffix, so §5 keys it
`TICKER::none`, and `getCandidateSide`
([manage-allocation.ts](../src/bot/actions/manage-allocation.ts)) defaults a sideless
group to `"call"`. His shares were therefore an accumulation target for the bot's
option buying on the same underlying. That `?? "call"` default is *correct* for an
option group whose symbols will not parse; the fix is to stop equity reaching it, not
to change it.

**Predicate — shared with §6e, not restated.** `isOpenableInstrument` /
`getNonOpenablePositions`
([close-instrument-guard.ts](../src/bot/close-instrument-guard.ts)) — the broker
`instrument-type` when present, otherwise the OCC symbol **shape**, so a missing
broker field can never silently reclassify a real option. One non-openable leg
withholds the whole group: the bot cannot buy half of a mixed pile. The exit guard
(§6e) and this entry guard therefore cannot drift apart; widening the openable set
moves both at once, which is the point.

**A skip, not a do-not-touch.** `BOT_DO_NOT_TOUCH_GROUPS` groups are dropped from
the execution-path exposure sums (`run-cycle-context.ts` filters
`actionableCompletedEvaluations` before `buildInitialBudget`), so marking equity
hands-off would make the bot size its option buys as though that capital were free.
Skipping at the allocation step keeps the equity in the exposure denominator, which
is correct — the capital is committed. The suppression is an ordinary
`placedOrder: false` skip with a reason, so it lands in run history, plus one
greppable line on the token `ALLOCATION_INSTRUMENT_SUPPRESSED` naming the ticker,
the instrument types, the quantity, and the side the old default would have bought.

**This changes sizing behaviour** — a group that used to attract buys no longer does.
`false` restores the previous behaviour exactly. It is the ENTRY twin of §6e; both
rest on the same invariant: *the bot may only act on an instrument it is capable of
opening.* §6e stops the bot selling the owner's shares; this stops it buying options
against them. Neither is redundant with `BOT_READ_ONLY_ACCOUNTS`: a read-only account
is an account-wide switch, while these are per-group and survive the account being
traded again.

---

## 9. Order routing & tick-chasing

`src/bot/actions/`:

- **`manage-allocation.ts`** (buys) — strike selection (above), quantity sizing
  by available capital, then routes the order across bid/mid/ask per the §4
  weights. No route pays the full spread instantly: **bid** rests at the bid,
  **mid** concedes at most a few ticks, **ask** starts at the midpoint and chases
  to the ask on a fast clock.
- **`close-position.ts`** (sells) — mid→ask aggressiveness, up to 10 tick-chase
  steps every 30s. Hard-risk closes (EOD liquidation, stop floors) are *urgent*:
  they chase fast and cross to the bid on the final tick. Take-profit closes keep
  the slow chase.

**Final-rung re-quote** (`STRATEGY_CLOSE_REQUOTE_BEFORE_FINAL_TICK`, default OFF).
Every price in the chase descends from the **cycle-start** bid/ask snapshot, and the
ladder then dwells 10s (urgent) to 30s (normal) per rung — so the rung meant to
guarantee the clear is routinely priced off a quote minutes old. Enabled, the chase
pulls one live quote immediately before its last rung ("last" = the move budget
running out, or the next step landing on the edge, whichever comes first) and
re-prices that rung. The refreshed edge is **monotone**: a sell edge may only move
DOWN, a buy edge only UP — chasing a market that ran away is the point, retracting a
concession already made would risk the unfilled hard-risk close the urgent path
exists to prevent. Any unusable answer (no quote, no bid, a throwing lookup) leaves
the stale ladder untouched.

Evidence: over the run ledger 2026-07-06 → 2026-08-07, **7 of 80** closes filled
BELOW the bid quoted at the deciding cycle (ERIC 0.350 → 0.200, WEN 1.075 → 0.650,
WEN 0.340 → 0.280, JOBY 0.182 → 0.160, ACHR 0.199 → 0.180, WEN 0.340 → 0.300,
WEN 0.900 → 0.800) for **126.6pp of entry**, and 4 filled above the quoted ask. Those
7 had a **median spread of 14.2%** and spanned 5 decision types and both urgency
classes — a staleness problem, not a wide-spread one, and no spread gate catches it.

---

## 10. IV environment

`src/core/market-metrics.ts` provides `ivRank` (0–100) and `impliedVolatility`
via `getUnderlyingIvMetrics(symbol)`, cached 5 minutes. Used only to gate entries
(§8). Because it's cached and market-driven, the same name can be blocked early
and tradeable an hour later — an IV skip is a *this-moment* filter, not a verdict.

---

## 11. Cross-account seeding

`src/bot/run-cycle-seed.ts`. Two symmetric flows, each firing only within the
seed window and only for groups that pass `isSeedEligibleEvaluation` — i.e.
`MANAGE_ALLOCATION` **and not** `suppressAdds`. A seed is an ADD, so the "hold,
don't add" verdicts (scaled runner §6a, mid-disputed stop §6b, stop awaiting
confirmation §6d) have to bind here too; before 2026-08-08 these passes only
checked `action`, so a group the local allocator was forbidden to touch could
still be averaged into from the far side of the book.

- **Margin ← Cash** (`maybeSeedMarginAccountFromCashAccount`): iterate cash
  evaluations; when a cash position is down (`askReturnPct < −minDownPct`) and
  still managing, seed the same name into margin. Thresholds scale by time of
  day, position age, and thesis score (`getScaledThresholds`). Seed price is
  capped at the cash WAF (`maxLimitPrice: cashFill`).
- **Cash ← Margin** (`maybeSeedCashAccountFromMarginAccount`): same shape, plus a
  **fill-ratio** factor — cash holds back while margin still has room to average
  down on its own, and gets more willing as margin approaches full deployment.
  Falls back to buying margin's exact held contract (≥ `CASH_SEED_HELD_FALLBACK_MIN_DTE`
  = 4 DTE) when no chain candidate fits or the pick is too expensive.

**Seed decision** (`getSeedDecision`, `src/strategy/seed-decision.ts`): a
loss-depth zone plus a thesis bar. Passes when the feed thesis is FULL
(`thesisCount ≥ thesisMax`, 4/4 today) **or** the manual score clears the
zone's bar. Seed-size multiplier by thesis score: `<3 → 1.0×`, `3-4 → 0.95×`,
`5-6 → 0.85×`, `7+ → 0.7×` (higher conviction → tighter/earlier).

`shouldSeedMarginFromBooleans` ([position-gate.ts:221-227](../src/strategy/position-gate.ts#L221-L227))
— the full-feed-thesis predicate — is still what `getSeedDecision` above accepts
as its FULL-thesis leg, and it still feeds the sticky day memory in
`secret-auto-seed.ts`. It is no longer a *block* on the feed-driven margin
auto-seed path: that gate was removed 2026-08-08, see §7e.

---

## 12. Configuration

All runtime config via `.env`; in-code defaults via `readEnvPct()` / `readEnvInt()`
/ `readEnvBool()`. Blank-but-present means "use the in-code default" — use
`readEnvBool(key, default)` for flags, **not** `toBooleanFlag(process.env.K ?? d)`,
which reads a blank `K=` as `false` and silently inverts any default-true flag.
Prefixes:
`CORE_` (infra/creds), `BOT_` (orchestration), `STRATEGY_` (trading logic),
`SECRET_` (signal feed).

Key knobs referenced above (default in parens):

| Var | Default | Meaning |
|---|---|---|
| `STRATEGY_MARGIN_TARGET_CALL_DELTA` | 0.35 | margin OTM delta target |
| `STRATEGY_MIN_IV_RANK_PCT` | 20 | entry IV-rank floor |
| `STRATEGY_MAX_OPTION_SPREAD_PCT` | 0.30 | shared spread ceiling |
| `STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT` | shared (prod 0.10) | tighter margin entry ceiling |
| `STRATEGY_INTRADAY_STOP_LOSS_PCT` | 30 | pre-cutoff bid-return stop |
| `STRATEGY_EOD_STOP_LOSS_PCT` | 10 | post-cutoff bid-return stop |
| `STRATEGY_STOP_LOSS_REQUIRE_MID_CONFIRM` | **true** | intraday stop also needs the midpoint (§6b) |
| `STRATEGY_STOP_LOSS_MID_CONFIRM_PCT` | 20 | that midpoint floor, clamped to the intraday floor |
| `STRATEGY_STOP_LOSS_PERSIST_CYCLES` | **2** | consecutive cycles the intraday trigger must hold (§6d) |
| `STRATEGY_STOP_LOSS_PERSIST_BYPASS_PCT` | 45 | bid+mid collapse floor that skips the streak (§6d) |
| `STRATEGY_TAKE_PROFIT_ALLOW_MID` | **true** | take-profit may fire on the midpoint (§6c) |
| `STRATEGY_TAKE_PROFIT_MID_MARGIN_PCT` | 5 | headroom over target that midpoint path needs |
| `STRATEGY_CLOSE_REQUOTE_BEFORE_FINAL_TICK` | false | re-quote before the chase's last rung (§9) |
| `STRATEGY_MARGIN_MAX_TARGET_DTE` | 7 | margin DTE cap |
| `STRATEGY_CASH_MIN_TARGET_DTE` | 7 | cash DTE floor |
| `STRATEGY_MARGIN_MAX_TARGET_MULTIPLIER` | 1.33 | margin gate scale-up |
| `STRATEGY_CROSS_ACCOUNT_YES_DOWN_PCT` | 10 | cross-account dip trigger (1pm-lenient) |
| `STRATEGY_MARGIN_SEED_REQUIRE_FULL_THESIS` | false | re-arm the removed margin auto-seed full-thesis gate (§7e) |
| `STRATEGY_GATE_STRONG_YES_MAX_TARGET_PCT` | 0.35 | top signal-tier ceiling |
| `STRATEGY_MIN_OPEN_INTEREST` | 0 (off) | optional OI floor |
| `BOT_BUY_ONLY_OPENABLE_INSTRUMENTS` | **true** | equity groups are not accumulation targets (§8c) |
| `BOT_RUN_ON_SCHEDULE` / `BOT_RUN_INTERVAL_MS` | — | scheduler |

The July-1 refactor renamed ~30 vars; the boot log warns on obsolete names
(`src/startup-config.ts`). See `.env.example` and the README env list.

---

## 13. Control surface & operations

- **IPC** (`src/ipc-server.ts`): a Unix-socket JSON server, 40+ commands
  (`{ id, command, args }` lines). Candidate discovery, health checks, order
  placement, cycle control, and debug introspection — with or without the
  scheduler. `ipc-client.js` is a reusable client. Useful debug commands:
  `strategy:getTopOptionCandidateForSymbol`,
  `strategy:debugSecretExecutionTargetForSymbol`,
  `strategy:getOptionHealthForSymbol`, `core:fetchOptionChainWithVolume`.
- **Deploy:** push, then on the VPS pull → build → restart (PM2 process
  `tastytrade-silver-lynx`, id 5). See [reference_server_deploy] in memory /
  `docs/OPERATIONS.md`.
- **Audit trail:** every cycle appends NDJSON to `data/`; per-decision scopes
  (`margin-position-gate`, `cash-position-gate`, `liquidity-gate`,
  `manage-allocation-candidate`, `manage-allocation-margin-itm-fallback`,
  `run-cycle-margin-from-cash`, …) make the reasoning grep-able.

---

## 14. What changed for V2 (2026-07-13 → 07-14)

- **Consolidated thesis rollup** — feed sends `buyFraction` / `manualThesisCount`
  / `manualThesisMax` per position; `THESIS_MAX` is now **10** (was 11), willBuy
  is **+2 icing**, never required for full marks. Legacy per-flag counting is
  gone.
- **Signal quality factor** — `buyMult × gateMult` scales the gate ceiling on
  both accounts (§7d).
- **Margin ITM fallback** — margin can reach tradeable ITM strikes on illiquid
  low-priced names, gated on `buyWeight > 280` (§8a; daytradeScore leg removed
  2026-07-19).
- **Average-down guard** — margin held-contract adds only fill while ask ≤ our
  average (§8b).
