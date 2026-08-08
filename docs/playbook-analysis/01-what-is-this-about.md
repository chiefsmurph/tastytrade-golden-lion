# 01 — What the Playbook Is, and Its Strengths & Weaknesses

_Analysis of `Playbook / Trading Framework / Business Plan.pdf` (a.k.a. "The Renden Trading Blueprint")._

## What it is

A **personal discretionary swing/day-trading manual** for a human trader (a teacher & coach who trades mornings, swing-trades during the school year and day-trades in summer). It is roughly 136 pages and is a *synthesis of four canonical trading books plus a psychology reading list*, followed by ~2 weeks of a live trading journal.

It is **not** a systematic/quantitative strategy. There are no backtests, no measured win-rates, no expectancy math. It is a belief-system + checklist + workflow whose explicit goal is *consistency and capital preservation*, with money treated as the byproduct of good process.

### The sources it's built from

| Source | What was lifted | Where (pages) |
|---|---|---|
| **Mark Douglas** — _Trading in the Zone_ / _The Disciplined Trader_ | The five fundamental truths, seven principles of consistency, "I am a consistent winner," probabilistic mindset, risk acceptance, mechanical→subjective→intuitive stages | 1–7, 28–56 |
| **William O'Neil** — _How to Make Money in Stocks_ (CAN SLIM) | Cup-and-handle, pivot/breakout buying, RS-rating ≥ 80, volume dry-up at base lows, 7–8% stop rule, distribution-day market-top detection, institutional sponsorship, leaders vs. laggards | 57–75 |
| **John Carter** — _Mastering the Trade_ | The **Squeeze** indicator, $TICK fades, "propulsion play," "40 tips" pro-mindset, set-orders-the-night-before, drilling down through timeframes | 76–101, 106+ |
| **Mark Minervini** — _Trade Like a Stock Market Wizard_ | **VCP** (volatility contraction pattern), **stage analysis (1–4)**, pilot buys, pyramiding up on strength / tapering on weakness, superperformance, 4–6 name concentration | 103–136 |
| Also quoted | Nicolas Darvas, Jesse Livermore, Paul Tudor Jones, Alan Watts, Michael Singer, David Hawkins, Steven Pressfield, Don Miguel Ruiz, Theodore Roosevelt ("Man in the Arena"), "Ripster" | throughout |

### Its actual operating rules (the executable core)

- **Regime traffic-light**: Green = trade with trend; Yellow = sideways, snipe small; Red = short/cash. Read SPY / QQQ / IWM (daily first, then 30-min), plus VIX and DXY.
- **Top-down**: market → sector (SMH, URA, WGMI, GDX, XBI…) → individual stock. Only trade "stocks in play" (high RVOL ≥ 1.5×, RS ≥ 80, a catalyst).
- **Entry**: only at a defined setup (VCP breakout / pivot / squeeze fire / support in uptrend). Never chase; enter during quiet, sell into strength.
- **Risk**: ≤ 1–2% equity per trade; 7–8% (or tighter 5–6% in bad tape) hard stop; **3:1 minimum reward:risk**; position size = risk-$ ÷ stop-distance.
- **Sizing**: scale in thirds (pilot buys), pyramid up only when trades work; scale out thirds/quarters; "never let a winner become a loser."
- **Behavior**: trade the first ~2 hours (edge highest), hit 50% of daily target and stop, ≤ a couple of high-quality trades, journal every trade.

---

## Strengths

1. **Psychology-first and risk-first.** The document's spine — accept risk, predefine it, cut losses without hesitation, don't average down emotionally, protect capital — is exactly what keeps discretionary traders alive. This is the correct hierarchy (survival → consistency → returns).
2. **Sourced from proven practitioners**, not folklore. Douglas/O'Neil/Carter/Minervini are respected, and the extracts are faithful.
3. **A coherent, repeatable daily workflow** with concrete checklists (pre-market prep, grade-every-setup, post-market audit, slump-remediation protocol).
4. **Process-over-outcome framing** — journaling, self-monitoring, "trade to build skill not to make money," acceptance of losses as cost of business. Good defense against tilt/revenge trading.
5. **Explicit regime awareness** (green/yellow/red; "cash is a position"; trade smaller in choppy tape). Many blow-ups come from ignoring regime; this doesn't.
6. **Correct size discipline**: pyramid into strength, cut size into weakness, concentrate in 4–6 best names. This is the opposite of martingale and is durable.

## Weaknesses

1. **Enormous and repetitive.** ~136 pages, heavy redundancy — it violates its own "keep it simple / trade boring." A one-page rule card would be more executable than this. Hard to consult in real time.
2. **Internal contradictions** across pasted-together sources:
   - **"NEVER AVERAGE DOWN"** (Minervini) vs. O'Neil "buy more only after it rises" vs. the doc's own "scale in thirds / pilot buys." These are three different sizing philosophies coexisting unresolved.
   - **"Trade the first 2 hours only"** (day-trade) vs. **"money is made by sitting… catch multi-week moves"** (swing/position). The doc mixes day-, swing-, and position-trading rules without separating their timeframes.
   - The whole doc says **trade WITH the daily trend (longs in uptrends)** — yet the live journal is almost all **intraday shorting of strong momentum names**, which is fighting the trend.
3. **Claims to be "mechanical" but is deeply discretionary.** "Porsche setups," RSI/MACD/VWAP/AVWAP/VIX/DXY "confluence," "5-star vs 4-star" — all judgment calls. There is no unambiguous, codifiable trigger.
4. **No quantified edge.** Everything is "high probability" with zero measured win-rate, sample size, or expectancy. There is no way to know if any setup actually has an edge, or how large.
5. **The journal reveals the plan is aspirational.** 7/23–8/4 is a string of self-critiques: impulse shorts, no pre-market homework, no predefined risk, "shorting at the bottom of a cup — it bounces right back to the rim, STOP DOING THAT." The written system and the executed behavior are far apart — which is exactly the gap Douglas says kills traders.
6. **The weakest activity gets the most journal time.** Almost all the logged pain is from *shorting* (CRCL, MSTR, RGTI, ONDS, CDE, AXTI, TEM), the hardest, lowest-edge thing to do — against the doc's own "trade with the trend, longs in uptrends" rule.

---

## One-line takeaway

A **well-sourced, psychologically sound, risk-first discretionary swing-trading manual** whose biggest problem is the distance between the disciplined plan on paper and the impulsive shorting in the journal — i.e., an *execution/consistency* problem, not a *knowledge* problem. That is precisely the problem an **automated** system (our bots) is built to solve.
