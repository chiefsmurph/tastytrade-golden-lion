# Fallow Audit — 2026-07-22

## Summary

| Category | Count |
|---|---|
| Complexity findings | **69** (10 critical, 17 high) |
| Unused exports | **45** |
| Unused types | **21** |
| Circular deps | **17** |
| Unused files | **2** |
| Existing `fallow-ignore` suppressions | **50** (48 are `complexity`) |
| Code duplication | **None** (0.6% — clean) |

**Goal:** Zero functional changes. Decrease complexity, remove dead surface, eliminate fallow-ignore comments.

---

## Tier 1 — Auto-fixable (run first, ~30 seconds)

```bash
npx fallow fix --dry-run --format json --quiet   # preview
npx fallow fix --yes --format json --quiet       # apply
```

Removes the `export` keyword from 45 unused exports. These are internal symbols that were accidentally exposed. No logic changes.

---

## Tier 2 — Unused Types (delete the declarations)

These 21 types are defined but never referenced. Delete them outright:

| File | Type/Interface |
|---|---|
| `src/bot/actions/order-utils.ts:9` | `OrderLeg` |
| `src/bot/purchase-symbol.ts:24` | `PurchaseSymbolRouteOrder` |
| `src/core/market-sessions.ts:14` | `EquitiesSessionsCurrentPayload` |
| `src/core/tastytrade-client.ts:60` | `TypedTastytradeClient` |
| `src/core/types.ts:109` | `InstrumentType` |
| `src/core/types.ts:180` | `TastytradeOptionChainsWithVolumes` |
| `src/strategy/option-candidate/types.ts:2` | `OptionMarketSnapshotCacheStats` |
| `src/strategy/option-candidate/types.ts:41` | `OptionHealthCandidateResult` |
| `src/strategy/option-candidate/index.ts:2–9` | `OptionHealthCandidateResult`, `OptionHealthForSymbolResult`, `OptionHealthGateDecision`, `OptionHealthSummary`, `TopOptionCandidateForAccountResult`, `OptionMarketSnapshotCacheStats` (all re-exports of types already in `types.ts`) |
| `src/strategy/secret/index.ts:26–37` | `DebugSecretExecutionTargetInputs`, `DebugSecretExecutionTargetPayload`, `SecretDataUpdatePayload`, `SecretSourcePosition`, `SecretTickerRecPick`, `SecretTickerRecsUpdate`, `SecretPositionSignals` |

> **Caution on `secret/index.ts` types:** These may be referenced by the external socket feed consumer. Verify before deleting:
> ```bash
> grep -rn "SecretSourcePosition\|SecretTickerRecPick\|SecretDataUpdatePayload" src/
> ```

---

## Tier 3 — Unused Files

| File | Action |
|---|---|
| `src/bot/index.ts` | Orphaned barrel — check contents then delete |
| `src/tools/regime-sizing-backtest.mjs` | Analysis script — safe to delete if not actively used |

---

## Tier 4 — Complexity: Extract Helper Functions

**Rule:** Get each function under cyclomatic 15 / cognitive 15 by extracting named sub-functions. Do not change any logic — just move code into helpers called sequentially.

### Priority 1 — The Monster

**`src/bot/actions/manage-allocation.ts:818` — `manageAllocationForGroup`**
- cyclomatic=98, cognitive=74, **478 lines**, 6 params
- Split into at least 5–6 named sub-functions:

| Extract | Suggested Name |
|---|---|
| Strike selection logic | `selectStrikeForAllocation()` |
| Quantity sizing | `computeOrderQuantity()` |
| Tick-chase loop | `buildTickChaseOrders()` |
| Held contract fallback | `resolveHeldFallback()` |
| Spread gate check | `passesSpreadGate()` |

### Priority 2 — High Impact

**`src/bot/actions/close-position.ts:195` — `closePosition`**
- cyclomatic=43, cognitive=70, 221 lines
- Extract: price aggressiveness ramp, tick-chase step loop, order routing decision

**`src/bot/run-cycle.ts:192` — `runBotCycle`**
- cyclomatic=36, cognitive=46, 342 lines
- Extract each phase into a named helper called in sequence: close orders, allocation orders, overnight reduction, cross-account seed

