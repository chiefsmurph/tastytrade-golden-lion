# Improvements v9 — Second production-data pass

> **Discovery log (2026-07-07).** Source material: the second full trading day on the current build, analyzed from `scripts/pull-today.sh` → `data-pull/2026-07-07/`. Unlike v8 (which was the first post-verify session and focused on WEN/dxLink), **today surfaced five new operational issues** with direct log evidence, distinct from every open v1–v8 item. Cross-checked against STATUS.md before inclusion; adjacencies noted. John also bought LCID stock in both accounts today, which cascaded into the bot buying calls in both accounts — see the LCID note at the end.
>
> The day in one line: **margin −$8 realized / cash −$50 realized**; cash carrying 6 positions overnight (JOBY/ACHR/TE/HTZ/WEN/EOSE, basis ~$952 at cost, mid −$52). The cash damage was entirely WEN (entered 07-06 at 46% spread, gate 0) bleeding out through overnight-reduction — still the same root cause as v8 #1/2. New issues today are mechanical/operational, not strategy.

---

## Infra / reliability

### 1. Overnight-reduction places a 1-lot sell order every single cycle — 85 orders in one day

**File:** [src/bot/run-cycle-overnight-reduction.ts](src/bot/run-cycle-overnight-reduction.ts)

Cash placed **85 overnight-reduction orders** today (confirmed via `executionSummary.overnightReductionPlacedCount`); only **2 filled** (WEN 7:42 AM and WEN 7:46 AM PT, both ledgered). The rest are idle resting limit orders being placed then cancelled-or-expired every ~4-minute cycle.

**Root cause:** the reduction schedule drives `currentExposurePct` down toward a floor (`targetPct`) that is always computed to be ~0.1–0.3% below the current value — so every cycle triggers exactly one `contractsToClose: 1`. Once an order is placed but doesn't fill (e.g. option is illiquid), the *next* cycle sees the same unmet gap and places another 1-lot. The previous order is neither tracked nor cancelled before the new one goes in — it just piles up as a working order that the main cancel sweep discards at the next cycle's open.

**Evidence:** 07:34, 07:38, 07:42 cycle logs all show `{"scope":"overnight-position-reduction","symbol":"WEN","ageDays":1,"currentExposurePct":30.88,"targetPct":30.7,"contractsToClose":1}` → placed each time, filled only at 07:42 fill + 07:46 fill. Reduction orders continued past 13:00 PT (cash accumulation cutoff) through 19:57, when the account is no longer accumulating.

**Fix direction:** Check whether an existing resting reduction order is live before placing a new one. The cancel step already lists live orders each cycle — gate `placeOvernightReductionOrder` on "no open reduction order for this symbol". As a separate concern, decide whether overnight-reduction should run past the accumulation cutoff (it currently runs through EOD).

*New. No v1–v8 overlap.*

---

### 2. Five cash cycles errored HTTP 422 and wrote zeroed run entries

**File:** [src/bot/run-cycle.ts](src/bot/run-cycle.ts), [src/core/tastytrade-client.ts](src/core/tastytrade-client.ts)

Five cycles in the cash account failed with `"error":"Request failed with status code 422"` and wrote a zeroed run entry (`totalCapital: 0, targetExposurePct: 0, snapshot: {null fields}`). The earliest two were at ~04:08 PT (pre-market), the others were interspersed during the main session at 15:59, 18:16, 19:30, 19:43, 19:52 PT. Margin was never affected.

**Evidence:** five lines in `5WU18519-cash.ndjson` with `"totalCapital":0` and `"error":"Request failed with status code 422"`. The PM2 out log shows the bot recovered each time ~60s later with a clean cycle.

**Impact:** The zeroed entries corrupt post-session analytics — they show `targetExposurePct: 0` and `currentExposurePct: 0` which is factually wrong for cycles where positions were held. Any query that iterates run history to track exposure over time will see false floor readings at those timestamps. This aligns with v5 strategy #9 (failed cycle leaves no trace) — but those zero-capital entries are actively worse than missing entries because they look like valid data.

