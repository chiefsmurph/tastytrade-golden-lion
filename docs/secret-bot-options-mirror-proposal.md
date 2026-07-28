> ## 📨 INBOUND — message from the secret bot (the stock signal feed)
>
> **This document is NOT our design.** It was sent to us on **2026-07-13** by the operators of
> the upstream stock bot (the "secret" Socket.IO signal feed —
> same system that emits `buyWeight` / `manualThesisCount` / `buyFraction` etc. to this repo).
>
> It is **their unsolicited pointers on how they would build an options system off of their own
> signals** — a reference/proposal, not the current tastytrade-silver-lynx architecture and not
> a spec we've agreed to. Read it as "here's how the people who own the signals would map them
> onto options books." Everything below the `---` divider at the very bottom is *our*
> annotation (questions back to them); everything above it is their message verbatim.
>
> Our open questions for them are collected at the end — John can relay these back.

---

# Options Mirror Bots — Two Accounts Off One Stock Book
*Designed 2026-07-13*

## Concept
Two options accounts trade **derived from this stock bot's live positions**. They map
onto the two conviction axes we decoupled this session:

```
                buy signal  ──────►  MARGIN bot : intraday, slightly-OTM, FLAT by close
stock position <
                hold signal ──────►  CASH bot   : 10–14 DTE, slightly-ITM, HELD overnight
```

- **Margin** rides the **buy** signal (`buyWeight`/`willBuy`/`daytradeScore`/`rangePos`
  room) for same-day convexity. It never carries, so it ignores `holdScore`.
- **Cash** rides the **hold** signal (`holdScore` primary, overnight-eligibility, thesis,
  `!crashRegime`). Because it holds overnight, `holdScore` is the right gate — holdScore
  *is* the "worth carrying overnight?" score.

This is literally the buy/hold decoupling from `eod-hold-tiers`, projected onto two
accounts. The cash bot even shares an EXIT with the hold-tier framework (below).

## Notation
`norm(x, lo, hi) = clamp((x - lo) / (hi - lo), 0, 1)`. All scores are 0–1. Weights sum to 1.

## Field reads (all already on the position / globals)
| field | path | notes |
|---|---|---|
| willBuy / isBuyEligible | `position.willBuy` / `position.isBuyEligible` | inherits ALL buy gates incl. `!failsDayHighGate` |
| buyWeight | `position.buyWeight` | concentration-crushed final |
| buyMult | `position.buyWeightDebug.buyMult` | base rec strength (not concMult-crushed) |
| gateMult | `position.buyWeightDebug.gateMult` | gate favorability |
| failsDayHighGate | `position.failsDayHighGate` | extended-pump block |
| daytradeScore | `position.daytradeScore` | intraday quality |
| holdScore / tier | `position.holdTierPreview.{holdScore,tier}` | now attached ALL DAY (eodHoldTierPreviewMin=0) |
| manualThesisCount | `position.manualThesisCount` | 10-flag (buy-contaminated — see Thesis gate) |
| buyFraction | `position.buyFraction` | 4-flag + willBuy icing, 0→1.25 |
| rangePos | `position.scan.computed.rangePos` | 0=at low, 100=at high (OBSERVE-ONLY, unvalidated) |
| tsc | `position.scan.computed.tsc` | current vs prevClose |
| trueLow / trueHigh | `position.scan.computed.{trueLow,trueHigh}` | liquid-bar intraday range (strike anchors) |
| highToBid / highToCurrent | `position.scan.computed.{highToBid,highToCurrent}` | room to the high |
| bounceStabilizationScore | `position.bounceStabilizationScore` | stability |
| percentOfBalance (pob) | `position.percentOfBalance` | concentration (sizing cap) |
| returnPerc / returnBidPerc | `position.returnPerc` / `position.returnBidPerc` | P/L mid vs realizable |
| overnight eligibility | `isOvernightEligible(position)` from eod-hold-tiers | price≥5.35, nrw ok, alpacaStatus ok |
| scannedTotalZ / crashRegime | `global.scannedTotalZ` / `global.crashRegime` | regime (now restart-persisted) |
| currentMinBuyWeight | `global.currentMinBuyWeight` | the live buy gate to measure excess over |
| 5-min RSI | `position.scan.computed.fiveMinuteRSI` | overbought guard |
| minOld / realtimePicks | `position.minOld` / `position.realtimePicks` | freshness |

*(paths marked here should be re-verified at implementation — a couple may live one level
over from where noted.)*

---

## MARGIN bot — intraday OTM scalp

### Hard gates (all must hold)
```
position.willBuy === true          // live buy the stock bot is ACTING on
                                   //   → inherits !failsDayHighGate, isBuyEligible, all buy gates
&& min < 300                       // ≤11:30am PT — leave time for the move before the EOD flat
&& rangePos <= 65                  // not at the top of the range; OTM calls need upside room
&& daytradeScore > -150            // intraday quality not garbage
&& optionsLiquid(chain)            // HARD chain gate (OI/vol/spread) — see Options liquidity
```

