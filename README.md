# Tastytrade Golden Lion

A production options execution engine for Tastytrade — automated, risk-gated, and fully inspectable.

The scheduler runs a full allocation and risk-management cycle at a configurable interval during market hours. Each cycle enforces entry criteria, sizes positions against real capital, applies strategy-level risk rules, and records structured reasoning for every decision. All workflows are also available on demand over a local Unix IPC socket — candidate discovery, health checks, order placement, and cycle control — with or without the scheduler running.

## System Profile

Golden Lion is built as an execution control plane, not just a script runner.

- Deterministic run cycle: each cycle builds a full context snapshot, evaluates group-level strategy decisions, then executes allocation, close, and seed actions with explicit reasoning recorded for every step.
- Execution quality controls: IV rank filtering and bid/ask spread checks gate every entry. Orders are routed across bid/mid/ask using configurable weights, where each route concedes a different amount of the spread: bid rests at the bid, mid concedes at most a few ticks, and ask starts at the midpoint and chases to the ask on a fast clock — no route pays the full spread instantly.
- Risk-first circuit breakers: strategy logic enforces profit capture targets, drawdown floors, cooldown periods, no-buy cutoffs, and end-of-day position constraints before any order is placed.
- Multi-account aware: the cycle can run account-specific or fan out across all managed accounts, with cash and margin policies — including position sizing and exposure caps — applied independently per account type.
- Session-gated automation: the scheduler checks live Tastytrade session status and only runs during regular equities options windows. Extended-hours sessions are never treated as open.
- Optional signal ingestion: an external feed can influence buy-weighting and trigger auto-seed actions, but the engine is fully operational without it.
- Audit trail by default: each run appends structured NDJSON history (plan, decisions, execution summary, snapshot metrics) for after-action review and debugging.

## Operating Model

At a high level, each cycle follows this sequence:

1. Pull balances, positions, market session state, and optional secret-signal context.
2. Build execution targets (time-of-day DTE, exposure target, bid/mid/ask route weights).
3. Evaluate every position group against strategy rules (profit capture, drawdown floors, cooldowns, no-buy cutoffs, EOD behavior).
4. Generate an execution plan and route order sizing by available capital and route weights.
5. Execute and record outcomes, including placement/skips, close actions, overnight reductions, and cross-account seed decisions.

## Runtime Topology

```mermaid
flowchart TD
    PM2["PM2 / supervisor"] -->|manages| Process

    subgraph Process["tastytrade-golden-lion process"]
        direction TB
        IPC["IPC Server\n(Unix socket)"]
        Sched["Market-Open Scheduler\n(optional)"]
        Cycle["Run Cycle"]
        Tasty["Tastytrade API"]

        IPC -->|"bot:runCycle"| Cycle
        Sched -->|"market open + interval elapsed"| Cycle
        Cycle --> Tasty
    end

    SecretFeed["Secret Feed\n(optional)"] -->|signal updates| Process
    CLI["node run &lt;command&gt;"] -->|Unix socket| IPC
    ExtClient["ipc-client.js\n(another Node process)"] -->|Unix socket| IPC
```

## Code Architecture

The source tree is split into three layers, each with a matching env var prefix:

| Layer | Directory | Env prefix | Responsibility |
|---|---|---|---|
| Core | `src/core/` | `CORE_` | Tastytrade API client, market data, balances, sessions, option chain snapshots |
| Bot | `src/bot/` | `BOT_` | Run cycle orchestration, scheduling, order execution, data persistence |
| Strategy | `src/strategy/` | `STRATEGY_` | Trading decisions — DTE/exposure targets, entry filters, risk limits, seed logic, option candidate selection |

The optional external signal feed lives under `src/strategy/secret/` and uses `SECRET_` env vars.

Dependencies flow one way: `strategy` → `core`, `bot` → `core`, `bot` → `strategy`. The IPC server commands follow the same namespacing: `core:` for infrastructure queries, `bot:` for execution and cycle control, `strategy:` for decision-layer introspection.

## Setup

### 1. Clone and Install

```bash
git clone <repo-url> ~/code/tastytrade-golden-lion
cd ~/code/tastytrade-golden-lion
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# open .env and fill in required values (see credentials section below)
```

