# Tastytrade Golden Lion

An event-driven options execution engine built with Node.js and TypeScript.

This project is a decoupled execution client for Tastytrade with optional external signal subscriptions.

The runtime is always the same: it can subscribe to live state broadcasts from the core Golden Lion brain over a private socket, and it also supports direct manual IPC commands for candidate discovery, health checks, and order execution.

## System Profile

Golden Lion is built as an execution control plane, not just a script runner.

- Deterministic run cycle: each cycle builds a full context snapshot, evaluates group-level strategy decisions, then executes allocation, close, and seed actions with explicit reasoning.
- Multi-account aware: the cycle can run account-specific or fan out across all managed accounts, with cash and margin policies applied independently.
- Session-gated automation: the scheduler checks live market session status and only runs during regular equities options windows.
- Optional signal ingestion: secret socket updates can influence buy-weighting and trigger controlled auto-seed actions, but the bot remains fully operable without the feed.
- Audit trail by default: each run appends structured NDJSON history (plan, decisions, execution summary, snapshot metrics) for after-action review.

## Operating Model

At a high level, each cycle follows this sequence:

1. Pull balances, positions, market session state, and optional secret-signal context.
2. Build execution targets (time-of-day DTE, exposure target, bid/mid/ask route weights).
3. Evaluate every position group against strategy rules (profit capture, drawdown floors, cooldowns, no-buy cutoffs, EOD behavior).
4. Generate an execution plan and route order sizing by available capital and route weights.
5. Execute and record outcomes, including placement/skips, close actions, overnight reductions, and cross-account seed decisions.

The result is an execution engine that is explainable to engineers, inspectable by operators, and legible to product and risk stakeholders.

## Setup

### 1. Install Dependencies

```bash
mkdir -p ~/code/tastytrade-golden-lion
cd ~/code/tastytrade-golden-lion
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# open .env and set required values
```

## Environment Variables

### Required

- `BASE_URL` (default: `https://api.tastyworks.com`)
- `API_CLIENT_SECRET`
- `API_REFRESH_TOKEN`

### Optional Runtime Controls

#### Scheduling And Runtime Behavior

- `BOT_RUN_ON_SCHEDULE` (`true` or `false`, default `false`)
- `BOT_RUN_INTERVAL_MS` (scheduler run interval in milliseconds while market is open)
- `BOT_RUN_INTERVAL_MINUTES` (scheduler run interval in minutes, used when `BOT_RUN_INTERVAL_MS` is unset)

#### Account Protection / Trade Guardrails

- `BOT_DO_NOT_TOUCH_GROUPS` (comma-separated group keys to protect from trading)
- `BOT_READ_ONLY_ACCOUNTS` (comma-separated account numbers treated as read-only)
- `BOT_MAX_OPTION_SPREAD_PCT` (max bid/ask spread as a fraction of midpoint; default `0.3`)
- `BOT_MAX_SEED_ORDER_COST` (max estimated cost in dollars for one seed order; default `500`)
- `BOT_MIN_IV_RANK_PCT` (minimum IV rank 0-100 required to enter; default `20`, set `0` to disable)
- `BOT_OPTION_MARKET_SNAPSHOT_TTL_MS` (cache TTL for option snapshot lookups; default `30000`, set `0` to disable)

#### Cash / Margin Allocation Controls

- `BOT_MARGIN_MAX_BUY_EXPOSURE_PCT` (max fraction of total capital per margin allocation action; default `0.012`)
- `BOT_CASH_MAX_BUY_EXPOSURE_PCT` (max fraction of total capital per cash allocation action; default `0.05`)
- `BOT_CASH_ACCOUNT_MAX_BUYING_POWER_PCT` (max fraction of cash buying power deployed daily; default `0.6`, capped at `0.9`)
- `BOT_MARGIN_TARGET_CALL_DELTA` (target absolute delta for OTM call strike selection on margin accounts; default `0.35`)

#### Cross-Account / Signal Gates

- `BOT_MARGIN_SEED_FROM_CASH_MIN_DOWN_PCT` (minimum cash-position drawdown required before triggering margin seed)
- `BOT_CASH_MARGIN_YES_DOWN_PCT` (cross-account ask-return threshold for margin-yes signal; default `10`)
- `BOT_MARGIN_CROSS_ACCOUNT_THRESHOLD_MULTIPLIER` (multiplier on margin threshold; default `2`)
- `BOT_CASH_BASIC_STOCK_YES_MIN_PCT_OF_BALANCE` (minimum `percentOfBalance` for basic stock yes; default `10`)
- `BOT_CASH_STRONG_STOCK_YES_MIN_PCT_OF_BALANCE` (minimum `percentOfBalance` for strong stock yes; default `30`)
- `BOT_CASH_SINGLE_YES_MAX_TARGET_PCT` (max target exposure with any single yes signal; default `0.15`)
- `BOT_CASH_BOTH_YES_MAX_TARGET_PCT` (max target exposure when margin yes and basic stock yes are both true; default `0.25`)
- `BOT_CASH_STRONG_YES_MAX_TARGET_PCT` (max target exposure when strong stock yes is present; default `0.35`)
- `BOT_MARGIN_MAX_TARGET_MULTIPLIER` (multiplier for deriving margin per-position cap from cash cap; default `1.33`)

#### Overnight Risk Management

- `BOT_CASH_OVERNIGHT_REDUCTION_FLOOR_PCT` (minimum cash-position exposure target during overnight reduction; default `0.08`)

