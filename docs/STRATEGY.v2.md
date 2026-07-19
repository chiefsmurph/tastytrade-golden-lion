# Golden Lion — Trading Strategy (V2)

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

Golden Lion is an execution *control plane*, not a signal generator. It takes a
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

---

## 6. Strategy state machine (circuit breakers)

`evaluateTradingStrategy`
([evaluate-trading-strategy.ts:154-224](../src/strategy/evaluate-trading-strategy.ts#L154-L224))
runs these gates **in order**; the first match wins:

1. **Margin EOD liquidation** — at/after **12:50 PM** (`EOD_ARMED_MINUTE`),
   margin returns `CLOSE_POSITION` (urgent, chases fast and crosses to the bid).
   Armed at 12:50 not 12:55 so a late-starting cycle still fits a full urgent
   tick-chase before the 1:00 PM close.
2. **Take-profit** — if bid-return ≥ the **dynamic profit target**, close.
   The target decays linearly **0.40 at 06:30 → 0.07 at 12:55**
   (`getDynamicTakeProfitTarget`): grab 40% early, but by afternoon take whatever
   7%+ you can before EOD.
3. **Cooldown** — < 10 minutes since this group's last action → hold (no new
   order this cycle).
4. **Intraday stop** — *before* the account cutoff, if bid-return ≤ **−30%**
   (`STRATEGY_INTRADAY_STOP_LOSS_PCT`), close (urgent).
5. **EOD stop** — *at/after* the cutoff, if bid-return ≤ **−10%**
   (`STRATEGY_EOD_STOP_LOSS_PCT`), close (urgent).
6. Otherwise → **`MANAGE_ALLOCATION`** (proceed to sizing/buying).

> **Known coupling:** the entry spread ceiling and the bid-based −30% stop
> interact — a position entered near the spread limit can be born close to
> triggered. See [project_stop_loss_spread_coupling] in memory.

---

## 7. Signal gating — the position gate

The optional external feed (Socket.IO, `src/bot/secret/`) supplies a
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

---

## 10. IV environment

`src/core/market-metrics.ts` provides `ivRank` (0–100) and `impliedVolatility`
via `getUnderlyingIvMetrics(symbol)`, cached 5 minutes. Used only to gate entries
(§8). Because it's cached and market-driven, the same name can be blocked early
and tradeable an hour later — an IV skip is a *this-moment* filter, not a verdict.

---

## 11. Cross-account seeding

`src/bot/run-cycle-seed.ts`. Two symmetric flows, each firing only within the
seed window and only for `MANAGE_ALLOCATION` groups:

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

Margin-from-booleans seeding requires the **full** feed thesis
(`shouldSeedMarginFromBooleans`, [position-gate.ts:221-227](../src/strategy/position-gate.ts#L221-L227)).

---

## 12. Configuration

All runtime config via `.env`; in-code defaults via `readEnvPct()` / `readEnvInt()`
/ `toBooleanFlag()`. Blank-but-present means "use the in-code default." Prefixes:
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
| `STRATEGY_MARGIN_MAX_TARGET_DTE` | 7 | margin DTE cap |
| `STRATEGY_CASH_MIN_TARGET_DTE` | 7 | cash DTE floor |
| `STRATEGY_MARGIN_MAX_TARGET_MULTIPLIER` | 1.33 | margin gate scale-up |
| `STRATEGY_CROSS_ACCOUNT_YES_DOWN_PCT` | 10 | cross-account dip trigger (1pm-lenient) |
| `STRATEGY_GATE_STRONG_YES_MAX_TARGET_PCT` | 0.35 | top signal-tier ceiling |
| `STRATEGY_MIN_OPEN_INTEREST` | 0 (off) | optional OI floor |
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
  `tastytrade-golden-lion`, id 5). See [reference_server_deploy] in memory /
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