### 3. Obtain API Credentials

`CORE_API_CLIENT_SECRET` and `CORE_API_REFRESH_TOKEN` come from Tastytrade's OAuth2 flow. Follow the [Tastytrade OAuth2 guide](https://developer.tastytrade.com/oauth/) to register an application and obtain these values. The SDK automatically refreshes the access token at runtime — you only need to supply the long-lived refresh token.

## Environment Variables

Env vars are organized by the layer that owns them: `CORE_` for infrastructure, `BOT_` for orchestration, `STRATEGY_` for trading logic, and `SECRET_` for the optional external signal feed.

### Core (required)

- `CORE_BASE_URL` — Tastytrade API base URL. Defaults to `https://api.tastyworks.com`.
- `CORE_API_CLIENT_SECRET` — OAuth2 client secret from Tastytrade.
- `CORE_API_REFRESH_TOKEN` — Long-lived refresh token from Tastytrade's OAuth2 flow.

### Core (optional overrides)

- `CORE_IPC_SOCKET` — Override the Unix socket path for the IPC server.
- `CORE_OPTION_MARKET_SNAPSHOT_TTL_MS` — Cache TTL for option chain snapshot lookups. Defaults to `30000`; set to `0` to disable.
- `CORE_CASH_ACCOUNT_MAX_BUYING_POWER_PCT` — Maximum fraction of cash buying power the bot can deploy in a day. Defaults to `0.6`, capped at `0.9`.

### Bot

- `BOT_RUN_ON_SCHEDULE` — Set to `true` to start the market-open scheduler when the process boots. Defaults to `false`.
- `BOT_RUN_INTERVAL_MS` — Scheduler interval in milliseconds while the market is open.
- `BOT_RUN_INTERVAL_MINUTES` — Scheduler interval in minutes. Used when `BOT_RUN_INTERVAL_MS` is not set.
- `BOT_DATA_DIR` — Override the root data directory. Defaults to `data/`; run history and the position registry live in `runs/` and day reports in `day-reports/` beneath it.
- `BOT_DO_NOT_TOUCH_GROUPS` — Comma-separated group keys the bot should leave alone.
- `BOT_READ_ONLY_ACCOUNTS` — Comma-separated account numbers the bot can inspect but should not trade.
- `BOT_MAX_SEED_ORDER_COST` — Maximum estimated dollar cost for a single seed order. Defaults to `200`.

### Strategy: Seed Thresholds

- `STRATEGY_MARGIN_SEED_FROM_CASH_MIN_DOWN_PCT` — Minimum cash-position ask-return loss percentage before the bot considers seeding the margin account. Leave unset to disable.
- `STRATEGY_MARGIN_SEED_FROM_CASH_MAX_DOWN_PCT` — Maximum loss percentage allowed for margin seeding. Prevents seeding when the cash position is already too close to the bid stop-loss floor. Defaults to `14`.
- `STRATEGY_CASH_SEED_FROM_MARGIN_MIN_DOWN_PCT` — Minimum margin-position loss percentage before considering seeding the cash account. Leave unset to disable.
- `STRATEGY_CASH_SEED_FROM_MARGIN_MAX_DOWN_PCT` — Maximum loss percentage for cash-from-margin seeding. Defaults to `20`.
- `STRATEGY_MAX_ASK_RETURN_PERC_FOR_BUY` — Maximum ask-return threshold for buy orders. Unset by default; `.env.example` uses `0.2`.

### Strategy: Position Gate Signal Settings

