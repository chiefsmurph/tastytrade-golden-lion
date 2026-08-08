# Playbook Analysis

Analysis of `Playbook / Trading Framework / Business Plan.pdf` ("The Renden Trading Blueprint") — a personal discretionary swing/day-trading manual — measured against our two automated bots (**Golden Lion** = stocks/Alpaca, **Silver Lynx** = options/tastytrade).

| # | File | Answers |
|---|---|---|
| 01 | [what-is-this-about.md](01-what-is-this-about.md) | What the document is + its strengths & weaknesses |
| 02 | [applicability-to-our-system.md](02-applicability-to-our-system.md) | What applies to our bots — what we already do, what's worth importing, what to avoid (with `file:line` refs) |
| 03 | [journal-vs-bot-stocks.md](03-journal-vs-bot-stocks.md) | Does the 7/23–8/4 journal line up with bot-traded stocks? How similar/different? |

## TL;DR

1. **What it is:** a well-sourced (Douglas / O'Neil / Carter / Minervini) risk-first *discretionary* manual. Its weakness is the gap between the disciplined plan and the impulsive intraday **shorting** in the journal — an *execution* problem, which is exactly what an automated bot solves.

2. **Applies to us?** The playbook's risk/discipline spine (predefine risk, hard stops, size-by-conviction, cooldowns, don't-chase, regime awareness, don't-overtrade) is **already in the bots**, often stricter. Genuinely worth importing: **partial scale-out of winners**, **expectancy measurement**, maybe an **RVOL gate** and a **daily stale-thesis audit**. Do **not** import leader-chasing, precise entry-timing, extra Alpaca regime-braking, or shorting — each fights a *validated* finding about our (opposite-quadrant) edge. One real conflict to settle: playbook "scale down in drawdown" vs. posture-plan "bold when down."

3. **Journal vs. bots:** they barely overlap — **2 of 24** journal tickers (**CDE**, **LCID**, both Golden Lion). The human trades high-priced momentum **leaders, mostly shorted**; the bots buy cheap small-cap **laggards, long and averaged down** — literally opposite selection rules. The journal's *winners* (patient longs like SNDK held overnight) resemble the bots' design; its *losers* (impulse shorts) resemble nothing the bots do.

## Data provenance
- Silver Lynx symbols: `data/runs.ndjson`, `margin.ndjson` (2026-06-24→06-30).
- Golden Lion symbols: `data-pull/position-snapshots-since-0620.jsonl` (2026-06-22→08-01, 268 symbols).
- Bot mechanics: `file:line` refs cited inline in [02](02-applicability-to-our-system.md).