**`src/bot/purchase-symbol.ts:46` — `purchaseSymbol`**
- cyclomatic=51, cognitive=16, 201 lines (high cyclomatic, low cognitive = mostly linear conditional chains)
- Extract: route weight computation, order leg building

**`src/strategy/option-candidate/selection.ts:164` — `buildTopOptionCandidateResult`**
- cyclomatic=49, cognitive=36, 264 lines
- Extract: individual filtering pipeline stages into named steps

### Priority 3 — Medium (cyclomatic 11–23)

| File | Function | cyc | cog | Lines |
|---|---|---|---|---|
| `src/tools/probe-option-chain.ts:35` | `main` | 23 | 9 | 96 |
| `src/bot/execute-position-evaluations.ts:210` | `executePositionEvaluations` | 21 | 23 | 209 |
| `src/bot/run-cycle-logging.ts:157` | `logExecutionTargetsByGroup` | 21 | 32 | 99 |
| `src/bot/evaluate-position.ts:81` | `createPositionQuoteSnapshot` | 20 | 11 | 56 |
| `src/core/option-service.ts:387` | `removeListener` | 16 | 20 | 33 |
| `src/core/option-service.ts:548` | `merge` | 15 | 27 | 27 |
| `src/core/market-sessions.ts:109` | `inferIsOpen` | 15 | 10 | 39 |
| `src/strategy/secret/secret-auto-seed.ts:345` | `maybeAutoSeedSymbol` | 13 | 13 | 57 |

### Priority 4 — Lower (cyclomatic 9–12, suppress candidates if refactor not worth it)

| File | Function | cyc | cog |
|---|---|---|---|
| `src/bot/run-cycle.ts:102` | `<arrow>` | 12 | 6 |
| `src/strategy/option-candidate/selection.ts:222` | `sortedCandidates` | 12 | 14 |
| `src/tools/probe-iv-rank.ts:37` | `summarize` | 12 | 4 |
| `src/strategy/secret/secret-auto-seed.ts:461` | `maybeAutoSeedFromSecretPositions` | 11 | 12 |
| `src/core/option-service.ts:269` | `fetchOptionVolumesInner` | 11 | 9 |
| `src/bot/get-last-run-cycle.ts:4` | `getLastRunCycle` | 11 | 12 |
| `src/core/market-data.ts:29` | `extractBidAsk` | 11 | 8 |
| `src/core/market-metrics.ts:51` | `getUnderlyingIvMetrics` | 10 | 9 |
| `src/core/default-account.ts:45` | `<arrow>` | 10 | 5 |
| `src/bot/option-contracts.ts:107` | `chooseOptionCandidates` | 9 | 6 |
| `src/bot/market-open-scheduler.ts:69` | `runSchedulerTick` | 9 | 9 |

---

## Tier 5 — Circular Dependencies

17 cycles that all collapse to **two root causes**:

### Root Cause A — `tastytrade-client.ts` ↔ `execute-position-evaluations.ts`

Affected cycle examples:
```
close-position.ts → tastytrade-client.ts → execute-position-evaluations.ts
manage-allocation.ts → tastytrade-client.ts → execute-position-evaluations.ts
evaluate-position.ts → tastytrade-client.ts → execute-position-evaluations.ts
market-data.ts → tastytrade-client.ts → option-service.ts
```

**Fix:** `tastytrade-client.ts` should not import from `execute-position-evaluations.ts`.
Find what `tastytrade-client` needs from that file and either:
- Move it to a shared `src/core/types.ts` or `src/core/interfaces.ts`
- Pass it via dependency injection rather than a direct import

This one surgical cut will collapse most of the 17 cycles at once.

### Root Cause B — `manage-allocation.ts` → `option-candidate` → `effective-buying-power.ts`

```
manage-allocation.ts → option-candidate/index.ts → option-candidate/account.ts → effective-buying-power.ts
```

**Fix:** Move the shared interface that `account.ts` needs from `effective-buying-power.ts` into a dedicated types file so the circular reference is broken.

---

## Verification

After all changes, run:

```bash
npx fallow dead-code --format json --quiet
npx fallow health --format json --quiet --complexity
npm run typecheck
npm test
```

Then remove the 50 `fallow-ignore-next-line complexity` comments from files that were refactored. That's the final cleanup that gets us to zero suppressions.
