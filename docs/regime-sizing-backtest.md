# Does regime favorability predict seed outcomes?

**Date:** 2026-07-21
**Branch:** `analysis/regime-sizing-backtest`
**Script:** `src/tools/regime-sizing-backtest.mjs`
**Status:** analysis only — no production code touched, no deploy.

## The proposal being tested

Size option seeds by market-regime favorability: big (up to ~25% of account)
on a "favorable" day, small (~5%) on a "timid" day. The favorability signal
comes from the Alpaca stock bot's per-tick regime line:

```
SCANNED_REGIME_AOBM mkt=<marketReturn%> z=<breadth z> regimeMult=<x> dipBuyMult=<x> crashRegime=<bool>
```

## The counterexample that prompted this

On 2026-07-20 the SG option seed — silver-lynx's one clean winner, the $6 call
$0.98 → $1.38, **+41%** — was placed while `regimeMult=0.84` / `dipBuyMult=1.00`,
i.e. a **timid/reduce** posture. Regime-scaling would have sized that winner
*small*. We need to know whether that is a fluke or the rule before wiring
regime into sizing.

## Method

silver-lynx's own seeds are too few to measure, so we use the Alpaca **stock**
bot's `closedPositions` as a proxy population. For each buy we join the regime
state that was live at buy-time (nearest `SCANNED_REGIME_AOBM` tick ≤ the buy
timestamp, within 20 min) and compute the forward return (position's
volume-weighted avg sell vs that buy's fill). We then test whether regime
favorability predicts a better per-buy outcome.

**Data window:** 2026-07-07 → 2026-07-21 (the dates the regime line was logged).
- **2,885 buys** joined to a regime tick (out of 17,369 total closed-position buys).
- Full-window joinable signals: `dipBuyMult`, breadth `z`, `crashRegime`.
- `regimeMult` and `mkt` only exist in the newer (7/20–7/21) log format → **172 rows, thin.**

Sign convention: **`dipBuyMult` > 1 = MORE favorable** (deploy the dip harder).

## Results

### 1. dipBuyMult (favorability) does correlate with forward return

| dipBuyMult bucket | n | mean fwd ret | win% |
|---|---:|---:|---:|
| timid (≤1.05) | 1698 | **−2.74%** | 34.3 |
| mid (1.05–1.25) | 431 | −0.08% | 56.8 |
| favorable (>1.25) | 756 | **+0.06%** | 59.3 |

`corr(dipBuyMult, ret) = +0.21`. Monotonic and directionally strong.

### 2. It survives the survivorship check

`closedPositions` only contains *closed* trades. On the tail dates
(7/16–7/21) essentially 100% of closed positions are same-day round-trips —
still-open (mostly losing) positions are excluded, which inflates recent-day
buckets. Re-running on the survivorship-cleaner dates (7/7, 7/9, 7/13, 7/14,
7/15 — mixed exit-timing) keeps the gradient:

| dipBuyMult bucket | n | mean fwd ret | win% |
|---|---:|---:|---:|
| timid (≤1.05) | 826 | **−4.82%** | 24.2 |
| mid (1.05–1.25) | 186 | −2.06% | 24.7 |
| favorable (>1.25) | 667 | **−0.10%** | 55.5 |

So the favorability → better-outcome link is real, not an artifact of which
trades happened to be closed at snapshot time.

**Caveat on `regimeMult` / `mkt`:** the thin 7/20–7/21 sample shows a *100%
win rate in every bucket* — a pure survivorship signature. Those two fields
are **not trustworthy** here; do not read the `regimeMult<1 = +2.72%` line as
evidence. The real signal is `dipBuyMult` on the broad window.

### 3. But it is mostly a DAY-level pacing signal, not a per-NAME predictor

`dipBuyMult` barely moves within a day — it is close to a per-day constant
(see per-day `dipRange`). So most of its "predictive power" is really *which
day you traded*, i.e. a **deploy-pacing** signal, consistent with prior work
(marketReturn/breadth is the dominant *deploy* signal). The within-day test —
splitting each day's buys hi vs lo `dipBuyMult` — only has signal on the one
day with real intraday spread (7/13):

| date | dip spread | hi-dip (n/ret/win) | lo-dip (n/ret/win) |
|---|---:|---|---|
| 7-13 | 0.60 | 310 / **+1.24%** / 80% | 237 / −0.87% / 42% |
| 7-7 | 0.47 | 252 / −1.68% / 29% | 316 / −1.95% / 4% |
| others | ≤0.23 | (little spread) | |

There is a *modest* per-name component (7/13 is real), but it is thin and
one-day-driven. Treat regime as a **pacing** lever, not a per-seed alpha.

### 4. The SG hypothesis: winners do NOT cluster on timid days

Direct test of the counterexample. Among the top 5% forward-return buys:

- share placed on a **timid** (dipBuyMult ≤ 1.05) tick: **34.0%**
- baseline timid share of all buys: **58.9%**
- **lift = 0.58×** — winners are *under-represented* on timid ticks.
- mean `dipBuyMult` of top winners = **1.31** vs 1.14 for all buys.

So winners lean *favorable*, not timid. **The SG seed (placed timid, +41%) is a
genuine outlier, not the pattern.** Regime scaling would *not* systematically
under-size winners across the population — it just would have missed that one.

### 5. Sizing counterfactual

Capital-weighted mean forward return, flat vs regime-scaled (favorable = 5×
timid weight, mid = 2.5×):

- flat sizing: **−1.61%**
- regime-scaled: **−0.69%**
- delta: **+0.92%**

Regime-tilted sizing improves the population's capital-weighted outcome by
~0.9 pts — but this improvement is almost entirely *cross-day* reallocation
(deploy more on favorable days), which is the pacing signal we already have.

## Verdict

**Regime favorability is a genuine signal, but it is a DAY-level deploy-pacing
signal, not a per-seed outcome predictor — so scale the *day's aggregate seed
budget*, not the individual name.**

Concretely:
1. **Do tilt the day's total seed budget on `dipBuyMult` (favorability).** It
   is directional, survives survivorship, and lifts capital-weighted return
   ~0.9 pts. This is the same lever as the known deploy-pacing edge, so it is
   coherent with the stock bot's proven behavior.
2. **Do NOT expect it to pick winners within a name/day.** The per-name effect
   is thin and one-day-driven; sizing an *individual* seed 25% vs 5% purely on
   the tick's regime is not justified by the data.
3. **The SG counterexample does not block a day-budget tilt.** Winners lean
   favorable population-wide (0.58× timid lift); SG is an outlier. A day-budget
   tilt would have sized 7/20 modestly (dipBuyMult ~1.16, mid) and still
   captured most of SG — it would only fully under-size if the whole day were
   flagged timid, which is rare.
4. **Suggested split (conservative, wide bands to avoid over-fitting 2 weeks):**
   - favorable: `dipBuyMult > 1.25` → up to full budget (~20–25%)
   - mid: `1.05–1.25` → ~half budget
   - timid: `dipBuyMult ≤ 1.05` → floor (~5%)
   Apply per-day (or per multi-hour block), **not** per-seed.
5. **Do NOT use `regimeMult` or `mkt` from the current logs for this** until
   more history accrues — their only joinable rows (7/20–7/21) are
   survivorship-poisoned (100% win in every bucket). `marketReturn` is the
   known dominant deploy signal per prior work, but it is not yet cleanly
   measurable in this dataset; revisit once ≥1 month of the new log format and
   a mix of open/closed outcomes exist.

## Caveats

- Two-week window (7/7–7/21); one bad day (7/15, −9%) heavily weights the
  low-`z` bucket and muddies breadth-`z` as a signal.
- Forward return uses the position's volume-weighted avg sell as the exit for
  every buy in that position (the standard measure for this dataset); it is not
  a per-buy tick exit.
- Recent-date survivorship is the main hazard; the survivorship-cleaner subset
  (section 2) is the load-bearing evidence, not the raw or thin-format buckets.

## Reproduce

```
node src/tools/regime-sizing-backtest.mjs
```

Reads `data-pull-regime/positions.json` (slim `closedPositions` pulled
read-only from prod) and `data-pull-regime/regime.json` (parsed
`SCANNED_REGIME_AOBM` series from the RH `data-pull/*/mongo/logs.json`).
