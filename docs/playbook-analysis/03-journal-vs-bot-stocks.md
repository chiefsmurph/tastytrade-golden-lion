# 03 — The Trading Journal vs. What Our Bots Actually Buy

_Does the human journal (7/23–8/4) line up with what Golden Lion (stocks) and Silver Lynx (options) traded? How similar/different are the two universes?_

## Data used

- **Silver Lynx** (options, tastytrade): local `data/runs.ndjson` + `margin.ndjson`, window **2026-06-24 → 06-30**. Only 4 underlyings present locally: **EOSE, RUM, SBSW, HTZ**. (Local file is a short window; the live universe is larger, but this is what's on disk.)
- **Golden Lion** (stocks, Alpaca): `data-pull/position-snapshots-since-0620.jsonl`, window **2026-06-22 → 2026-08-01**, **268 distinct symbols**.
- Note: the journal names are **John's own manual/discretionary day-trades**, which the bots' analysis explicitly *excludes*. So this is genuinely "human hand vs. bot hand."

## The overlap: almost none (2 of 24)

| Journal ticker | In Silver Lynx? | In Golden Lion? |
|---|---|---|
| **CDE** (Coeur Mining) | no | **yes — 34×** |
| **LCID** (Lucid) | no | **yes — 226×** |
| CRCL, MSTR, SMCI, RGTI, ONDS, AXTI, AMKR, GLW, SPCX, APLD, ASTS, HOOD, NBIS, AAOI, CRWV, SNDK, PLTR, TEM, UMC, MRVL, WDC, X | no | no |

**22 of the 24 journal names never touched either bot.** The only two that did are the *cheapest, most speculative* names on his list — Lucid (~low-single-digit price EV play) and Coeur (a cheap miner). Both are Golden-Lion (stock-bot) names, not options names.

> Corroborating note from prior sessions: the Silver Lynx options bot once opened **LCID calls that "echoed John's manual Alpaca stock buy."** So LCID is the one documented case where the human hand and the bot hand landed on the same name — and it's one of these two overlaps.

## Why the universes barely intersect

The two universes are selected by *opposite* philosophies:

| | **Journal (John, manual)** | **Bots (Golden Lion / Silver Lynx)** |
|---|---|---|
| Typical names | CRCL, MSTR, SMCI, PLTR, NBIS, CRWV, HOOD, MRVL, WDC, AMKR, ASTS, TEM | HTZ, TE, OPEN, RDW, EOSE, RUM, SOC, TOYO, AMIX, CLF, MARA, ENVX, ERIC, ACHR, CLSK |
| Price tier | mostly **high-priced momentum leaders** (semis / AI / crypto-proxy / fintech), $30–$400+ | mostly **low-priced small-caps**, many sub-$10 / sub-$5 |
| O'Neil label | **leaders** (RS ≥ 80, new highs) | **laggards / speculative** (beaten-down, high-RVOL) |
| Direction | mostly **SHORT** (fading intraday tops) | **LONG** (and averaging down) |
| Holding | intraday / ORB, minutes–hours | multi-cycle, overnight holds, days |
| Selection driver | discretionary charts (VWAP/RSI/MACD, "porsche setups") | quantified signal feed (thesis score, buy-weight, gates) |

This is not a small stylistic difference — it's a **direct contradiction of the playbook's own stated stock-selection rules**:

- The playbook says: *"buy higher-priced, better-quality stocks rather than the lowest-priced,"* *"don't buy stocks with RS ratings in the 40s/50s/60s,"* *"never buy laggards,"* *"buy strength, sell weakness,"* *"NEVER AVERAGE DOWN."*
- The bots do the **opposite**: they buy **cheap, beaten-down small-caps** and **average down** into them (thesis-gated). See [02-applicability-to-our-system.md](02-applicability-to-our-system.md) for the mechanics.

So John, by hand, trades the O'Neil/Minervini way (leaders, momentum, cut fast — mostly by shorting them intraday). The bots he built trade a *mean-reversion / accumulate-the-knife* way. **They are two different traders with two different edges (or non-edges).**

## Which behavior actually worked, in the journal itself

The journal's own scorecard is the tell:

- **Losses / mistakes = the shorts** (CRCL, MSTR, RGTI, ONDS, CDE, AXTI, TEM): _"shorting at the bottom of a cup — it bounces right back up to the rim, STOP DOING THAT."_ Fighting the trend, no pre-market homework, no predefined risk.
- **Wins = the longs held with patience**: UMC ("great buy patience waiting and sell — even more upside"), **SNDK ("great buy and hold overnight for a 7% increase aftermarket")**.

The one journal name whose *winning* behavior (buy, hold overnight for a pop) most resembles what the **bots** are designed to do is **SNDK** — and SNDK is *not* in either bot. The bots' held-overnight logic (Silver Lynx cash account holds ITM calls overnight; Golden Lion overnight carry) is the automated version of exactly that SNDK win — just applied to a completely different, cheaper universe.

## Bottom line for Q3

1. **They barely line up: 2 of 24 (CDE, LCID), both Golden Lion, both the cheapest speculative names on his list.** The one repeat is LCID, which is also the documented human↔bot echo.
2. **The universes are opposites**: human = high-priced momentum *leaders*, mostly *shorted intraday*; bots = low-priced *laggards*, bought *long and averaged down*. The bot design contradicts the playbook's own "buy leaders / never average down / buy strength" rules.
3. **The journal's winners (patient longs: UMC, SNDK-overnight) resemble the bots' design; the journal's losers (impulse shorts) resemble nothing the bots do** — which is a point *for* the bots: they never do the thing that hurt him most (fighting the trend by shorting on impulse without predefined risk).

_See [02-applicability-to-our-system.md](02-applicability-to-our-system.md) for which playbook ideas are worth importing into the bots._