- `STRATEGY_CROSS_ACCOUNT_YES_DOWN_PCT` — How far down the cash position must be before it generates a cross-account yes signal. Defaults to `10`.
- `STRATEGY_GATE_BASIC_PERCENT_OF_BALANCE_THRESHOLD` — `percentOfBalance` base for basic stock yes qualification. Time-scaled: half the base at window start, rising to the base by 1pm. Keep below the strong threshold so the basic bar stays easier. Defaults to `25`.
- `STRATEGY_GATE_STRONG_PERCENT_OF_BALANCE_THRESHOLD` — `percentOfBalance` base for strong stock yes qualification (with `qualityToBuy`). Time-scaled the same way. Defaults to `30`. Legacy alias: `STRATEGY_GATE_STRONG_STOCK_YES_MAX_PCT`.
- `STRATEGY_GATE_BASIC_DAYTRADE_SCORE_THRESHOLD` — Daytrade score base for basic stock yes qualification (in addition to `qualityToBuy`). Time-scaled: half the base at window start, tightening to the base by 1pm (scores build magnitude through the session). Defaults to `-40`.
- `STRATEGY_GATE_STRONG_DAYTRADE_SCORE_THRESHOLD` — Daytrade score base for strong stock yes qualification (with `qualityToBuy`). Time-scaled the same way. Defaults to `-100`. Legacy alias: `STRATEGY_GATE_STRONG_DAYTRADE_SCORE_MAX` (positive magnitude).
- `STRATEGY_GATE_SINGLE_YES_MAX_TARGET_PCT` — Maximum target exposure with one yes signal. Defaults to `0.15`.
- `STRATEGY_GATE_BASIC_YES_MAX_TARGET_PCT` — Maximum target exposure with only a basic stock yes signal. Defaults to `0.10`.
- `STRATEGY_GATE_BOTH_YES_MAX_TARGET_PCT` — Maximum target exposure when both yes signals are true. Defaults to `0.25`.
- `STRATEGY_GATE_STRONG_YES_MAX_TARGET_PCT` — Maximum target exposure with a strong stock yes signal. Defaults to `0.35`.
- `STRATEGY_MARGIN_MAX_TARGET_MULTIPLIER` — Multiplier applied to the gate ceiling for margin accounts. Defaults to `1.33`.
- `STRATEGY_MARGIN_CROSS_ACCOUNT_THRESHOLD_MULTIPLIER` — Makes the cross-account threshold stricter for margin accounts. Defaults to `2`.
- `STRATEGY_GATE_BOOLEAN_BOOST_PCT` — Additional max target percentage per favorable boolean signal. Defaults to `0.03`.

### Strategy: Stop Loss Floors

- `STRATEGY_INTRADAY_STOP_LOSS_PCT` — Intraday bid-return loss floor before the bot cuts off accumulation. Defaults to `30`.
- `STRATEGY_EOD_STOP_LOSS_PCT` — End-of-day bid-return loss floor after the accumulation cutoff. Defaults to `10`.

### Strategy: Position Sizing and Exposure

- `STRATEGY_MAX_OPTION_SPREAD_PCT` — Maximum bid/ask spread as a fraction of the midpoint. Defaults to `0.3`.
- `STRATEGY_MARGIN_MAX_BUY_EXPOSURE_PCT` — Maximum fraction of total capital used for one margin allocation action. Defaults to `0.12`.
- `STRATEGY_CASH_MAX_BUY_EXPOSURE_PCT` — Maximum fraction of total capital used for one cash allocation action. Defaults to `0.05`.
- `STRATEGY_MARGIN_DIP_TARGET_BOOST_MAX_PCT` — Maximum boost to a margin group's target exposure as its ask loss deepens from `2%` to `12%`, applied only while boolean signals stay good (`>= 4`). Unset disables the boost.
- `STRATEGY_MAX_ALLOCATION_BUY_POSITION_MULTIPLE` — Cap on a single allocation buy as a multiple of the group's current market value (e.g. `3` lets a `$87` position add at most `~$261` in one action), applied on top of the pct-of-capital caps. Unset disables the cap.
- `STRATEGY_OVERNIGHT_REDUCTION_DAYS_TO_SELLOFF` — Calendar days until a cash overnight position should be fully sold off. Defaults to `6`.
- `STRATEGY_OVERNIGHT_REDUCTION_START_FLOOR_PCT` — Exposure floor percentage on day 1 of overnight reduction; interpolates linearly to `0` by the selloff day. Defaults to `20`.
- `STRATEGY_MIN_IV_RANK_PCT` — Minimum IV rank (`0`–`100`) required before entering a position. Defaults to `20`; set to `0` to disable.
- `STRATEGY_MARGIN_TARGET_CALL_DELTA` — Target absolute delta for OTM call strike selection on margin accounts. Defaults to `0.35`.
- `STRATEGY_MARGIN_MAX_TARGET_DTE` — Hard ceiling on target DTE for margin accounts. Defaults to `7`.
- `STRATEGY_CASH_MIN_TARGET_DTE` — Hard floor on target DTE for cash accounts. Defaults to `7`.

