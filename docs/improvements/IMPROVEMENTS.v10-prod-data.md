# Improvements v10 — Week review + entry/exit-liquidity pass

> **Discovery log (2026-07-14).** Source material: the full run history in `data/runs/` (both accounts, 06-24 → 07-14), the per-day `data/day-reports/`, and today's PM2 out log. This pass steps back from single-day mechanics to the **two-week shape** of the account, then focuses on the hazard the latest change (margin ITM entry) introduces. Cross-checked against STATUS.md and v8/v9 before inclusion; adjacencies noted.
>
> The window in one line: **both accounts carried unrealized losses driven by a burst of entries on 07-06/07-07 that decayed, plus an inability to exit illiquid names.** The engine is heavily gated — it placed buys on only 3 of 14 margin sessions and 1 of 14 cash sessions, and seeded once in the entire window.

---

## The shape of the two weeks

Placed (filled) orders per day, from `data/runs/*.ndjson`:

| | Margin buys | Cash buys | Seeds (either) | Notable |
|---|---|---|---|---|
| 07-06 | 14 | 6 | 0 | main entry burst |
| 07-07 | 22 | 0 | 0 | cash **85 closes** (tick-chase storm, see v9 #1) |
| 07-10 | 3 | 0 | 1 | only seed in the window |
| all other days | 0 | 0 | 0 | idle |

Two structural facts fall out of this table:

1. **The bot barely trades, then bleeds while idle.** Entries cluster on two days; the rest of the window is zero-buy while NLV drifts down. The NLV decline is decay + exit failure on a small number of positions, not churn.
2. **Cross-account seeding is effectively dead** — one fire in ~14 sessions despite being a core designed feature. Consistent with the 07-02 seed-blocker findings (per-action cap, BP skips, null booleans). This needs a fix-or-retire decision.

---

## Liquidity / exits

### 1. The entry-side spread gate is blocking *exits*, trapping losers

**File:** [src/bot/actions/close-position.ts](src/bot/actions/close-position.ts), [src/strategy/spread-thresholds.ts](src/strategy/spread-thresholds.ts)

The clearest single failure this week. Cash spent 07-14 trying to close its worst position (a call group sitting near −39% mid) and **filled 1 of 35 attempts**. The other 34 were rejected by the spread gate on the **sell** side, with reasons like `Morning spread gate active (110.20% spread > 5.00% max)`, `104.00% spread`, `98.04% spread`, `63.16% spread`. The bot wants out and physically cannot get out.

**Evidence:** 34 skipped close records for the same contract across today's cash cycles, all `Morning spread gate active (... spread > ... max)`; a single `placedOrder: true`. The margin account shows the same shape on its wide-spread ITM holding (33.71% spread → close skipped at the EOD window).

**Impact:** an *entry* liquidity ceiling is being applied to *exits*. A stop-loss or EOD liquidation should be allowed to cross the spread to the bid — being unable to exit a −39% position because its spread is wide is the worst possible time for the gate to bind. This is the mechanism turning decaying entries into locked-in losses.

**Fix direction:** split the gate into entry-side and exit-side ceilings. Exits (especially `isUrgentClose` stops / EOD) should bypass the spread ceiling and cross toward/through the bid. At minimum, exempt urgent closes.

**Reconciliation:** STATUS.md lists "EOD/take-profit closes bypass spread gate" as shipped 2026-07-02 — but these closes were still blocked by `Morning spread gate active`. Either the bypass does not cover this path (stop-loss / non-EOD / this specific gate), or it has regressed. Confirm which before building #1; the fix may be re-connecting an existing bypass rather than adding a new one.

*Extends the v10-list "close-side spread guard" item with direct 1-of-35 evidence.*

---

### 2. "Roach-motel" pre-trade check before any entry

**File:** [src/bot/actions/manage-allocation.ts](src/bot/actions/manage-allocation.ts)

The complement to #1: rather than only fixing exits, stop entering names we won't be able to exit. Before any buy, estimate the *exit* spread and reject the entry if it exceeds an exit-liquidity ceiling. This is the source-level prevention for the trap in #1 — the two wide-spread ITM names that dominated the week's pain would both have been screened out.

*New. Directly motivated by the margin ITM change (see Hazards).*

---

### 3. Stuck-position escalation

**File:** [src/bot/actions/close-position.ts](src/bot/actions/close-position.ts)

When a close is skipped or unfilled for N consecutive cycles (this week: 34), the bot silently retries the same limit forever. Escalate instead: widen the limit toward/through the bid on each retry, and alert after a threshold. Right now a trapped position generates no signal that it is trapped.

*New. Adjacent to #1 (same file) but distinct: #1 is about the gate, this is about persistence/escalation once past it.*

---

## Hazards in the latest change (margin ITM entry)

### 4. Freeing ITM *entries* while exits stay trapped is the core risk

**File:** [src/bot/actions/manage-allocation.ts](src/bot/actions/manage-allocation.ts) (ITM fallback §8a), [docs/STRATEGY.v2.md](../STRATEGY.v2.md) §8a/§8b

Today's change widens the on-ramp to ITM names on low-priced illiquid underlyings. Item #1 shows the off-ramp is broken for exactly those names. **We have widened entry into a road with no exit.** As of 07-14 the ITM fallback has fired **zero** times in production (the fallback scope never appears in the logs), so this is a forward-looking hazard, not yet a realized one — which is precisely why #1/#2 should land *before* the ITM path sees real usage.

**Fix direction:** gate the ITM entry path on exit-liquidity (#2), and/or hold it behind a flag until the exit-side spread fix (#1) is deployed. Add a dedicated log line every time ITM-fallback eligibility is evaluated (pass/fail + which gate) so the first real fires produce data instead of silence.

*New.*

### 5. Average-down guard governs only one of the two ITM paths

**File:** [src/bot/actions/manage-allocation.ts](src/bot/actions/manage-allocation.ts) (`getHeldContractFallbackCandidate`)

The margin average-down guard (block held-adds when `ask > weightedAverageFill`) correctly disciplines the **held-contract** fallback, but the **fresh-chain ITM** fallback can still open a *new* strike with no price-reference discipline. Intentional today, but worth stating: the two ITM paths have different price governance.

*New. Documents a known gap, not a bug.*

---

## Protection robustness (do-not-touch)

### 6. do-not-touch is enforced cosmetically at the decision layer and structurally at a single downstream filter

**File:** [src/bot/run-cycle-context.ts:341](../../src/bot/run-cycle-context.ts#L341), [src/bot/execute-position-evaluations.ts:224](../../src/bot/execute-position-evaluations.ts#L224)

`computeStrategyDecisions` still returns `CLOSE_POSITION` for a protected group and merely **prefixes** the reason with `DO_NOT_TOUCH group configured -`. The actual protection lives entirely in one downstream filter (`actionableEvaluations` / `actionableCloseEvaluations`). Any close path that does not route through that exact filter will act on a protected group.

**Evidence (07-14, exact):** a protected ITM group in margin reached the EOD `CLOSE_POSITION` decision and **2 close orders were built and recorded** while the protection env was not yet live — they were skipped only because the 33.71% spread tripped the gate. ~5 minutes later the `DO_NOT_TOUCH` prefix appears in the decisions and close orders drop to 0. Protection now works, but it survived the gap by illiquidity, not by design.

**Impact:** protection is a single point of failure, and the decision record actively says "close" for positions we never intend to close. A future executor that trusts the decision action would sell a protected group.

**Fix direction:** resolve the decision itself to `HOLD`/`DO_NOT_TOUCH` for protected groups (not just a reason prefix) so protection is not re-derived by every executor. Add an IPC `protect`/`unprotect` command so a live position can be shielded without an `.env` edit + restart (which is what created the ~5-minute exposure window).

*New. Adjacent to the do-not-touch double-colon operational note; this is about enforcement architecture, not config format.*

### 7. Protection disables stops — concentration + no floor

**File:** [src/bot/execute-position-evaluations.ts](src/bot/execute-position-evaluations.ts)

A do-not-touch group also has its −30% stop and EOD liquidation disabled. On 07-14 the single protected ITM group represented the large majority of margin capital, i.e. most of the book had no downside floor. This is an intended consequence of protection, but it argues for (a) a **concentration cap** that flags any group exceeding ~60% of account capital, and (b) a **protected-position alert** that fires when a shielded group drops past a threshold, since nothing automated will act.

*New.*

---

## Observability

### 8. Day-reports carry unrealized P&L only — no realized attribution

**File:** [src/bot/day-report.ts](src/bot/day-report.ts) (or the day-report writer)

Day-reports carry no per-trade / per-symbol realized breakdown. Add a realized-P&L rollup per symbol per day so NLV changes can be attributed to specific positions rather than inferred from account-level deltas.

*New.*

### 9. "Why no trade today" summary

Most sessions are zero-buy. Emit one aggregate line per cycle (or per day) naming the dominant binding constraint (IV rank / spread / exposure cap / thesis score), so idleness is explainable rather than silent. Pair with instrumenting *why buys only fired on 3 of 14 days* — is the gating correctly cautious or broken?

*New. Relates to the seeding fix-or-retire decision above.*

### 10. Fill-quality log (planned mid vs. actual fill)

Record planned mid vs. actual fill on every close to quantify tick-chase slippage — the 85-close day (07-07) and the 34-retry day (07-14) are both bleeding through execution quality that is currently invisible.

*New.*

---

## Priority

Given the margin ITM entry is deployed but unproven (zero fires): land **#1 and #6 first** (exit-side spread + protection robustness), then **#2** (roach-motel pre-trade), before the ITM path gets meaningful production usage. Everything else is observability and risk-management scaffolding that makes the above measurable.
