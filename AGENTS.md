# AGENTS.md — tastytrade-golden-lion

Automated options-trading engine for Tastytrade. **This system places real-money
orders.** Treat every broker call, scheduler action, production config change, and
deploy as high-impact. Default to read-only, offline work — never infer permission
to trade from the presence of credentials, a running socket, an existing command,
or prior live use. This file is the router; deep content lives in the files it links.

## What this is

Single-process TypeScript/ESM app run under PM2 (`ecosystem.config.cjs`), driven by
an N-minute market-hours cycle per account and controlled over a Unix-socket IPC
server (`src/ipc-server.ts`; `ipc-client.js` is the reusable client). Layers, with
one-way dependencies `bot → strategy → core`:

- `src/core/`     — Tastytrade API, quotes (dxLink), sessions, balances, market metrics. Env: `CORE_`
- `src/strategy/` — decisions: time-of-day targets, position gate, sizing, risk limits. Env: `STRATEGY_` / `SECRET_`
- `src/bot/`      — orchestration, order execution, NDJSON run history. Env: `BOT_`
- `src/tools/`    — read-only diagnostics.

## Commands (all offline / safe)

- Build: `npm run build` · Typecheck: `npm run typecheck` · Test: `npm test` · Dev watch: `npm run dev`
- Code-health gate: `fallow` runs via `.githooks/pre-commit` and `.claude/hooks/fallow-gate.sh`.
  A **fail verdict blocks `git commit` and `git push`.** New findings block; inherited ones don't.
  Don't add `fallow-ignore` without an explanatory comment.
- `npm test && npm run typecheck` must pass before any commit. Report the exact failing
  command and root cause if not — never claim a pass from historical output or source test counts.

## Permission tiers

**Allowed without live-operation authorization:** read files and git history; run
`fallow`, `typecheck`, `test`, `build`; edit code and docs within the requested scope;
use fake/sanitized fixtures.

**Requires explicit authorization for the exact action:** reading or changing secrets
in `.env`; calling the broker or the private signal feed; starting the app or scheduler;
running mutating IPC commands; restarting or deploying the PM2 process; changing any risk
threshold or production profile; migrating or deleting anything under `data/`.

**Never:** weaken a safety invariant as incidental cleanup; guess an account number for a
mutating command; let a test place a live order; edit `.env` or files under `data/` (live
ledgers/registries); print or commit credentials, raw account numbers, or private trade
data; treat implemented code as promoted to live.

## Read-order by task

| Task touches…                         | Read first                                              |
|---------------------------------------|---------------------------------------------------------|
| `src/strategy/` or `src/bot/actions/` | `docs/STRATEGY.v2.md` (authoritative strategy reference) |
| Ops, PM2, crash-loops, logs, deploy   | `docs/OPERATIONS.md`                                     |
| Env vars / tuning                     | `.env.example` (closest to code) + README env list      |
| Anything else                         | `README.md`, then `CLAUDE.md`                            |

## Precedence when sources disagree

`code` > `.env.example` > `docs/STRATEGY.v2.md` > `README.md` > older/dated docs.
If two sources disagree, say so in your reply and fix the stale one in the same change.

## Non-negotiables

1. Close/chase execution loops: a cancel must be **CONFIRMED** before re-placing (double-order guard).
2. Skip-reason strings are load-bearing — they're parsed downstream. Don't casually reword them.
3. Position-group keys are `UNDERLYING::side` (double colon: `::call`, `::put`, `::none`).
   `BOT_DO_NOT_TOUCH_GROUPS` needs the double colon or it silently no-ops.
4. Never `pm2 kill` — it takes down every app the shared daemon manages, not just this one.
   See `docs/OPERATIONS.md`; prefer `pm2 delete tastytrade-golden-lion` + start for this app alone.
5. Config resolves via `readEnvPct` / `readEnvInt` / `toBooleanFlag`; a present-but-blank env
   var means "use the in-code default." Never `parseInt(x ?? "d")` — it NaNs on blank.
6. Update the docs in the same commit as the code they describe.

When sources conflict on a safety question, stop the live-mutating work, report it, and use
the stricter interpretation until the owner reconciles it.