#### Secret Feed Integration (Optional)

If these are omitted or disconnected, the runtime continues normally and manual IPC workflows remain fully available.

- `SECRET_SOCKET_URL` (private feed socket URL)
- `SECRET_SOCKET_TIMEOUT_MS` (feed timeout ms; default `5000`)
- `SECRET_DATA_UPDATE_POSITIONS_KEY` (positions key inside secret payload)
- `SECRET_AUTO_SEED_ON_POSITIONS_UPDATE` (`true` or `false`, default `false`)
- `SECRET_AUTO_SEED_ON_TICKER_RECS_UPDATE` (`true` or `false`, default `false`)
- `SECRET_AUTO_SEED_START_TIME` (auto-seed window start in `HH:mm`; default `06:30`)
- `SECRET_AUTO_SEED_COOLDOWN_MS` (minimum delay between secret auto-seeds for the same symbol; default `600000`)

#### Paths / Overrides

- `TASTYTRADE_BOT_SOCKET` (override IPC socket path)
- `TASTYTRADE_BOT_RUN_HISTORY_DIR` (override run-history directory; default `data/`)

## Typecheck And Build

This project usually runs directly from TypeScript via `tsx`.

```bash
npm run typecheck
npm run build
```

- `typecheck` validates types only.
- `build` creates a bundled entrypoint at `build/index.js`.

## Run With IPC

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
node run bot:getTopOptionCandidateForSymbol RUM call
node run bot:getOptionHealthForSymbol RUM call
node run bot:getOptionHealthForSymbol RUM call 14
```

`bot:getOptionHealthForSymbol` returns target checks for `7`, `14`, and `30` DTE and includes summary fields like `healthyTargets`, `missingTargets`, and `fallbackTargets`.

### Allocation / Run Cycle Examples

```bash
node run bot:getCurrentAllocationBudget
node run bot:getTimeOfDayExecutionTargets 10:14
node run bot:getRecentRunHistory 20
node run bot:getRunCyclePreview
node run bot:runCycleLogOnly
node run bot:runCycle
node run bot:seedSymbol RUM call
node run bot:purchaseSymbol RUM 1000
node run bot:getSecretSocketStatus
node run bot:getLastRunGroupsByTickers RUM,TSLA
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
bot:getOptionCandidates <symbol> [call|put]
bot:getTopOptionCandidateForSymbol <symbol> [call|put]
bot:getOptionHealthForSymbol <symbol> [call|put] [targetDTE]
bot:getOptionMarketSnapshotCacheStats
bot:resetOptionMarketSnapshotCacheStats [clearCache=true|false]
bot:getCurrentAllocationBudget [accountNumber]
bot:getSecretSocketStatus
bot:debugSecretExecutionTargetForSymbol <symbol> [askReturnPerc] [timeSinceLastActionMinutes] [currentExposurePct]
bot:seedSymbol <symbol> [call|put] [accountNumber]
bot:getTimeOfDayExecutionTargets <HH:mm>
bot:getRecentRunHistory [limit]
bot:getLastRunGroupsByTickers <commaSeparatedSymbols>
bot:getRunCyclePreview [accountNumber]
bot:runCycleLogOnly [accountNumber]
bot:runCycle [accountNumber]
bot:purchaseSymbol <symbol> <dollars> [call|put] [accountNumber]
bot:getLastRunCycle
bot:startMarketOpenScheduler
bot:stopMarketOpenScheduler
bot:getMarketOpenSchedulerStatus
core:listCommands
```

## Market-Open Scheduler

The scheduler uses Tastytrade's session endpoint:

- `GET /market-time/equities/sessions/current`

It runs only during regular equities session windows. Extended-hours sessions are not treated as open for options execution.

Scheduler behavior is stateful and introspectable (`stopped`, `waiting-for-open`, `waiting-for-next-run`, `running`) so operators can verify timing and in-flight status over IPC.

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

## Reusable IPC Client

From another local Node process, you can call the server directly with the reusable client:

```js
import { sendIpcCommand } from "./ipc-client.js";

const optionHealth = await sendIpcCommand(
  "bot:getOptionHealthForSymbol",
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

## Execution Strategy Highlights

- Time-adaptive exposure control: target DTE and target exposure shift over the session, with account-specific behavior for cash vs margin.
- Price-route allocation: orders are split across bid/mid/ask using weighted routes, then contract counts are allocated against real capital limits.
- Controlled aggressiveness: route execution can tick up toward ask in bounded steps to improve fill probability without unconstrained chasing.
- Risk-first circuit breakers: strategy logic can force closes on profit capture, severe loss thresholds, and end-of-day constraints.
- Overnight handling: margin positions flagged as overnight can be force-closed at open, while cash accounts can execute gradual overnight reductions.
- Cross-account seeding: cash-account conditions can trigger margin-account seed flow when configured thresholds are met.

## Operational Notes

- If IPC calls fail to connect, start or restart the server.
- API calls depend on valid `.env` credentials.
- Socket path can be overridden with `TASTYTRADE_BOT_SOCKET`.
- Run interval can be tuned with `BOT_RUN_INTERVAL_MS` or `BOT_RUN_INTERVAL_MINUTES`.
- Run-history output can be redirected with `TASTYTRADE_BOT_RUN_HISTORY_DIR`.
- Source imports intentionally use extensionless TypeScript paths because runtime execution goes through `tsx` with bundler-style resolution.