**Fix direction:** On a 422, either retry immediately and write the result, or write an error-typed entry with the actual balances/positions from the last successful snapshot (same fix as v5 #9 but needs to handle partial-state). At minimum, tag error entries so analytics can exclude them (`"entryType": "error"` field).

*Relates to v5 strategy #9 (extends it with cash-specific 422 failure mode and concrete evidence).*

---

### 3. Terminal orders never leave the cancel list — 9+ "not cancellable" attempts per cycle for hours

**File:** [src/bot/execute-position-evaluations.ts](src/bot/execute-position-evaluations.ts), [src/core/tastytrade-client.ts](src/core/tastytrade-client.ts)

Every cycle's cancel sweep tries to cancel **every live order** fetched from the broker, including already-filled and already-cancelled orders. Filled orders return status "not cancellable" from the API, the cancel attempt is logged but the order stays in the account's active order list — and next cycle it's fetched again and retried.

**Evidence:** the 07:34–08:22 window shows 9–14 entries of `"skippedReason": "order is not cancellable"` per cycle for the same set of order IDs (481449357, 481449385, 481444736, 481444729 etc.) across 14 consecutive cycles (~56 minutes). Each cycle fetches all open orders, attempts to cancel each, logs the result — all wasted API calls.

**Impact:** purely operational overhead today (extra API round-trips per cycle, log noise), but a correctness concern too: a "not cancellable" order that *looks* live may be holding buying-power reserves in the bot's view of the account while being already filled at the broker — this can cause the bot to underestimate available BP.

**Fix direction:** After a cancel attempt returns "not cancellable", remove that order ID from future cancel-list consideration (either a local blacklist or re-fetch live orders after the cancel sweep and only retry those that remain open). Also investigate whether the `cancelAllLiveOrders` flow is fetching orders too broadly (e.g. filled orders at the broker still appearing in the "open orders" API endpoint).

*New. Adjacent to v5 code #7 (cancelAllLiveOrders runs twice per cycle) but distinct failure — that's about timing; this is about terminal-state orders staying in the list.*

---

### 4. Buying at the exact accumulation cutoff then force-liquidating within 22 minutes

**File:** [src/bot/evaluate-trading-strategy.ts](src/bot/evaluate-trading-strategy.ts), [src/bot/actions/manage-allocation.ts](src/bot/actions/manage-allocation.ts)

At **12:30:17 PT** — the exact margin accumulation cutoff — the bot placed a 4-contract JOBY buy (2 mid + 2 ask, estimated $67). At **12:52 PT** (`eod-liquidation`) those same contracts were sold at 0.15–0.16 vs fills of 0.16–0.17. Net: −$3–$6 round-trip on a position that lived 22 minutes and was never intended to survive past 12:55.

**Root cause:** the cutoff check is `time >= 12:30` and the buy was placed at 12:30:17, so it passed. The EOD liquidation fired at the next qualifying cycle (12:52). The gap between the "last buy cycle" and the "first EOD liquidation cycle" is at most one run interval (~4 minutes); a buy at cutoff+seconds is guaranteed to be liquidated.

**Evidence:** `manage-allocation-executed-weights` log at `12:30:17` for `JOBY 260717C00009000` qty 4; ledger `eod-liquidation` entries at `12:52:26` and `12:53:31` for the same contract.

**Fix direction:** Add a minimum time-to-accumulation-cutoff gate before placing any new allocation buy — e.g., don't enter if `now > cutoff - runInterval` (margin: `12:30 - 4min = 12:26`). Alternatively gate on "this position will survive at least one full cycle post-fill." Relates to v5 strategy #8 (EOD clock hazard) which identified the chase-timing risk; this is the *buy-side* equivalent — don't buy if EOD liquidation is the likeliest next event for that position.

*Promotes v5 strategy #8 from "possible" to "confirmed with a cost." Has a concrete buy-side fix distinct from the close-urgency fix in v5.*

---

### 5. Dip boost fires but may boost into a position that's about to stop out

**File:** [src/strategy/risk-limits.ts](src/strategy/risk-limits.ts)

Today the margin-position dip boost **did fire** for the first time (TE margin, `dipTargetBoostPct: 0.159` at 08:18 PT) — updating the v8 #3 "never fires" finding. The boost correctly identified TE ask return as borderline negative (~−5% ask). TE was then accumulated through the morning and **stopped out at −30% at 12:25 PT** for −$27.

**Observation:** The boost fires when `askReturnPct` dips past the entry threshold, adding exposure. But it does not consult the stop-loss circuit breaker — specifically, it doesn't check whether the *bid* return (the stop metric) is already near the −30% threshold. If ask is −5% but bid is −25% (wide spread), the boost adds into a position that may be one spread-move from a stop. The boost condition should require that `bidReturnPct > stopLossThreshold + safetyMargin` before lifting the target, not just that `askReturnPct` is dipping.

**Evidence:** `dipTargetBoostPct: 0.159` logged at 08:18 for TE. Ledger shows TE stop-loss at 12:25 (`-33.05% <= -30%`), entered 08:08 PT.

This is different from v8 #3 (which found the boost was blind to spread pain because it used ask-side metric). v8 #3 fix is still needed (re-derive dip trigger on mid/bid). This new finding is about what happens *after* the trigger fires correctly — the boost should also be gated on bid-side health, not just ask-side dip.

*Extends v8 #3. Together: fix the trigger metric (mid/bid based, not ask), AND gate the boost on bid return being far enough from the stop floor.*

---

## LCID / manual stock position note

John bought LCID stock in both Tastytrade accounts today. The secret feed's `SECRET_AUTO_SEED_ON_POSITIONS_UPDATE=true` caused the bot to buy LCID calls in the cash account at 08:11 PT (gate 7, 5% spread — a genuinely clean entry) and in the margin account at ~11:21 PT. The cash LCID call was manually closed (broker-reconcile at 12:53 PT); the margin LCID call was EOD-stopped at −14.3%. The LCID stock positions themselves were not visible to the bot by the final cycle (no `LCID::none` group) — but if they appear in Tastytrade account positions tomorrow morning, add `LCID::none` to `BOT_DO_NOT_TOUCH_GROUPS` before market open or the strategy machine may close them. SOC is the existing precedent.
