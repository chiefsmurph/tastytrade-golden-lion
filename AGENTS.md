# AGENTS.md — tastytrade-silver-lynx

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
- **Run `npm run test:coverage` before committing.** `.fallowrc.json` reads coverage from
  `coverage/coverage-final.json`, which is **gitignored** — a fresh clone or worktree has none, so
  fallow falls back to `"coverage_source":"estimated"` (0% assumed) and CRAP = `CC²·(1−cov)³+CC`
  inflates into blocking findings on well-tested code. On any `"exceeded":"crap"` finding, check
  `coverage_source` *before* touching the code: `"estimated"` means the score is an artifact, not
  a verdict. Note the gate blocks the whole shell command, so generate coverage in a separate
  invocation from the commit.
- `npm test && npm run typecheck` must pass before any commit. Report the exact failing
  command and root cause if not — never claim a pass from historical output or source test counts.
  **State the timezone with any result** — see non-negotiable 7.

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
| Ops, PM2, crash-loops, logs, deploy   | `docs/OPERATIONS.md` (deploy runbook + rollback)          |
| Writing or fixing any test            | `src/bot/tests/test-clock.ts` (why fixtures must pin time)|
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
   See `docs/OPERATIONS.md`; prefer `pm2 delete tastytrade-silver-lynx` + start for this app alone.
5. Config resolves via `readEnvPct` / `readEnvInt` / `readEnvBool` / `toBooleanFlag`; a
   present-but-blank env var means "use the in-code default." Never `parseInt(x ?? "d")` — it
   NaNs on blank. For a **default-true** flag never write `toBooleanFlag(process.env.X ?? true)`:
   `??` only fires on null/undefined, so a blank `X=` reaches `toBooleanFlag("")` and reads as
   **false**, silently shipping the feature off while the code says it's on. Use
   `readEnvBool(key, fallback)`.
6. Update the docs in the same commit as the code they describe. **The docs are load-bearing:**
   `STRATEGY.v2 §6d` once specified the stop-persistence gate in *evaluations* rather than
   *cycles*, the code implemented that faithfully, and the feature was a no-op that passed 605
   tests. When something measures as doing nothing, read its spec before its implementation.
7. **Tests must pin the clock.** The engine reads time-of-day off the **local** clock
   (`getTimeInMinutes`, `getMorningSpreadThresholdPct`, `isRegularSessionByLocalClock`), so a
   fixture built from a `...Z` literal or a bare `new Date()` makes the suite's verdict a function
   of where and when it runs. Use `src/bot/tests/test-clock.ts`; one time base per fixture. Verify
   at more than one `TZ`, and judge a change by **diffing failing sets at the same TZ** — never by
   an absolute pass count.

When sources conflict on a safety question, stop the live-mutating work, report it, and use
the stricter interpretation until the owner reconciles it.
