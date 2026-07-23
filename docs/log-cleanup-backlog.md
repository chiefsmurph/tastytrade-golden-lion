# GL Backlog (for Stephen)

Two sections: **A) Log cleanup** (audit 2026-07-22), and **B) Execution improvements**.

---

# A) Log Cleanup

Current volume: **~80K lines/day**. Top 4 items alone cut it to ~10K (~76% reduction).

---

## Priority 1 — Remove duplicate `Top option candidate for` log
**~20,500 lines/day eliminated**

`src/strategy/option-candidate/selection.ts:361`
```ts
console.log(`Top option candidate for ${symbol}:`, sanitizedResult);
```
This is a **pure duplicate** of the `ipc-response` block logged by `ipc-server.ts` immediately after it. Both log the same sanitized object (~30 fields). Remove this line — the IPC response is the canonical record.

---

## Priority 2 — Collapse IPC triple-logging to single compact line
**~17,000 lines/day eliminated**

`src/ipc-server.ts:334, 347, 400–409`

Every IPC call produces 3 pretty-printed JSON objects with identical content (`received` + `route-hit` have the same id/command/args). `bot:getLastRunGroupsByTickers` alone is 308 calls × 3 entries × ~10 lines = 9,240 lines, mostly returning empty results pre-open.

Fix:
1. Collapse `received` + `route-hit` into a single compact (no `null, 2`) JSON line
2. In `ipc-response`, suppress the `result` field when `ok: true` — the caller has it; only log `result` on `ok: false`

---

## Priority 3 — Summarize `account-balances` to 1 line
**~13,400 lines/day eliminated**

`src/bot/run-cycle-context.ts:319–329`
```ts
console.log(JSON.stringify({ scope: "account-balances", accountNumber, accountBalances }, null, 2));
```
Fires 210×/day (2 accounts × ~105 cycles). Each is a 65-line JSON with 36 fields permanently `"0.0"` (crypto, futures, bonds, index derivatives — never used).

Replace with:
```ts
console.log(JSON.stringify({
  scope: "account-balances",
  accountNumber,
  nlv: accountBalances["net-liquidating-value"],
  derivBP: accountBalances["derivative-buying-power"],
  usedDerivBP: accountBalances["used-derivative-buying-power"],
  maintenanceReq: accountBalances["maintenance-requirement"],
  updatedAt: accountBalances["updated-at"],
}));
```

---

## Priority 4 — Strip broker ack from `Execution results`
**~10,000 lines/day eliminated**

`src/bot/run-cycle.ts:500`
```ts
console.log("Execution results:", JSON.stringify(executionResults, null, 2));
```
Non-empty cycles log 244–891 lines because `orderResponses` contains full Tastytrade broker API response: `buying-power-effect` (15 sub-fields) + `fee-calculation` (with 3 breakdown arrays) per order per route.

Replace `orderResponses` with a summary:
```ts
orderResponses: o.orderResponses?.map(r => ({
  orderId: r.order?.id,
  status: r.order?.status,
  price: r.order?.price,
}))
```

---

## Priority 5 — Suppress empty run cycle banner blocks
**~8,000 lines/day eliminated**

`src/bot/run-cycle-logging.ts:104–154`

5 banner-separated blocks print every cycle per account (GROUP RETURNS / EXECUTION TARGETS / RUN PLAN / STRATEGY DECISIONS). ~90% of cycles are idle and print:
```
No grouped position returns available.
No MANAGE_ALLOCATION groups to show.
No allocation orders planned for this cycle.
No strategy decisions available.
```

Keep the `RUN SNAPSHOT` header every cycle. Gate the 4 subordinate blocks: only print when they have non-empty content, or collapse to a single `No active positions this cycle` line.

---

## Priority 6 — Debounce `[options-mirror]` would-buy lines
**~700 lines/day eliminated**

`src/strategy/secret/options-mirror-evaluator.ts:204–225`