### Secret Feed (Optional)

If these are omitted or the feed is disconnected, the runtime continues normally and all IPC workflows remain available.

- `SECRET_SOCKET_URL` — Private feed socket URL.
- `SECRET_SOCKET_TIMEOUT_MS` — Timeout for feed requests in milliseconds. Defaults to `5000`.
- `SECRET_DATA_UPDATE_POSITIONS_KEY` — Positions key inside the secret feed payload.
- `SECRET_AUTO_SEED_ON_POSITIONS_UPDATE` — Set to `true` to allow auto-seeding when position updates arrive. Defaults to `false`.
- `SECRET_AUTO_SEED_ON_TICKER_RECS_UPDATE` — Set to `true` to allow auto-seeding when ticker recommendations update. Defaults to `false`.
- `SECRET_AUTO_SEED_START_TIME` — Start of the auto-seed window in `HH:mm` format. Defaults to `06:30`.
- `SECRET_AUTO_SEED_COOLDOWN_MS` — Minimum delay between secret-feed auto-seeds for the same symbol. Defaults to `600000`.

## Running Tests

```bash
npm test
```

Runs the built-in Node test runner against `src/**/*.test.ts` via `tsx`. Note that `npm run typecheck` and the test suite verify code correctness — they don't exercise live API calls or the scheduler loop.

## Typecheck And Build

This project usually runs directly from TypeScript via `tsx`.

```bash
npm run typecheck
npm run build
```

- `typecheck` validates types only.
- `build` creates a bundled entrypoint at `build/index.js`.

## Run With IPC

`node run` is a thin CLI wrapper over `ipc-client.js`. It opens a JSON request over the local Unix socket to the running server and prints the result. The server must be running first.

Start the server in one terminal:

```bash
npm run start:tsx
```

Or run the build:

```bash
npm run start:build
```

The server listens on a local Unix socket (default: `.tastytrade-golden-lion.sock`).

In another terminal, send commands through IPC.

### Core / Market Data Examples

```bash
node run core:getBidAskForSymbol AAPL
node run core:getUnderlyingPrice AAPL
node run core:fetchOptionChainWithVolume RUM
node run core:getBalanceSummary
node run core:getCurrentEquitiesSession
node run core:isEquityOptionsMarketOpen
```

### Candidate / Health Examples

```bash
node run bot:getOptionCandidates RUM call
node run strategy:getTopOptionCandidateForSymbol RUM call <MARGIN_ACCOUNT>
node run strategy:getTopOptionCandidateForSymbol RUM call <CASH_ACCOUNT>
node run strategy:getOptionHealthForSymbol RUM call
node run strategy:getOptionHealthForSymbol RUM call 14
```

`strategy:getOptionHealthForSymbol` returns target checks for `7`, `14`, and `30` DTE and includes summary fields like `healthyTargets`, `missingTargets`, and `fallbackTargets`.

### Allocation / Run Cycle Examples

```bash
node run bot:getCurrentAllocationBudget
node run strategy:getTimeOfDayExecutionTargets 10:14
node run bot:getRecentRunHistory 20
node run bot:getRunCyclePreview
node run bot:runCycleLogOnly
node run bot:runCycle
node run bot:seedSymbol RUM call
node run bot:purchaseSymbol RUM 1000
node run strategy:getSecretSocketStatus
node run bot:getLastRunGroupsByTickers RUM,TSLA
```

### Day Report Examples

```bash
node run bot:getDayReport                          # latest snapshot for all accounts
node run bot:getDayReport <MARGIN_ACCOUNT>                 # history for one account
node run bot:getDayReport <MARGIN_ACCOUNT> 2026-06-30      # specific date
node run bot:getDayTrend                                   # live snapshot vs last stored baseline
node run bot:getDayTrend <MARGIN_ACCOUNT>                  # single account
node run bot:getClosedPositionsToday                       # all positions closed today with realized P&L
node run bot:recordDayReport                               # force-record a snapshot now (bypasses 1pm gate)
node run bot:recordDayReport <MARGIN_ACCOUNT>              # single account
```

