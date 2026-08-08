# 02 — What (If Anything) Applies to Our Trading System

_Mapping the playbook against Silver Lynx (options/tastytrade) and Golden Lion (stocks/Alpaca)._

## A. First, the core philosophical clash

The playbook and our bots sit in **opposite expectancy quadrants**, so most of its stock-picking content does not transfer — but its *risk/discipline* content does.

| | **Playbook (Douglas/O'Neil/Carter/Minervini)** | **Our bots** |
|---|---|---|
| Edge type | **Momentum / trend-following** | **Mean-reversion / accumulate-the-dip** |
| Direction | Buy **strength**, buy breakouts, buy leaders | Buy **weakness**, average **down** into cheap names |
| Sizing on losers | **"NEVER average down"** (PTJ: _"losers average losers"_) | **Average down, thesis-gated** (this is our stated alpha) |
| Entry timing | Time the pivot/VCP breakout precisely | Timing has ~no edge for us; _"edge is what/how-much, not when"_ |
| Win/R:R profile | **Low win-rate, high R:R (≥3:1)** | **High win-rate, low R:R** |

This is not an accident to fix — it's a deliberate opposite bet. Two consequences:

1. **The playbook's #1 rule ("never average down") is our #1 mechanic.** That's allowed *within the playbook's own fine print*: Minervini/Douglas forbid averaging down **emotionally**. Ours is **thesis-gated and governor-braked** (see below), not emotional — which is the exact carve-out. Worth keeping that framing explicit whenever we defend the design.
2. **Our early-day reward:risk is structurally < the playbook's 3:1 floor.** Silver Lynx risks a **-30%** bid stop to make a **40%** target early (~1.3:1), and only **7%** vs a **-10%** stop late (~0.7:1) — see `src/strategy/evaluate-trading-strategy.ts:138-217`. By the playbook's yardstick that's unacceptable. By *ours* it's fine **only if win-rate is high enough** to overcome it. **Recommendation: we should actually measure realized win-rate × avg-win/avg-loss and confirm positive expectancy** — the playbook is right that you can't just assert "high probability"; we have the data to not have to.

## B. What we already implement (playbook idea → our mechanic)

Most of the playbook's *durable* ideas are already in the code — often in more disciplined form than a human could execute:

| Playbook principle | Our implementation | Ref |
|---|---|---|
| Predefine risk; cut losses without hesitation | SL hard stops: **-30%** intraday, **-10%** post-cutoff (bid-return) | `evaluate-trading-strategy.ts:199-217` |
| Pay yourself as the market gives; take profits | SL dynamic take-profit, **40%→7%** linear decay 6:30→12:55 | `evaluate-trading-strategy.ts:138-143` |
| Size by conviction (rate setups 1–5, bet more on 5-star) | SL position-gate **thesis tiers 10%→35%** + boolean boost (+0.03/pt) + `buyMult×gateMult` quality factor (floor 0.5) | `position-gate.ts:395-417`, `run-cycle-context.ts:507-509` |
| Never overcommit to one trade / cap position % | SL `maxTargetPct` ceiling per group (10–35%) | `position-gate.ts:395-403` |
| Trade smaller / brake in choppy, knifing tape | **Add-governor** knife-brake: SL margin **hard block <0.6**, cash **soft floor 0.35**; GL governor knife 0.35, plateau 35→65 | `position-gate.ts:132-147`, `governor-mult.js:23-27` |
| "Cash is a position" in bad regime | SL cash hard gates: `holdScore<0.45`, `!overnightEligible`, `crashRegime` block to 0 | `run-cycle-context.ts:608-610` |
| Don't chase; enter during quiet, passive fills | SL route weights **bid-heavy early** (70/20/10 → ask-heavy late) | `evaluate-trading-strategy.ts:286-309` |
| Time-of-day edge / first hours | SL 6:30→12:55 DTE + exposure interpolation; GL deployment curve (pivot ~66%) | `evaluate-trading-strategy.ts:249-309`, `get-curved-amt-to-spend.js:37-98` |
| Don't overtrade; cooldown | SL **10-min** cooldown; GL 3-min post-restart + **sell-floor** (no rebuy above lowest exit) | `evaluate-trading-strategy.ts:188-196`, `sell-floor.js:20-40` |
| Gate by vol environment | SL **IV-rank floor 20**; GL **SIS floor 100** | `entry-filters.ts:14-15`, `get-positions.js:116-117` |
| Need liquidity; don't trade wide spreads | SL spread ceilings: **10% margin / 30% shared**, morning ramp 5%→30% | `liquidity-gate.ts:40-47`, `spread-thresholds.ts:6-13` |
| Accumulation cutoff / EOD flatten | SL margin cutoff **12:30**, cash **1:00**, margin EOD liquidation armed **12:50** | `evaluate-trading-strategy.ts:37`, `spread-thresholds.ts:18` |

**Verdict on B:** the playbook's *risk-and-discipline spine* is already the bots' spine. The bots are, in effect, the automated cure for the journal's execution gap.

## C. Ideas / formulas actually worth importing (ranked)

1. **Scale-out in thirds/quarters (partial profit-taking).** The playbook's single most-repeated, most-concrete idea: _"divide position into thirds/fourths, take partial profits, let the rest run, never let a winner become a loser."_ Silver Lynx currently closes **all-or-nothing** at the dynamic target (`evaluate-trading-strategy.ts:138`). A **partial-TP** (e.g. sell half at first target, trail/hold the rest with a raised floor) would capture the "let winners run" upside we currently forgo. This is the highest-value, lowest-controversy import. _(Prior work already touched "harvest-parity" and a partial-TP residual on ACHR — worth finishing that thread.)_

2. **Confirm expectancy on the low-R:R structure (measurement, not a formula).** Given §A.2, add a standing metric: realized **win-rate × (avg win / avg loss)** per account. The playbook's discipline demand — "don't assert high probability, prove it" — is one we can satisfy from prod NDJSON. If early-day 1.3:1 R:R isn't backed by a high-enough win-rate, tighten the -30% stop or lower the 40% target.

3. **A relative-volume ("stock in play") confirmation.** Playbook: _"there must be a party before entering — RVOL ≥ 1.5×."_ Neither bot has an explicit RVOL gate (GL uses SIS/buyWeight; SL uses IV-rank). A light RVOL confirmation on entries could filter dead names. **Caveat:** validate against our mean-reversion universe first — high RVOL on a knifing small-cap may be *capitulation we want to buy*, not a reason to skip.

4. **"Am I still bullish on this? If not, why hold it?" — daily stale-thesis audit.** Playbook's post-market portfolio audit. We have do-not-touch groups + EOD liquidation, but not a daily *"thesis still valid?"* re-check per open group. A cron that flags positions whose feed thesis has decayed below entry would formalize this.

5. **Position size = risk-$ ÷ stop-distance.** Clean risk-based sizing. SL sizes by exposure% × gate, not by distance-to-stop. Since we *have* a -30% stop, we could sanity-check that per-name premium-at-risk stays within a fixed % of equity. Minor, but it's the one formula in the doc that's genuinely a formula.

## D. Ideas to explicitly NOT import (and why)

- **"Buy leaders / high-RS / high-priced / never buy laggards."** Our universe is deliberately the opposite (cheap small-cap mean-reversion, per [03](03-journal-vs-bot-stocks.md)). Chasing O'Neil momentum leaders is a *different* strategy, not an upgrade.
- **Precise entry timing / VCP-breakout / pivot-buying.** Our own research already retired entry-timing: _"wait-for-dip = adverse selection; predict-recover/fail = coin-flip; extremity is a NEGATIVE."_ For our universe, **when** has ~no edge; **what/how-much** does. Importing breakout-timing would fight validated findings.
- **More trend/regime braking on Golden Lion.** Replay showed the **governor is anti-alpha on Alpaca** — it throttles exactly the deep-knife bounces that ARE the edge. A green/yellow/red index gate risks the same harm on the mean-reversion book. Keep GL regime-braking dark; the governor stays as drawdown insurance only.
- **Shorting into strength / fading tops.** The journal's worst-performing activity. The bots don't short — keep it that way.
- **⚠ Conflict to resolve — drawdown response.** The playbook says: _"in a losing streak, FIRST scale DOWN size; never trade larger to recoup."_ John's **posture-plan is the opposite** — _"bold when down"_ (add more into drawdown). These directly clash. The playbook is the conventional wisdom; the posture-plan is a considered counter-cyclical bet bounded by the maintenance-margin line. This is worth an explicit decision: which regime does each account follow, and where is the hard floor that makes "bold when down" safe? (This is already the WS5 / counter-cyclical-ceiling thread.)

## Bottom line for Q2

- **We already implement the playbook's entire risk/discipline spine** — often more strictly than any human could. The bots ARE the fix for the journal's execution gap.
- **Worth importing:** partial scale-out (#1), expectancy measurement (#2), maybe an RVOL confirmation (#3) and a daily stale-thesis audit (#4).
- **Do not import:** momentum leader-chasing, precise entry-timing, extra GL regime-braking, or shorting — each conflicts with a *validated* finding about our own (opposite-quadrant) edge.
- **One genuine conflict to settle:** playbook "scale down in drawdown" vs. posture-plan "bold when down."