The evaluator fires on every Alpaca tick (~1–3 min). When the candidate set doesn't change, identical would-buy lines repeat for hours. Track a hash of tickers+scores; only log when it changes. Keep the position-count summary line every tick for heartbeat visibility.

---

## Priority 7 — Remove `[secret] cached source positions` duplicate
**~206 lines/day eliminated**

`src/bot/run-cycle-context.ts:371`
```ts
console.log(`[secret] cached source positions: ${cachedSecretPositions.length}`);
```
Already covered by `Secret Socket: connected=true positions=N` in the RUN SNAPSHOT block. Remove.

---

## Priority 8 — Gate `liquidity-gate` logs to failures only
**~500 lines/day eliminated**

`src/strategy/liquidity-gate.ts:208`

Currently logs every candidate evaluation including successful passes. Only failures are interesting for debugging. Default to suppress `passed: true`; always log `passed: false`. Or add `process.env.GL_VERBOSE_LIQUIDITY` guard.

---

## Notes
- Items 1–4 are pure noise removal with no behavior change risk
- Item 5 requires care: make sure the empty-check doesn't swallow legitimate "nothing to do" cycles that should be visible
- After these changes, target log volume is ~10K lines/day vs current 80K

---

# B) Execution Improvements

## B1 — Sell-side chase should start HIGH (at/near ask), not at mid

**File:** `src/bot/actions/close-position.ts`

**Observed problem (PATH close, 2026-07-22 12:53pm PT EOD liquidation):**
The 3 PATH legs were posted at midpoint and two of them filled in **under 100ms**:

| Leg | Size | Limit = Mid | Result |
|-----|------|-------------|--------|
| Jul24 $11  | 29 | $0.13 | 1 filled, 28 still working ("Live") |
| Jul24 $10.5 |  2 | $0.31 | Filled instantly (<100ms, Wolverine) |
| Aug7 $9.5   |  3 | $1.22 | Filled instantly (<100ms, Susquehanna) |

Sub-100ms fills at mid mean the market maker would have paid **more** — we handed them the top half of the spread for free.

**Root cause:** For a sell, the chase starts at `midpointPrice` (line ~330) and `moveClosePriceTowardEdge` only ever walks *down* toward the bid (`getEdgePrice` returns the bid for a sell, line ~78). So the best price the logic can ever achieve is the midpoint on tick 1 — the rest of the chase is strictly worse. Upside is capped at mid by design.

On wide small-cap option spreads (all GL trades), half the spread is real money. Jul24 $11 example: bid ~$0.10 / ask ~$0.16, mid $0.13. Starting at $0.15 and getting a taker = **+15% on that leg** vs mid.

**Proposed fix — start at the ask (or ask − 1 tick), walk DOWN through mid to bid.** Standard "post at the top, concede toward the taker." Split by urgency:

1. **Non-urgent closes** (profit target, intraday harvest): start at ask or ask−1 tick, walk down to bid. All-day horizon — capture the spread aggressively.
2. **Urgent / EOD closes**: start at mid **+ 1–2 ticks** (test for the eager taker we clearly saw today), then fall through mid to bid, crossing to the edge on the final tick to guarantee the clear before the 1pm options cutoff. The chase is 10 moves × 10s = 100s — plenty of room to start high and still guarantee the fill.

Net: no loss of fill certainty (final tick still crosses to bid), only upside on the ticks where a taker was willing to pay up.

**Implementation touch points:**
- `getEdgePrice` / `getCloseTickSize`: span **ask → bid** instead of **mid → bid** for the sell chase.
- `currentPrice` start (line ~330): ask (non-urgent) or mid+1–2 ticks (urgent) instead of `midpointPrice`.
- Keep the urgent final-tick `edgePrice` cross intact.

**Bonus diagnostic — log fill latency.** If the median fill lands under ~2s, that's proof the start price is too generous; could auto-nudge the start toward ask over time.