`bot:purchaseSymbol` format:

```text
bot:purchaseSymbol <symbol> <dollars> [call|put] [accountNumber]
```

## Supported IPC Commands

```text
core:getBidAskForSymbol <symbol> [timeoutMs]
core:getUnderlyingPrice <symbol> [timeoutMs]
core:getPositionsAndBalances [accountNumber]
core:getBalanceSummary [accountNumber]
core:cancelAllLiveOrders [accountNumber]
core:fetchOptionChainWithVolume <symbol>
core:getCurrentEquitiesSession
core:isEquityOptionsMarketOpen
core:listCommands
bot:getOptionCandidates <symbol> [call|put]
bot:getCurrentAllocationBudget [accountNumber]
bot:seedSymbol <symbol> [call|put] [accountNumber]
bot:purchaseSymbol <symbol> <dollars> [call|put] [accountNumber]
bot:getRecentRunHistory [limit]
bot:getLastRunGroupsByTickers <commaSeparatedSymbols>
bot:getLastRunCycle
bot:getRunCyclePreview [accountNumber]
bot:runCycleLogOnly [accountNumber]
bot:runCycle [accountNumber]
bot:startMarketOpenScheduler
bot:stopMarketOpenScheduler
bot:getMarketOpenSchedulerStatus
bot:getDayReport [accountNumber] [date YYYY-MM-DD]
bot:getDayTrend [accountNumber]
bot:getClosedPositionsToday [accountNumber]
bot:recordDayReport [accountNumber]
strategy:getTopOptionCandidateForSymbol <symbol> [call|put] [accountNumber]
strategy:getOptionHealthForSymbol <symbol> [call|put] [targetDTE]
strategy:getOptionMarketSnapshotCacheStats
strategy:resetOptionMarketSnapshotCacheStats [clearCache=true|false]
strategy:getTimeOfDayExecutionTargets <HH:mm>
strategy:getSecretSocketStatus
strategy:debugSecretExecutionTargetForSymbol <symbol> [askReturnPerc] [timeSinceLastActionMinutes] [currentExposurePct]
```

## Data Storage

All persistent data lands under `data/` (or `BOT_DATA_DIR` if set).

| Path | Format | Contents |
|---|---|---|
| `data/runs/{account}-{type}.ndjson` | NDJSON | One entry per bot cycle: position evaluations, strategy decisions, orders placed, snapshot metrics |
| `data/runs/position-registry.json` | JSON | Per-position open/close timestamps and closing order IDs; used for overnight detection and position age |
| `data/day-reports/{account}-{type}.ndjson` | NDJSON | One entry per account per day (recorded after 1pm PST on first post-cutoff cycle): net liq, capital, per-position bid/mid/ask unrealized returns |

**Run history** is the primary audit trail — every cycle is recorded regardless of whether orders were placed. Useful for debugging strategy decisions and reconstructing what the bot saw at any point in time.

**Position registry** tracks when each option contract was opened and closed. Used internally to identify overnight positions for forced close-at-open logic.

**Day reports** are end-of-day account snapshots. Used by `bot:getDayTrend` to diff current live state against the prior day's baseline.

## Market-Open Scheduler

The scheduler uses Tastytrade's session endpoint:

- `GET /market-time/equities/sessions/current`

It runs only during regular equities session windows. Extended-hours sessions are not treated as open for options execution.

Scheduler behavior is stateful and introspectable so operators can verify timing and in-flight status over IPC.

| State | Meaning | Next transition |
|---|---|---|
| `stopped` | Scheduler not started | → `waiting-for-open` on start |
| `waiting-for-open` | Polling every 60s; market closed (or last run errored) | → `running` when market opens and interval has elapsed |
| `running` | `runBotCycle()` in-flight | → `waiting-for-next-run` on success; → `waiting-for-open` on error |
| `waiting-for-next-run` | Market is open; holding until next interval elapses | → `running` when interval elapses; → `waiting-for-open` if market closes |

Auto-start scheduler on boot:

```bash
BOT_RUN_ON_SCHEDULE=true npm run start:tsx
```

Manual scheduler control via IPC:

```bash
node run bot:startMarketOpenScheduler
node run bot:getMarketOpenSchedulerStatus
node run bot:stopMarketOpenScheduler
```

## Running With PM2

An `ecosystem.config.cjs` is included for production deployment with PM2.

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

The config registers the app as `tastytrade-golden-lion`, runs `build/index.js` in fork mode with `autorestart: true`, and sets `BOT_RUN_ON_SCHEDULE=true` by default. Credentials and runtime overrides should be set in `.env` — PM2 inherits the process environment, so `.env` is still loaded via `dotenv` at startup.

To regenerate the startup hook so PM2 survives a reboot:

```bash
pm2 startup   # follow the printed instruction
pm2 save
```

Common PM2 operations:

```bash
pm2 status
pm2 logs tastytrade-golden-lion
pm2 restart tastytrade-golden-lion
pm2 stop tastytrade-golden-lion
```

## Reusable IPC Client

From another local Node process, you can call the server directly with the reusable client:

```js
import { sendIpcCommand } from "./ipc-client.js";

const optionHealth = await sendIpcCommand(
  "strategy:getOptionHealthForSymbol",
  ["RUM", "call"],
  {
    socketPath: "/absolute/path/to/tastytrade-golden-lion/.tastytrade-golden-lion.sock",
  },
);
```

If you copy `ipc-client.js` into another project, either pass `socketPath` explicitly or override `socketFileName` / `envVarName` when resolving socket paths.

## How It Works

- `npm run start:tsx` starts the IPC server from TypeScript via `tsx`.
- `npm run build` bundles the server with `esbuild`.
- `npm run start:build` runs the bundled output.
- `ipc-client.js` sends JSON requests over `node:net` to the local socket.
- `node run ...` is a thin CLI wrapper over `ipc-client.js`.
- The server resolves a command route and returns JSON responses.
- On startup, the runtime installs a quote-streamer fatal error guard that exits the process on unrecoverable feed conditions so PM2 (or another supervisor) can restart cleanly.
- The process handles SIGTERM and SIGINT gracefully: the scheduler is stopped, any in-flight cycle is allowed up to 30 seconds to complete, and all live orders on managed accounts are cancelled before exit.

## Execution Strategy Highlights

- Time-adaptive exposure control: target DTE and target exposure shift over the session, with account-specific behavior for cash vs margin.
- Price-route allocation: orders are split across bid/mid/ask using weighted routes, then contract counts are allocated against real capital limits.
- Controlled aggressiveness: routes differ in spread concession, not just starting price — bid rests without chasing, mid concedes up to 3 ticks, ask starts at the midpoint and chases to the full ask on a faster clock (straight to the ask only when the spread is already tight). A chase step is only placed after the previous order's cancellation is confirmed.
- Risk-first circuit breakers: strategy logic can force closes on profit capture, severe loss thresholds, and end-of-day constraints. Hard-risk closes (stop-loss triggers and EOD liquidations) arm at 12:50 PT and tick every 10 seconds instead of the normal 30, jumping straight to the edge price on the final move.
- Execution-time re-evaluation: before each sell order is sent, the strategy is re-checked against the live bid price. If the circuit breaker no longer holds (e.g. the position recovered after the cycle snapshot), the close is skipped. EOD liquidations bypass this check — the clock, not the price, is the trigger.
- Overnight handling: margin positions flagged as overnight can be force-closed at open, while cash accounts can execute gradual overnight reductions.
- Cross-account seeding: cash-account conditions can trigger margin-account seed flow when configured thresholds are met.

## Operational Notes

- If IPC calls fail to connect, start or restart the server.
- API calls depend on valid `.env` credentials.
- Socket path can be overridden with `CORE_IPC_SOCKET`.
- Run interval can be tuned with `BOT_RUN_INTERVAL_MS` or `BOT_RUN_INTERVAL_MINUTES`.
- All data output can be redirected with `BOT_DATA_DIR`.
- Source imports intentionally use extensionless TypeScript paths because runtime execution goes through `tsx` with bundler-style resolution.
