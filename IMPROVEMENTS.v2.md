# Improvements v2

## Code Quality

- [ ] **`getMidpointPrice` duplicated across execution files** — Identical helper defined independently in `manage-allocation.ts:80` and `close-position.ts:36`. Move once to `order-utils.ts` and import from there. Divergence risk: one was updated, the other wasn't.

- [ ] **`readEnvPct` / `toBooleanFlag` redefined in multiple modules** — `cash-position-gate.ts:22-33` reimplements both helpers that already exist elsewhere in the codebase. Centralize in `~/core/config-helpers.ts` and import everywhere.

- [ ] **`blendBySchedule` sorts a constant array on every call** — `evaluate-trading-strategy.ts:433` does `[...schedule].sort(...)` 5× per `getTimeOfDayExecutionTargetsForMinute` invocation, which runs every cycle tick. All schedules are compile-time constants — pre-sort them at module load or inline them already sorted.

- [ ] **`getPositionGroupExecutionTargets` drops `accountType` on DTE lookup** — At `evaluate-trading-strategy.ts:365`, the internal call to `getTimeOfDayExecutionTargets(currentTime)` omits `accountType`, so it always uses `"unknown"`. This means `BOT_MARGIN_MAX_TARGET_DTE` and `BOT_CASH_MIN_TARGET_DTE` are silently ignored when computing per-group DTE targets for seed-driven allocation.

- [ ] **Weight normalization missing after `applyPositionSizeWeightCaps`** — `evaluate-trading-strategy.ts:74-81` caps `askWeight` and redistributes the delta to `midWeight`, both rounded to 2 decimals. Floating point can leave `bid + mid + ask ≠ 1.0`. No assertion or normalization exists downstream, so quantity splits can be silently wrong. Add a final normalization step that assigns any residual to `midWeight`.

## Strategy

- [ ] **No same-symbol cooldown after a profitable close** — When `CLOSE_POSITION` fires at profit, there is no guard preventing an immediate re-entry into the same symbol on the next cycle. The existing 10-minute cooldown is per-position `lastActionTime`, not per-symbol post-close. Add a short-lived (30–60 min) per-symbol re-entry block after a profitable exit to prevent buying back freshly closed premium at a worse cost basis.

- [ ] **Secret signal staleness not checked** — `goodBooleanScore` and `willBuy` treat a 4-hour-old cached signal the same as a live one. If the secret socket disconnects mid-session, stale `willBuy=true` flags silently inflate conviction scores and can trigger seeding on a thesis that has expired. Add a `lastUpdatedAt` check — signals older than N minutes (e.g., 20) should be treated as unavailable.

- [ ] **Profitable positions use flat weights instead of patient bid-lean** — `getPositionGroupExecutionTargets` (`evaluate-trading-strategy.ts:344-362`) only shifts weights toward ask when a position is losing. When `askReturnPerc > 0` (position is up), the code defaults to 33/33/33 because the `aggressivenessFactor` clamps to 0. A position already in profit should lean toward bid (patient fill) when adding contracts — tightening the avg cost basis rather than chasing. Mirror the losing-position logic: shift toward bid weight when up ≥ 5%.

- [ ] **No per-symbol concentration cap** — The account-level `maxBuyPowerPct` gate exists, but a single symbol can absorb 100% of the remaining buying power if it is the only name below target exposure. A per-symbol cap (e.g., 20–25% of total effective capital) would improve concentration risk and prevent a single position from dominating the book during a focused dip.

- [ ] **Margin seeding ignores the margin account's own stress level** — `run-cycle-seed.ts:241-266` seeds based solely on the cash account being down `minDownPct`–`maxDownPct`. It does not check whether the margin account itself is already underwater. A margin account at −20% overall should not accept new seeds from cash regardless of signal quality — it has no margin of safety left to absorb further drawdown. Gate `maybeSeedMarginAccountFromCashAccount` on a maximum allowed margin-account drawdown before seeding fires.
