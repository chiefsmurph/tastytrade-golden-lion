# GL buy/seed gate audit — alpha vs. risk, and the "thesis-only" question

**Date:** 2026-07-24 · **Author:** audit pass with Claude · **Status:** analysis + proposed changes (nothing built)

## Why this exists

Question raised: *silver-lynx should only seed options when the RH bot is down on a name
(`daytradeScore < -75` / underwater) — "wait for the drop."* Investigating it surfaced a
**recent, high-sample backtest** that already answers most of it, so this doc records the
finding, audits GL's live gates against it, and proposes the actual change list.

## The governing finding (already in the code)

A forward-return backtest on **2026-07-19 (n=2242 fills, intraday horizon)** — cited in
[`signal-interpreter.ts:25-31`](../src/strategy/signal-interpreter.ts#L25) and
[`position-gate.ts:51-55`](../src/strategy/position-gate.ts#L51) — found:

- **THESIS predicts forward return.** `buyFraction > 1.0` (full thesis + willBuy icing) was
  the best bucket at **+0.91% avg / 68% win**; `buyFraction = 1.0` (4/4 thesis) **+0.72% / 66%**.
- **DIP-POLARITY does not.** `daytradeScore ≤ -100/-200`, `returnPerc < -2/-5%`, and
  `superRecScore > 80` were "unvalidated dip-polarity defaults." `daytradeScore -70..-150` is a
  **death valley (win 16-29%, avg -5 to -7%)**; the strong-conviction leg *inside* the valley
  (high thesis + deep dip) was the **worst at 16% win**. All three were dropped; `daytradeScore`
  is telemetry-only now.

**Interpretation.** Dip-buying is the **stock bot's** edge — it averages down and rides the
recovery, which it can afford because it just holds and adds. **Options can't**: theta + leverage
punish being early, so "it dropped" stops being an entry and becomes a bleed. For GL, the edge is
**conviction, not timing.** Re-adding a dip gate (either `daytradeScore` or `returnPerc`) would
concentrate seeds *away* from the +0.91% thesis bucket and *into* the death valley — and
conditioning on strong thesis inside the dip did **not** rescue it.

## The framework: two kinds of gate

| Kind | Purpose | Judge | Examples |
|---|---|---|---|
| **Alpha / conviction** | predict forward return | the 07-19 backtest | thesis (`buyFraction`, manual score, willBuy) |
| **Risk / execution / cost** | protect the fill regardless of alpha | not alpha — always keep | spread, IV rank, DTE window, minPrice, buying power |

**"Buy when thesis looks good and that's it" is right for the *alpha* layer only.** Stripping the
risk/execution gates would buy great names through terrible contracts (wide spreads, bad IV,
wrong expiry) and lose to execution. The alpha layer is *already* thesis-only — the dip removal on
07-19 was that change.

**The unifying rule:** *Thesis is the only reason to enter or add. A dip is never an entry/add
reason — only a better price for a thesis you already hold.*

## Audit — GL's live gates classified

### Validated alpha (keep, primary)
- **Thesis rollup** — `buyFraction` / `allBooleansGood` (full thesis), manual `goodBooleanScore`,
  `willBuy` (margin hard gate). Directly the 07-19 winner. Correct and primary.

### Conviction proxies of UNCONFIRMED validation (the real audit gap)
The position-gate "stock-yes" tiers ([`position-gate.ts:283-286`](../src/strategy/position-gate.ts#L283))
are driven by:
- **`isQualityToBuy`** (feed boolean), and
- **`percentOfBalance`** (the RH *stock* position size, used as a conviction proxy — "RH holds a lot").

These set `basicStockYes` / `strongStockYes`, which drive `maxTargetPct`. **They were not part of the
07-19 buyFraction validation.** They may be fine — but they are exactly the kind of unvalidated
conviction input that dip-polarity turned out to be. They deserve the *same* forward-return check.

### Avg-down trigger (already correct — thesis-gated)
GL's cross-account avg-down ([`seed-decision.ts:132-146`](../src/strategy/seed-decision.ts#L132)):
the **dip triggers** consideration (cash contract underwater by `minDownPct`), but the seed only
**passes if thesis clears** — `fullFeedThesis (thesisCount 4/4) OR manualScore >= bar` (bar 4 early /
6 deep). So a **decayed-thesis red name does not get fed.** This already implements the unifying rule:
dip = trigger/price, thesis = gate. **No change needed to the principle** — only tuning (below).

### Risk / execution gates (keep regardless)
Spread (`STRATEGY_MAX_OPTION_SPREAD_PCT`), IV rank (`STRATEGY_MIN_IV_RANK_PCT`), DTE window,
minPrice, buying-power / percent-of-NLV caps. Not alpha — protection. Keep all.

### One questionable risk/alpha blend
The seed **IV-rank fallback** ([`seed-decision.ts:169-172`](../src/strategy/seed-decision.ts#L169)):
when thesis signal is absent, it falls back to `ivRank >= 50 (early) / 70 (deep)` to seed. That is
seeding on an **unvalidated alpha proxy** in the absence of the validated one. Per the finding,
"unknown thesis" is a weak reason to deploy leveraged premium.

## Proposed changes (all test-behind-a-flag; none built)

**Headline: GL is already well-aligned — this is tuning + two validations, not an overhaul.**

1. **Do NOT add a dip (`daytradeScore`/`returnPerc`) entry gate.** Documented loser (07-19). Closed.

2. **Validate the two unconfirmed conviction proxies** — run the *same* forward-return check on
   `isQualityToBuy` and `percentOfBalance`-as-tier-driver that killed dip-polarity. If either is a
   valley/flat (not predictive), **demote it** so `buyFraction` dominates the tier. *This is the
   direct application of the finding: only validated alpha should gate.* (Analysis, then a gate change.)

3. **Reconsider the IV-rank thesis-fallback** ([`seed-decision.ts:169`](../src/strategy/seed-decision.ts#L169)):
   consider "unknown thesis ⇒ no seed" rather than falling back to an unvalidated IV proxy. Conservative;
   pref-gate it and compare seed counts / outcomes.

4. **Tighten deep-zone avg-down toward the best bucket.** The seed passes on `thesisCount 4/4`
   (`buyFraction = 1.0`, +0.72%) OR manual `>= 6` in the deep zone. The validated *best* bucket is
   `buyFraction > 1.0` (full thesis **+ willBuy**, +0.91%). Consider requiring `willBuy` (buyFraction > 1.0)
   for the deepest avg-downs — the further you double down, the higher the conviction bar.

5. **Add a stabilization/theta guard to avg-down (NEW).** Answering "can we still avg down when the
   contract dips?" — **yes, but** even with thesis intact, don't seed into a *knifing* contract; theta
   punishes being early. Gate the deep-zone seed on the underlying **basing** (plateau / not still
   falling) — the options-equivalent of the stock bot's add-governor. This is the one genuinely new
   idea and should be A/B'd, not assumed.

## Answers to the two direct questions

- **"Buy when thesis looks good and that's it?"** — For the *alpha* layer, yes, and it already is
  (dip removed 07-19). Keep every *risk/execution* gate. The real work is #2 (validate/demote the two
  remaining unconfirmed conviction proxies), not stripping conditions.
- **"Can we still avg down when the contracts dip?"** — Yes. It's already thesis-gated (dip triggers,
  thesis passes), which is correct. Two refinements: raise the bar for the *deepest* adds (#4), and add
  a *don't-catch-a-knifing-contract* stabilization guard (#5). The dip is never the reason — only a
  cheaper price for a thesis still intact.

## Next step

Run the forward-return validation on `isQualityToBuy` and `percentOfBalance` (#2) — same method as the
07-19 daytradeScore test. That's the number that turns "keep or demote" into a decision. Everything
else is tuning that should be A/B'd on the two-account setup, not shipped on conviction.
