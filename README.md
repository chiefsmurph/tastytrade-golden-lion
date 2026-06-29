# Tastytrade Playground (minimal)

This small Node.js scaffold fetches and displays positions and account balances from Tastytrade.

Setup

1. Create project folder and install dependencies:

```bash
mkdir -p ~/code/tastytrade-playground
cd ~/code/tastytrade-playground
npm install
```

2. Copy and fill `.env` from the example:

```bash
cp .env.example .env
# open .env and set the required values
```

Required `.env` values (from `.env.example`):

- `BASE_URL` (default: `https://api.tastyworks.com`)
- `API_CLIENT_SECRET`
- `API_REFRESH_TOKEN`

Optional runtime env values:

- `BOT_RUN_ON_SCHEDULE` (`true` or `false`, default `false`)
- `BOT_DO_NOT_TOUCH_GROUPS` (comma-separated group keys to protect from trading)
- `BOT_READ_ONLY_ACCOUNTS` (comma-separated account numbers treated as read-only)
- `BOT_MARGIN_SEED_FROM_CASH_MIN_DOWN_PCT` (minimum down percentage on a cash account position to trigger a margin account seed during a run cycle; e.g. `10` means down 10%; omit or leave blank to disable)
- `BOT_CASH_MARGIN_YES_DOWN_PCT` (cash position gate: margin account's ask-return must be below this percentage to count as a "margin YES" signal; default `10`)
- `BOT_CASH_BASIC_STOCK_YES_MIN_PCT_OF_BALANCE` (cash position gate: minimum `percentOfBalance` from the secret feed for a "basic stock YES"; default `10`)
- `BOT_CASH_STRONG_STOCK_YES_MIN_PCT_OF_BALANCE` (cash position gate: minimum `percentOfBalance` from the secret feed for a "strong stock YES"; default `30`)
- `BOT_CASH_SINGLE_YES_MAX_TARGET_PCT` (cash position gate: max `targetAccountExposure` fraction when any single YES signal is present; default `0.15`)
- `BOT_CASH_BOTH_YES_MAX_TARGET_PCT` (cash position gate: max fraction when margin YES + basic stock YES are both present; default `0.25`)
- `BOT_CASH_STRONG_YES_MAX_TARGET_PCT` (cash position gate: max fraction when strong stock YES is present (with or without margin YES); default `0.35`)
- `BOT_MARGIN_MAX_TARGET_MULTIPLIER` (multiplier applied to cash per-position max when computing the equivalent margin cap; default `1.33`)
- `BOT_RUN_INTERVAL_MS` (scheduler run interval in milliseconds while market is open)
- `BOT_RUN_INTERVAL_MINUTES` (scheduler run interval in minutes; used when `BOT_RUN_INTERVAL_MS` is unset)
- `BOT_MAX_OPTION_SPREAD_PCT` (max bid/ask spread as a fraction of midpoint allowed when selecting an option contract; default `0.3` = 30%)
- `BOT_GLOBAL_MAX_BUY_EXPOSURE_PCT` (hard cap on total portfolio buy exposure as a fraction of total capital; default `0.16` = 16%)
- `BOT_CASH_ACCOUNT_MAX_BUYING_POWER_PCT` (max fraction of cash account buying power to deploy per day to avoid GFV; default `0.6` = 60%; capped at 0.9)
- `BOT_MAX_SEED_ORDER_COST` (max estimated cost in dollars for a single seed order; default `500`)
- `BOT_OPTION_MARKET_SNAPSHOT_TTL_MS` (cache TTL for option chain + underlying snapshots used by candidate/health lookups; default `30000`, set `0` to disable cache)
- `BOT_MIN_IV_RANK_PCT` (minimum IV rank 0–100 required to enter a new position; default `20`; set `0` to disable the gate)
- `BOT_MARGIN_TARGET_CALL_DELTA` (target absolute delta for OTM call strike selection on margin accounts; default `0.35`)
- `SECRET_SOCKET_URL` (socket URL for the secret feed)
- `SECRET_SOCKET_TIMEOUT_MS` (secret socket timeout in milliseconds; default `5000`)
- `SECRET_DATA_UPDATE_POSITIONS_KEY` (positions source key inside secret payloads)
- `SECRET_AUTO_SEED_ON_POSITIONS_UPDATE` (`true` or `false`, default `false`)
- `SECRET_AUTO_SEED_ON_TICKER_RECS_UPDATE` (`true` or `false`, default `false`)
- `SECRET_AUTO_SEED_START_TIME` (auto-seed window start time in `HH:mm`, default `06:30`)
- `SECRET_AUTO_SEED_COOLDOWN_MS` (minimum delay between secret auto-seeds for the same symbol; default `600000`)
- `TASTYTRADE_BOT_SOCKET` (override IPC socket path)
- `TASTYTRADE_BOT_RUN_HISTORY_DIR` (override directory for run history files; default: `data/`)

3. Type-check the project:

```bash
npm run typecheck
```

4. Optional: create a bundled JavaScript build:

```bash
npm run build
```

This project normally runs directly from TypeScript via `tsx`. `typecheck` validates types only, while `build` creates a bundled server entrypoint at `build/index.js`.

Run With IPC

Start the IPC server in one terminal:

```bash
npm run start:tsx
```

Or run the bundled build instead:

```bash
npm run start:build
```

This starts a long-running Node process that listens on a local socket at `.tastytrade-playground.sock`.

In a second terminal, call commands through IPC:

```bash
node run core:getBidAskForSymbol AAPL
```

```bash
node run core:getUnderlyingPrice AAPL
```

```bash
node run core:fetchOptionChainsWithVolume RUM
```

```bash
node run bot:getOptionCandidates RUM call
```

```bash
node run bot:getTopOptionCandidateForSymbol RUM call
```

```bash
node run bot:getOptionHealthForSymbol RUM call
```

This returns keyed target checks for `7`, `14`, and `30` DTE plus a compact summary of `healthyTargets`, `missingTargets`, and `fallbackTargets`, along with `canOpenNewPosition` computed from the current time-of-day target DTE.

You can also provide an explicit target DTE override for eligibility:

```bash
node run bot:getOptionHealthForSymbol RUM call 14
```

```bash
node run bot:getCurrentAllocationBudget
```

```bash
node run bot:getTimeOfDayExecutionTargets 10:14
```

Pass `HH:mm` in Pacific time.

```bash
node run bot:getRecentRunHistory 20
```

```bash
node run bot:getRunCyclePreview
```

```bash
node run bot:runCycle
```

```bash
node run bot:purchaseSymbol RUM 1000
```

Supported IPC commands

- `core:getBidAskForSymbol <symbol> [timeoutMs]`
- `core:getUnderlyingPrice <symbol> [timeoutMs]`
- `core:getPositionsAndBalances [accountNumber]`
- `core:fetchOptionChainsWithVolume <symbol>`
- `bot:getOptionCandidates <symbol> [call|put]`
- `bot:getTopOptionCandidateForSymbol <symbol> [call|put]`
- `bot:getOptionHealthForSymbol <symbol> [call|put] [targetDTE]`
- `bot:getOptionMarketSnapshotCacheStats`
- `bot:resetOptionMarketSnapshotCacheStats [clearCache=true|false]`
- `bot:getCurrentAllocationBudget [accountNumber]`
- `bot:getTimeOfDayExecutionTargets <HH:mm>`
- `bot:getRecentRunHistory [limit]`
- `bot:getRunCyclePreview [accountNumber]`
- `bot:runCycle [accountNumber]`
- `bot:purchaseSymbol <symbol> <dollars> [call|put] [accountNumber]`
- `bot:getLastRunCycle`
- `bot:startMarketOpenScheduler`
- `bot:stopMarketOpenScheduler`
- `bot:getMarketOpenSchedulerStatus`
- `core:listCommands`

Market-open scheduler

The tastytrade market sessions docs expose `GET /market-time/equities/sessions/current`, which is the right source of truth for whether the equity-options session is open. This bot now uses that endpoint and only runs the live four-minute loop during the regular equities session.

Important: equity options trade during the regular session only. Extended-hours equity sessions are not treated as open for this scheduler.

To auto-start the scheduler when the IPC server boots:

```bash
BOT_RUN_ON_SCHEDULE=true npm run start:tsx
```

To manage it manually over IPC:

```bash
node run bot:startMarketOpenScheduler
node run bot:getMarketOpenSchedulerStatus
node run bot:stopMarketOpenScheduler
```

For another Node process on the same machine, prefer the reusable IPC client instead of spawning `node run ...`:

```js
import { sendIpcCommand } from "./ipc-client.js";

const optionHealth = await sendIpcCommand(
	"bot:getOptionHealthForSymbol",
	["RUM", "call"],
	{
		socketPath: "/absolute/path/to/tastytrade-playground/.tastytrade-playground.sock",
	},
);
```

If you copy `ipc-client.js` into another project, the only repo-specific default is the socket filename. You can either pass `socketPath` explicitly, or override `socketFileName` / `envVarName` when resolving the socket path.

How it works

- `npm run start:tsx` starts the IPC server from the TypeScript source via `tsx`.
- `npm run build` bundles the IPC server to `build/index.js` with `esbuild`.
- `npm run start:build` runs the bundled server with Node.
- `ipc-client.js` sends JSON requests over `node:net` to the local socket.
- `node run ...` is a thin CLI wrapper around `ipc-client.js`.
- The server executes the command and returns the JSON response.
- The IPC server logs incoming requests, route hits, unknown commands, and outgoing responses.

Notes

- If the client cannot connect, start or restart the IPC server with `npm run start:tsx`.
- The Tastytrade calls depend on the values in `.env`.
- The socket path can be overridden with `TASTYTRADE_BOT_SOCKET`.
- Open-market scheduler run interval can be customized with `BOT_RUN_INTERVAL_MS` or `BOT_RUN_INTERVAL_MINUTES`.
- Run history directory can be overridden with `TASTYTRADE_BOT_RUN_HISTORY_DIR` (default: `data/`).
- Source imports use extensionless TypeScript paths because runtime execution goes through `tsx` with bundler-style resolution.