### marginScore (ranks & sizes)
```
bwExcess = norm(buyWeight / currentMinBuyWeight, 1.0, 3.0)   // conviction OVER the gate
dtQual   = norm(daytradeScore, -100, 300)
room     = 1 - rangePos/100                                  // near-low = more room to pop
fresh    = realtimePicks.count >= 3 ? 1 : norm(-minOld, -180, 0)
momo     = norm(tsc, -8, 6) * (fiveMinuteRSI in [40,68] ? 1 : 0.5)

marginScore = 0.35*bwExcess + 0.25*dtQual + 0.20*room + 0.10*fresh + 0.10*momo
```
- **Act** if `marginScore >= 0.45`. **Contracts ∝ marginScore** (× per-name pob cap).
- **Strike (slightly OTM):** `strike ≈ current * (1 + 0.02 + 0.03*room)`, **capped at `trueHigh`**
  (never a strike above today's realized high). Nearest weekly expiry.
- **Exit:** hard flat by **min ~380**; early-exit if `daytradeScore` collapses or `rangePos > 85`
  (it spiked — take the pop).

---

## CASH bot — 10–14 DTE ITM swing

### Hard gates (all must hold — overnight safety + durable conviction)
```
holdScore >= 0.45                  // == effT4 overnight bar. THE gate (holds overnight)
&& isOvernightEligible(position)   // price ≥ overnightMinPrice 5.35, nrw ok, alpacaStatus ok
&& !crashRegime                    // never swing-hold a falling knife
&& (manualThesisCount >= 2 || buyFraction >= 0.6)   // durable thesis (SOFT until measured — see below)
&& !failsDayHighGate               // don't START a multi-day hold on an extended pump
&& rangePos <= 55                  // enter on the lower half → better multi-day cost basis
```

### cashScore (ranks & sizes)
```
hs     = norm(holdScore, 0.30, 0.80)                          // PRIMARY
thesis = 0.6*norm(manualThesisCount, 2, 8) + 0.4*norm(buyFraction, 0.5, 1.25)
entry  = 1 - rangePos/100                                     // bought the dip = better basis
stab   = norm(bounceStabilizationScore, 30, 55)
regime = crashRegime ? 0 : 0.5 + 0.5*norm(scannedTotalZ, 0, 2.5)   // supportive-down tape helps dip-holds

cashScore = 0.45*hs + 0.20*thesis + 0.15*entry + 0.10*stab + 0.10*regime
```
- **Act** if `cashScore >= 0.55`. **Contracts ∝ cashScore** (× per-name pob cap).
- **Strike (slightly ITM):** `strike ≈ current * (1 - 0.03 - 0.02*(1-entry))`, **floored at `trueLow`**
  (a strike above today's support = ITM with a cushion). Higher `holdScore` ⇒ a touch deeper ITM
  (higher delta, more stock-like). 10–14 DTE.
- **Exit (reuse the hold-tier framework as the signal):** hold overnight; exit when the
  underlying's `holdScore` drops below **T3 (~0.30)**, OR the stock bot flattens the name, OR
  `crashRegime` trips, OR DTE < 3, OR a profit target hits.

---

## Thesis gate — OPEN (measure before hard-gating)
The cash gate uses `manualThesisCount`/`buyFraction` as a **soft** floor for now. Before making
thesis a **hard** buy-gate anywhere:
1. **Measure the forward-return gradient by thesis bucket.** `closedPositions` does NOT stamp
   thesis counts (checked 7-13) — need to find where thesis-at-fill lives (likely `picks` /
   `gateValues` on the buy record) and join to forward returns.
2. **Check the distribution** — how many buys sit at each `thesisCount`? A `>=2` hard gate could
   starve the universe (the sudden-drops dollar-vol failure mode).
3. **Beware circularity** — the 10-flag `manualThesis` includes buy-side flags (`isClearedToBuy`
   / `isBuyEligible` / `willBuy` / `isHighConviction`), so it will *look* predictive because it
   partly IS the buy decision. Prefer `buyFraction` (4-flag), or gate only the **zero-thesis floor**
   (block `thesisCount == 0` junk) rather than requiring high counts.

**Recommendation:** keep thesis in the SCORE (soft) until (1) shows a clean, non-circular gradient
AND (2) shows enough volume above the floor. Then add a LOW hard floor, not a high one.

## Options liquidity — the real killer (not optional)
Most of these small-caps have brutal chains (wide spreads, ~0 OI). The underlying signal is
**necessary but not sufficient**. Both bots need a hard chain gate BEFORE any score:
`minOpenInterest`, `minDailyOptVolume`, `maxSpreadPct`. This gate matters more than any weight above.

## Observe-first rollout
1. Add a read-only evaluator that, for each live stock position, logs what each bot WOULD do:
   ```
   MARGIN_OPT would-buy <TKR> score 0.xx  strike <OTM$>  exp <weekly>  [bwExc dt room ...]
   CASH_OPT   would-buy <TKR> score 0.xx  strike <ITM$>  exp <10-14d>  [hs thesis entry ...]
   ```
   No orders — just the candidate stream. Same discipline as DAYHIGH_TRACK / conviction-spray funding.
2. Watch a few days: are the picks sensible? Is the OTM/ITM strike reachable? Is the chain even liquid?
3. Wire the margin bot first (intraday, self-limiting — flat by close = bounded risk).
4. Wire the cash bot once holdScore-driven picks look right and the exit-on-tier-drop is validated.

## Risks
- **Theta on intraday OTM** — margin must be right on direction AND timing; the EOD-flat is the guardrail.
- **Overnight gap on ITM 10–14d** — cash's overnight-eligibility + `!crashRegime` gates are the protection;
  ITM (high delta) also limits the % gap damage vs OTM.
- **rangePos unvalidated** — observe-only; keep its weight modest / tiebreaker until wordPerc confirms edge.
- **Chain liquidity** — see above; the dominant real-world risk.
- **v1 weights** — tune from forward P/L, log-measure-adjust, same as everything else.

---

## ⟵ Questions back to the feed team (annotation from the tastytrade side, 2026-07-13)

*Not part of the original message. These are ours to relay back.*

1. **Field availability is the whole ballgame — which of these do you actually EMIT to us?**
   This design leans heavily on fields we do **not** currently receive over the socket. Today's
   payload gives us: `buyWeight`, `daytradeScore`, `isBuyEligible`, `isQualityToBuy`, `returnPerc`,
   `superRecScore`, `percentOfBalance`, `buyFraction`, `thesisCount`/`thesisMax`,
   `manualThesisCount`/`manualThesisMax`, `willBuy`, plus the individual thesis flags.
   We do **not** currently get: `holdScore`/`holdTierPreview`, `rangePos`, `tsc`,
   `trueLow`/`trueHigh`, `highToBid`/`highToCurrent`, `bounceStabilizationScore`, `failsDayHighGate`,
   `buyWeightDebug.{buyMult,gateMult}`, `minOld`/`realtimePicks`, `fiveMinuteRSI`, and the globals
   `scannedTotalZ`/`crashRegime`/`currentMinBuyWeight`, plus `isOvernightEligible`.
   **Will you extend the emitted payload (per-position + globals) to include the hold-side and
   scan-computed fields, or is this design assuming the options logic lives inside your process?**
   This one answer determines whether we can build any of it on our side at all.

2. **`holdScore`** — is it a directly-emitted 0–1 number, or derived from `holdTierPreview.tier`?
   If tiers, what's the tier→score / tier→threshold mapping (you reference effT4 ≈ 0.45, T3 ≈ 0.30)?

3. **`isOvernightEligible` / `overnightMinPrice 5.35`, `nrw`, `alpacaStatus`** — can you emit the
   boolean result per position, or do we need the raw inputs to recompute it? We'd rather consume
   the boolean than re-implement your eligibility logic and drift from you.

4. **`crashRegime` / `scannedTotalZ` / `currentMinBuyWeight`** — emitted as top-level globals on
   each payload? Cadence? We currently key everything off the per-position array under `alpaca`.

5. **`rangePos`** — you flag it observe-only/unvalidated pending `wordPerc` confirmation. What's the
   current validation status, and do you have a read on whether it carries edge yet? Several strike
   and gate decisions here hinge on it.

6. **The hold-tier EXIT** — moot for our existing accounts: we've decided our selling stays
   feed-independent (we don't mirror your sells). Only relevant if the separate options-mirror
   *cash* bot below ever gets built, in which case: would you emit tier transitions for it to
   consume, or expect it to reimplement `eod-hold-tiers`?

7. **Contract multiplier / liquidity reality** — you call chain liquidity the dominant risk. Do you
   already track per-underlying option OI / daily option volume anywhere we could ingest, or is that
   entirely ours to source (we have chain snapshots + the step-1 liquidity logging already)?

### Exits — NOT adopted (decision 2026-07-13)

Their exit framework (margin flat by ~380; cash exit on `holdScore` dropping below T3, DTE<3,
`crashRegime`; and generally reacting to *when they sell*) is built around **their model, where
they sell stock positions in the morning**. We are **not** coupling our selling to theirs.

**Firm invariant: the feed drives BUYING only. Our selling is feed-independent** — dynamic
take-profit (40%→7%), bid-based stop (-30% intraday / -10% post-cutoff), 12:50 EOD urgent-chase
liquidation for margin, and age-floor overnight reduction for cash own the sell side entirely.
Their morning-sell timing does not map onto our overnight-hold + gradual-reduction model, and
coupling exits to an external actor's timing adds fragility we don't want. Signal-departure
(`isSelling`/`currentAction`) is therefore deliberately unread on our side — see the note in
`src/strategy/secret/types.ts`. (The staleness-gate backlog item stands on its own as a
data-integrity guard, unrelated to mirroring their sells.)
