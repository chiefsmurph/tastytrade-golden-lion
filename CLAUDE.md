# CLAUDE.md

First look at any AGENTS.md always!

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # esbuild bundle → build/index.js
npm run typecheck      # tsc --noEmit
npm test               # all tests via Node built-in runner
npm run start:tsx      # run TypeScript directly (dev)
npm run start:build    # run bundled JS (prod)
npm run dev            # watch mode via tsx
```

Run a single test file:
```bash
node --import tsx --test src/bot/tests/evaluate-trading-strategy.test.ts
```

## Architecture

Production options execution engine for Tastytrade. Runs automated, risk-gated trading cycles. Bot is controlled externally via a Unix socket IPC server (40+ JSON commands). External signal feed is optional — the bot is fully functional without it.

> **Deep strategy reference:** [`docs/STRATEGY.v2.md`](docs/STRATEGY.v2.md) is the authoritative, top-to-bottom description of the trading logic — exact thresholds, schedules, circuit breakers, the signal gate, contract selection, and seeding, all with `file:line` refs. This file is the quick map; STRATEGY.v2.md is the territory. When strategy mechanics and hard numbers matter, read it there (and keep it, not this file, current).

### Cycle Flow

Each `runCycle` call (every N minutes during market hours):
1. Pull balances, positions, session state, cached secret signals
2. Build execution targets — time-of-day DTE and exposure % via smooth interpolation (6:30 AM → 12:55 PM)
3. Evaluate each position group → `MANAGE_ALLOCATION` or `CLOSE_POSITION` based on circuit breakers (profit target, stop loss, cooldowns, EOD rules)
4. Generate order plan; size by available capital and bid/mid/ask route weights
5. Execute close orders, then allocation orders, then overnight reductions, then cross-account seeds
6. Append structured NDJSON entry to `data/` run history

### Key Subsystems

**`src/strategy/evaluate-trading-strategy.ts`** — Core strategy state machine. Blends DTE and exposure targets by time of day. Hard circuit breakers: dynamic profit target (40% → 7%), -30% bid stop loss before cutoff, -10% after cutoff, EOD liquidation for margin. The intraday stop additionally requires the **midpoint to confirm** (§6b) and the trigger to **persist across 2 cycles** (§6d, streak state in `src/bot/actions/stop-persistence-store.ts`); the take-profit can also fire on the **midpoint** (§6c). Full schedules and ordering in STRATEGY.v2.md §4 & §6.

**`src/bot/run-cycle-context.ts`** — Builds the full snapshot before execution: pulls position evaluations, applies secret signals and buy weights, sorts groups by priority.

**`src/bot/evaluate-position.ts`** — Groups positions by `UNDERLYING::side` (e.g., `RUM::call`). Computes bid/mid/ask return %s, unrealized P&L, weighted average fill, DTE.

**`src/bot/actions/`** — Two execution paths:
- `manage-allocation.ts` — buys via strike selection (delta-targeted for margin, ITM for cash), quantity sizing, tick-chasing
- `close-position.ts` — sells with mid→ask aggressiveness, up to 10 tick-chase steps every 30s

**`src/strategy/position-gate.ts`** — Cross-account signal gating. Computes `PositionGateResult` (a `maxTargetPct` ceiling) from the feed's consolidated thesis rollup. Thesis score 0–`THESIS_MAX` (**10**) with `willBuy` as +2 icing on top (never required for full marks); source is `manualThesisCount/manualThesisMax` (preferred) or `buyFraction` (0→1.25; >1.0 only with willBuy). Margin seeding requires the full feed thesis (`thesisCount ≥ thesisMax`). See STRATEGY.v2.md §7 for the tier table, per-account scaling (margin 1.33×, willBuy hard gate; cash holdScore/overnight/regime gates), and the buyMult×gateMult quality factor.

**`src/bot/run-cycle-seed.ts`** — Cross-account margin seeding. Iterates cash account evaluations; seeds margin when cash `askReturnPct < -minDownPct` AND the cash position's strategy is still `MANAGE_ALLOCATION`.

**`src/strategy/secret/`** — Optional external signal feed via Socket.IO. Provides `SecretSourcePosition` objects (buy weights, boolean signals, daytrade scores). Bot degrades gracefully if socket is unavailable. Signals from this feed influence both allocation sizing and auto-seed decisions.

**`src/core/market-metrics.ts`** — Provides `ivRank` (0–100) and `impliedVolatility` via `getUnderlyingIvMetrics(symbol)`, cached 5 min. Used to gate entries by IV environment.

**`src/ipc-server.ts`** — Unix socket server. Clients send `{ id, command, args }` JSON lines; server responds with structured JSON. `ipc-client.js` is a reusable client for external consumers.

### Account Model

Two account types with distinct behavior:
- **Margin**: OTM calls targeted to `STRATEGY_MARGIN_TARGET_CALL_DELTA` (default 0.35), liquidates all positions EOD (arms 12:50 PM, `EOD_ARMED_MINUTE`), accumulation cutoff at 12:30 PM. When the OTM pick fails the spread gate on illiquid low-priced names, falls back to the nearest-money ITM strike — gated on signal conviction (`buyWeight > 280`); see STRATEGY.v2.md §8a
- **Cash**: ITM calls for overnight delta hold, accumulation cutoff at 1:00 PM, can seed margin when underwater

Cross-account logic: the cash account evaluation drives margin seeding via `run-cycle-seed.ts` and position gate signals in `src/strategy/position-gate.ts`.

### Import Conventions

- Use `~/` path alias for `src/` (e.g., `import { foo } from "~/core/market-data"`)
- Omit `.ts` extension on imports — bundler resolution via tsx
- Position group keys are `UNDERLYING::side` strings (`::call`, `::put`, `::none`)

### Config

All runtime config via `.env`. Defaults are in-code via `readEnvPct()` / `toBooleanFlag()` helpers. Prefixes: `CORE_` (infra/creds), `BOT_` (orchestration/data), `STRATEGY_` (trading logic), `SECRET_` (signal feed). The July-1 refactor renamed ~30 vars; the boot log warns on obsolete names (see `src/startup-config.ts`). Key categories:
- Tastytrade OAuth2: `CORE_BASE_URL`, `CORE_API_CLIENT_SECRET`, `CORE_API_REFRESH_TOKEN`
- Scheduler: `BOT_RUN_ON_SCHEDULE`, `BOT_RUN_INTERVAL_MS`
- Risk limits: `STRATEGY_MIN_IV_RANK_PCT`, `STRATEGY_MAX_OPTION_SPREAD_PCT`, `STRATEGY_MARGIN_MAX_BUY_EXPOSURE_PCT` / `STRATEGY_CASH_MAX_BUY_EXPOSURE_PCT`
- DTE controls: `STRATEGY_MARGIN_MAX_TARGET_DTE`, `STRATEGY_CASH_MIN_TARGET_DTE`
- Cross-account seeding: `STRATEGY_MARGIN_SEED_FROM_CASH_MIN_DOWN_PCT`, `STRATEGY_CROSS_ACCOUNT_YES_DOWN_PCT`
- Secret feed: `SECRET_SOCKET_URL`, `SECRET_SOCKET_TIMEOUT_MS`, `SECRET_DATA_UPDATE_POSITIONS_KEY`

See `.env.example` and README for the full variable list.
