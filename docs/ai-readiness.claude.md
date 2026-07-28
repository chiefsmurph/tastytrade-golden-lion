# The Golden Lion Blueprint
### A three-repo teardown, and a canonical operating system for `tastytrade-silver-lynx`

> **What this is.** Five AI auditors (Opus 4.8) spent ~470k tokens reading three repos end-to-end: your `tastytrade-silver-lynx`, Stephen's `LawEngine` (a heavily agent-instrumented monorepo), and `halsted_devices` (a fleet-documentation repo). This document is the synthesis: an honest audit of where Golden Lion stands today, what the other two repos got right and wrong, what the industry converged on in 2025–2026, and a concrete, phased build plan — with ready-to-paste file drafts — to turn this repo into a canonical source of truth that any AI coding agent (Claude Code, Codex, Cursor) can work in *safely*.
>
> **Why it matters here more than most repos:** this bot trades real money. For most codebases, stale docs cost time. Here, a stale doc already describes a **$200-per-seed safety cap that no longer exists**. That's the difference between "documentation debt" and "an agent confidently reasoning from a phantom safety net."

---

## Table of contents

1. [What your repo looks like to an AI agent today](#1-what-your-repo-looks-like-to-an-ai-agent-today)
2. [The three-repo comparison](#2-the-three-repo-comparison)
3. [Ten laws of a canonical repo](#3-ten-laws-of-a-canonical-repo)
4. [The build plan](#4-the-build-plan)
   - [Phase 0 — the 90-minute fix (do today)](#phase-0--the-90-minute-fix-do-today)
   - [Phase 1 — the safety layer (one evening)](#phase-1--the-safety-layer-one-evening)
   - [Phase 2 — the reference layer (a weekend)](#phase-2--the-reference-layer-a-weekend)
   - [Phase 3 — enforcement & automation (ongoing)](#phase-3--enforcement--automation-ongoing)
5. [Anti-patterns: what NOT to build](#5-anti-patterns-what-not-to-build)
6. [Sources](#6-sources)

---

## 1. What your repo looks like to an AI agent today

### 1.1 The system, in one paragraph

`tastytrade-silver-lynx` is a single-process TypeScript/ESM options-trading bot (~28.2k LOC, 141 source files of which 51 are tests) run under PM2 in fork mode, controlled through a Unix-socket IPC server (`node run <namespace:fn>`), talking to Tastytrade over OAuth2 REST plus dxLink quote streaming, with an optional Socket.IO "secret" signal feed. It runs a ~4-minute cycle per account: cancel live orders → advance sprays → build a full context snapshot → evaluate every `UNDERLYING::side` group → close first, then allocate → overnight reductions → cross-account seeds → append everything to NDJSON audit stores (`data/runs/`, `data/ledger/`, `data/day-reports/`). Strategy circuit breakers: EOD margin liquidation arms at 12:50 PM PT, dynamic take-profit blends 0.40→0.07 across the day, stops are bid-based (−30% intraday / −10% EOD). No database; all state is local files. Code health is gated by `fallow` (static analysis) at commit time — both via `.githooks/pre-commit` and Claude Code `PreToolUse` hooks.

### 1.2 What's already excellent (seriously)

Credit where due — this repo is *above average* for agent-readiness, and several things here are better than what most professional teams ship:

| Strength | Evidence |
|---|---|
| **A real strategy spec** | `docs/STRATEGY.v2.md` (20.6 KB) is the crown jewel: the full trading logic top-to-bottom with `file:line` anchors, time-of-day schedule tables, circuit-breaker ordering, config tables. Most trading repos have nothing like it. |
| **Comment culture that captures *why*** | `position-gate.ts` is ~25% comments, and they carry rationale with dates and incident references ("15-lot WEN on 2026-07-06"). This is exactly what agents need. |
| **Mechanical code-health gates** | `fallow` audit blocks commits that *introduce* new findings (inherited debt doesn't block — smart), wired for both human commits (`.githooks/`) and Claude Code sessions (`.claude/hooks/`). |
| **Testability by design** | Heavy dependency injection (`SprayDeps`, `ClosePositionDependencies`, quote-streamer seams); 51 test files covering seed sizing, chase logic, cooldowns, the registry, the ledger. |
| **A decision-history trail** | `docs/improvements/IMPROVEMENTS.v1–v10` is a de-facto ADR log — a rich "why we changed it" record. |
| **Zero TODO/FIXME/HACK in source** | Concerns are routed into docs and tracked suppressions instead of rotting inline. |
| **Operational wisdom written down** | `docs/OPERATIONS.md` pm2 gotchas (shared daemon, never `pm2 kill`, node-v24 requirement, `dump.pm2.bak` recovery) is hard-won knowledge, captured. |

**Agent-readiness rating: 6/10.** The gap to 9 is not more writing — it's *consolidation, correction, and enforcement* of what already exists.

### 1.3 The three safety traps (fix these first)

These are the audit's most important findings. All three are verified against code at HEAD `fafdc51`:

1. **README documents a retired dollar cap as a live protection.** README (line 112) says `BOT_MAX_SEED_ORDER_COST` caps any single seed order, "defaults to `200`." **That variable was retired 2026-07-21** (`.env.example:41-42` says so; `risk-limits.ts`, `run-cycle-seed.ts`, `seed-symbol.ts` confirm, and `startup-config.ts` warns "OBSOLETE env var … is set and IGNORED" at boot). Seed sizing is now 100% percent-of-NLV. An agent — or a human — trusting the README believes a $200 hard cap exists. It does not.
2. **Same trap, second variable.** `STRATEGY_MAX_UNDERLYING_NOTIONAL` is documented as an active dollar ceiling; `getMaxUnderlyingNotional()` in `risk-limits.ts` now hard-returns `Infinity` and the var is flagged obsolete at boot.
3. **The *real* leverage rail is undocumented.** `STRATEGY_MARGIN_MAX_TOTAL_UTILIZATION` — a **1.5× cap on total margin option exposure vs. margin NLV, enforced by default** (`seed-sizing-live.ts:51-59`) — appears nowhere in README or CLAUDE.md. The single most important risk limit in the system is invisible to anyone who doesn't read `.env.example` comments.

Plus two broken pointers that erode trust in everything else:

4. **`AGENTS.md` is 0 bytes** — while `CLAUDE.md` line 3 commands *"First look at any AGENTS.md always!"* Every agent session opens by following a pointer to nothing.
5. **Dead file paths in the primary docs:** `CLAUDE.md:67` references `cash-position-gate.ts` (renamed to `position-gate.ts`) and `CLAUDE.md:55` references `src/bot/secret/` (it lives at `src/strategy/secret/` — also wrong at `STRATEGY.v2.md:185`). CLAUDE.md is actually *self-contradictory*: line 51 uses the correct `src/strategy/position-gate.ts` while line 67 uses the dead name. Your own `IMPROVEMENTS.v4.md:53` flagged this and the fix never landed.

### 1.4 What's missing entirely

- **A safety-invariants doc.** Nothing states what must never break: margin flat by 1:00 PM PT, the 1.5× leverage rail, bid-based stops, concentration caps, the kill switches (`node run core:cancelAllLiveOrders`, `BOT_READ_ONLY_ACCOUNTS`, `BOT_DO_NOT_TOUCH_GROUPS`), cancel-confirm-before-replace in the chase loops.
- **A standalone runbook.** `docs/OPERATIONS.md` is a *review-cadence* doc; the start/stop/recover content is a buried "gotchas" appendix.
- **A domain glossary.** *spray, seed, chase, WAF, candidate, cooldown, per-leg cost basis, holdScore, crashRegime, held-contract fallback, do-not-touch group…* — an agent currently reverse-engineers each term from code.
- **A current env reference.** Code defines ~112 env vars across `CORE_`/`BOT_`/`STRATEGY_`/`SECRET_`; README documents a stale subset. The entire spray-buy subsystem (7 vars) is documented only in `.env.example` comments.
- **Data contracts** for the four NDJSON/JSON stores — including the *known* ledger gap (closes that fill after the chase's final re-fetch are missing from realized P&L; documented in code comments only).
- **`.claude/skills/` and `.claude/rules/`** — no packaged workflows for the things you do every day (check status, read logs, triage a crash loop, cancel all orders).

Two code-level observations worth your attention while we're here (from the architecture audit, not doc issues): the **account streamer** URL is hardcoded to `wss://streamer.cert.tastyworks.com/streamer` (`tastytrade-client.ts:19`) — a **`.cert.` (certification) host in an otherwise production-pointed client** — worth verifying that's intentional (the dxLink *quote* streamer is fine; it fetches its URL dynamically from the quote-token endpoint); and the IPC socket's only access control is `chmod 600`, meaning any process running as your user can place real orders.

---

## 2. The three-repo comparison

Three repos, three documentation cultures, three very different failure modes.

### 2.1 Scorecard

| Dimension | `tastytrade-silver-lynx` | `LawEngine` | `halsted_devices` |
|---|---|---|---|
| Scale | ~28k LOC, 141 files | Very large monorepo, live DB, multi-repo ecosystem | ~9-machine fleet docs |
| Entry point for agents | `CLAUDE.md` (good map, 2 dead refs) + **empty AGENTS.md** | 1,076-line / 64 KB `AGENTS.md` + thin `CLAUDE.md` stub | `README.md` + `AGENTS.md` with explicit read-order |
| Source-of-truth model | `STRATEGY.v2.md` authoritative for strategy; README for ops; drift between them | One canonical brain (`AGENTS.md`) + `docs/canonical/`; vendor stubs redirect to it | 7-level precedence ladder for conflicting sources |
| Deep reference | `docs/` (strategy, ops, improvements, plans) | 40-subdir `docs/` taxonomy, doc registry, routing index | Per-device folders + dated contract docs |
| Skills / rules | None | 10 Codex skills + 6 condensed `.claude/rules/` (253 lines) | None |
| Mechanical enforcement | **fallow gate** (commit + Claude hooks) — best of the three | Size guard (LFS >50 MiB), naming-discipline linter | None |
| Drift management | None (file:line anchors silently rot) | `doc-drift.toml` read-only LLM subagent + doc-placement rules | "Trust the internal date, not the filename" meta-rule |
| Freshness of top docs | README carries retired safety vars | Front door mixes April/June/July facts under an April heading | Index 3 weeks behind the operationally-binding contract |
| Signature failure mode | **Stale safety claims** | **Context obesity + duplication** | **Stale index + triplicated facts** |

### 2.2 What each repo teaches

**Golden Lion teaches: enforce mechanically, write down *why*.** The fallow gate is the only *deterministic* code-quality guardrail among all three repos — it fires whether the committer is you or Claude, and it can't be talked out of it. And the comment-with-rationale culture (dates, incidents) is the cheapest form of ADR there is. Its failure mode is that the *prose* layer (README/CLAUDE.md) has no equivalent enforcement, so it silently rotted while the code sprinted ahead — and in a money system, rotted prose is a loaded gun.

**LawEngine teaches: route, don't dump — and it teaches it both by example and by counter-example.** The *patterns* are world-class:

- **One canonical brain, thin vendor stubs.** `CLAUDE.md` is 39 lines: "Use `AGENTS.md` as canonical," then re-states only the 3 rules Claude most often violates. `GEMINI.md` does it in 5 lines. One source of truth, per-vendor emphasis.
- **Breadcrumbs with "most specific wins."** 188 nested `AGENTS.md` files — an agent working in a subtree gets local law without loading the whole world.
- **The change-governor discipline:** *search before you create; name the canonical owning file; no new tunable as a bare constant — route it through the owning config + typed loader; post-change, ask five alignment questions* (did this change a contract? invalidate a TODO? make a doc historical? change commands? advance a milestone?).
- **Read-only LLM subagents as explicit tools** — `doc-drift.toml` defines a sandboxed reviewer that *recommends* moves/renames/archivals but "DO NOT make edits." A linter-as-LLM.
- **Dated files are evidence, canonical files are truth.** Snapshots get dates; living docs get roles; superseded docs get a historical banner.

But the front door itself broke its own rules: a "short root front door" that grew to 64 KB / 1,076 lines with a ~240-line "Current Truth Snapshot (2026-04-06)" containing July facts under an April heading, the same rules duplicated verbatim in 3–4 places, typo'd directory names frozen into the taxonomy (`opinoins_chunk-embed-stratetgy/`), and ~37 MB of loose parquet/zip/tarball committed at root. **At LawEngine's scale that overhead is survivable. At Golden Lion's scale it would be pure poison.** The audit's verdict: for a ~150-file repo, six mechanisms give you 80% of the value (they're all in the build plan below).

**halsted_devices teaches: precedence ladders and point-in-time contracts.** Two patterns worth stealing outright: (1) an explicit **source-of-truth precedence order** — "when live session facts, the current-state file, the audit, and the README disagree, trust them in this order" — which gives a cold-landing agent a deterministic algorithm instead of a pile of equal files; and (2) **dated contract docs that pair the decision with its rationale and a fail-closed rule** (the OCR call-contract set explains *why* — the runaway-OCR incident — then gives each machine a plain-language playbook with "grep if the line numbers drift"). Its failure mode is the cautionary tale for any index: the three top routing docs froze on 2026-06-29 while the operationally-binding contract (the `/v1/capabilities` preflight gate) was born three weeks later in a side folder the read-order never points to. **An index that lags the working edge doesn't just fail to help — it actively misleads.** Also: the same UFW firewall fix hand-maintained across many machine docs (verbatim in at least three), a zip blob in git, and an underscore prefix meaning both "dead" (`_archive/`) and "very live" (`_OCR-lincoln-help/`).

### 2.3 The synthesis in one sentence

**Golden Lion has the best enforcement and the worst front door; LawEngine has the best routing architecture and the worst context discipline; halsted_devices has the best conflict-resolution model and the worst freshness** — the canonical repo takes Golden Lion's hooks, LawEngine's routing patterns at 1/10th the size, and halsted_devices' precedence ladder, and adds the one thing none of the three have: **drift prevention wired into CI.**

---

## 3. Ten laws of a canonical repo

Distilled from all three repos plus the 2025–2026 industry standards (AGENTS.md spec — now a Linux Foundation project used by 60k+ repos and read natively by Claude Code, Codex, Cursor, Copilot, et al.; Anthropic's memory/hooks/skills guidance; docs-as-code drift research).

1. **One brain, thin stubs.** `AGENTS.md` is the single canonical agent context. `CLAUDE.md` becomes one line — `@AGENTS.md` — plus at most a few Claude-specific notes. Never maintain the same fact in two files.
2. **The front door is a router, not a knowledge base.** Keep root `AGENTS.md` ≤ 150 lines: what this is, how to build/test/run, the non-negotiables, and *pointers with trigger conditions* ("touching strategy? read SAFETY.md + STRATEGY.v2.md first"). Deep content lives in `docs/` and loads only when needed.
3. **Prose is probabilistic; hooks are deterministic.** An instruction in AGENTS.md is a request; a `PreToolUse` hook or git hook is a law. Anything that must *never* happen (edits to `.env`, touching live `data/` stores, weakening a safety invariant) gets a hook, not a sentence. You already live this law with fallow — extend it to safety.
4. **Safety invariants are a named document, and each invariant names its enforcement.** For a real-money system: one `SAFETY.md` listing what must never break, each line paired with *where it's enforced* (code path, test, hook) — so a change that touches an invariant is visibly a safety change.
5. **Name living documents for their role, snapshots for their date.** `RUNBOOK.md`, not `runbook_2026_07_23.md`. Dated files are immutable evidence (audits, plans, incident writeups); role-named files are current truth. Never require a "trust the inside, not the filename" meta-rule.
6. **State the precedence ladder.** One line in AGENTS.md: *"When docs disagree: code > .env.example > SAFETY.md > STRATEGY.v2.md > README > everything else — and file the discrepancy."* Cold-landing agents get an algorithm, not a guess.
7. **Every fact lives in exactly one place; everything else links.** The moment the same env-var table exists in README *and* .env.example *and* AGENTS.md, divergence is scheduled. Generate references from code where possible — generated docs can't drift.
8. **Procedures are skills, not paragraphs.** Repeatable workflows (deploy, crash-loop triage, EOD review) become `.claude/skills/<name>/SKILL.md` — loaded only when used, so they cost zero context until needed. Side-effecting skills get `disable-model-invocation: true` (an agent should never *decide on its own* to restart the bot).
9. **Docs change in the same commit as the code they describe** — and CI (or a hook) checks it. A doc-drift gate that fails when `.env.example` and the env reference diverge, or when a documented file path no longer exists, is worth ten reminders. Stale agent docs are worse than missing ones: an agent will confidently follow an outdated command.
10. **Write the *why* next to the *what*.** Your comment culture already does this. Promote the load-bearing whys (why bid-based stops, why dollar caps became percent caps, why margin must be flat by 1 PM) into an indexed `DECISIONS.md` so agents stop re-deriving — or worse, re-litigating — settled decisions.

---

## 4. The build plan

Everything below is scoped to *this* repo's size. Total new always-loaded context after the whole plan: **under 150 lines.** Everything else loads on demand.

### Phase 0 — the 90-minute fix (do today)

**0.1 — Fix the README safety traps (~30 min).**
- Delete or clearly mark retired: `BOT_MAX_SEED_ORDER_COST`, `STRATEGY_MAX_UNDERLYING_NOTIONAL`. Add a "Retired variables" subsection so nobody re-adds a phantom cap.
- Document `STRATEGY_MARGIN_MAX_TOTAL_UTILIZATION` (the 1.5× leverage rail) prominently.
- Fix the dead paths: `cash-position-gate.ts` → `position-gate.ts` (`CLAUDE.md:67`), `src/bot/secret/` → `src/strategy/secret/` (`CLAUDE.md:55` and `STRATEGY.v2.md:185`).

**0.2 — Populate `AGENTS.md` (~45 min).** Here is a complete draft, grounded in the audit — paste, adjust, commit:

```markdown
# tastytrade-silver-lynx — Agent Guide

Automated options-trading bot for Tastytrade. **This system places real-money
orders.** Read SAFETY.md before changing anything in src/strategy/ or
src/bot/actions/.

## What this is
Single-process TypeScript/ESM app under PM2 (`ecosystem.config.cjs`), driven by
a ~4-min market-hours cycle per account, controlled via Unix-socket IPC
(`node run <namespace:fn>`). Layers (one-way deps: bot → strategy → core):
- `src/core/`    — Tastytrade API, quotes (dxLink), sessions, balances. Env: CORE_
- `src/strategy/`— decisions: targets, gates, sizing, risk. Env: STRATEGY_ / SECRET_
- `src/bot/`     — orchestration, execution, persistence. Env: BOT_
- `src/tools/`   — read-only diagnostics.

## Commands
- Build: `npm run build`   Typecheck: `npm run typecheck`
- Test:  `npm test` (Node test runner via tsx; 51 test files)
- Code-health gate: `fallow` runs on commit (.githooks/pre-commit + .claude/hooks).
  New findings block; inherited ones don't. Don't add `fallow-ignore` without a comment.
- Never start/stop/restart PM2 without following RUNBOOK.md (shared daemon;
  `pm2 kill` is FORBIDDEN — it takes down every app on this machine).

## Read-order by task
| Task touches…                  | Read first                                  |
|--------------------------------|---------------------------------------------|
| Anything in strategy/ actions/ | SAFETY.md, then docs/STRATEGY.v2.md          |
| Ops, PM2, crashes, logs        | RUNBOOK.md, then docs/OPERATIONS.md          |
| Env vars / tuning              | docs/ENV.md (.env.example is closest to code)|
| Persisted data files           | docs/DATA-CONTRACTS.md                       |
| Unfamiliar term (spray, seed…) | docs/GLOSSARY.md                             |

## Precedence when sources disagree
code > .env.example > SAFETY.md > docs/STRATEGY.v2.md > README.md > older docs.
If two disagree, say so in your reply and fix the stale one in the same change.

## Non-negotiables
1. Never weaken a SAFETY.md invariant without the human explicitly asking.
2. Never edit `.env` or files under `data/` (live ledgers/registries).
3. Close/chase loops: a cancel must be CONFIRMED before re-placing (double-order guard).
4. Skip-reason strings are load-bearing (parsed downstream) — don't rewrite them.
5. Retired vars stay retired: BOT_MAX_SEED_ORDER_COST, STRATEGY_MAX_UNDERLYING_NOTIONAL.
6. Update docs in the same commit as the code they describe.
7. Tests + typecheck must pass before any commit (`npm test && npm run typecheck`).
```

**0.3 — Make `CLAUDE.md` a thin stub.** First line `@AGENTS.md`, then keep only Claude-specific notes (the fallow hooks explanation, anything about how you personally drive Claude here). LawEngine's 39-line CLAUDE.md is the template; yours can be shorter.

### Phase 1 — the safety layer (one evening)

**1.1 — `SAFETY.md`.** The single highest-value document a money-trading repo can have, and it's mostly assembly — every fact below was verified in code by the audit:

```markdown
# SAFETY.md — Invariants that must never break

Each invariant lists WHERE it is enforced. If your change touches an
enforcement point, it is a safety change: say so explicitly and get sign-off.

## Hard invariants
1. MARGIN FLAT BY 1:00 PM PT. EOD liquidation arms at 12:50 PM
   (EOD_ARMED_MINUTE, defined in spread-thresholds.ts, gating margin in
   evaluate-trading-strategy.ts). A margin position after 1 PM is a sev-1
   (docs/OPERATIONS.md §2).
2. LEVERAGE RAIL: total margin option exposure ≤ 1.5× margin NLV.
   Enforced by default in seed-sizing-live.ts (STRATEGY_MARGIN_MAX_TOTAL_UTILIZATION).
3. ACCUMULATION & CONCENTRATION CAPS are stateless — recomputed every cycle
   from broker truth so restarts can't reset them. Refactors must preserve this.
   (STRATEGY_MAX_ALLOCATION_BUY_POSITION_MULTIPLE, _MAX_UNDERLYING_CONTRACTS,
   _MAX_UNDERLYING_ACCOUNT_PCT=60, _COMBINED_UNDERLYING_CAP_PCT=70.)
   WARNING: the 60/70 caps come from .env.example — the in-code fallback when
   unset is 0 (cap DISABLED). The .env values are part of the safety config;
   removing them silently turns the caps off.
4. STOPS ARE BID-BASED: −30% intraday / −10% EOD — a position must be exitable
   at the price the stop fires on. Never switch stops to mid/ask.
5. ONE WORKING ORDER PER CHASE. Cancel must be confirmed before re-placing
   (close-position.ts, spray-buy.ts single-order invariant). Breaking this
   double-buys or double-sells.
6. READ-ONLY ACCOUNTS AND DO-NOT-TOUCH GROUPS ARE ABSOLUTE
   (BOT_READ_ONLY_ACCOUNTS, BOT_DO_NOT_TOUCH_GROUPS).
7. NO MARKET ORDERS. Every order is a limit order inside the spread gates.

## Kill switches (operator)
- Emergency cancel: `node run core:cancelAllLiveOrders [account]`
- Graceful stop: SIGTERM → cancels all live orders, 30s for in-flight cycle.
- Freeze an account: add to BOT_READ_ONLY_ACCOUNTS and restart per RUNBOOK.md.

## Known traps
- RETIRED (do not re-document, do not re-add): BOT_MAX_SEED_ORDER_COST,
  STRATEGY_MAX_UNDERLYING_NOTIONAL (both retired 2026-07-21 — sizing is
  %-of-NLV now; the only dollar bound is broker buying power).
- The realized-P&L ledger UNDERCOUNTS: closes that fill after the chase's
  final re-fetch are missing (pnl-ledger.ts). Don't treat ledger totals as
  complete when reasoning about P&L.
- pm2 log-line timestamps are PT; embedded JSON timestamps are UTC.
```

**1.2 — `RUNBOOK.md`.** Promote the `docs/OPERATIONS.md` "gotchas" into a real runbook: start (`npm run build` → `pm2 start ecosystem.config.cjs` → `pm2 save`, from a shell where `node -v` is v24 — v20 lacks global `WebSocket` and the streamer throws), stop/restart (never `pm2 kill` on the shared daemon), roster recovery (`pm2 resurrect`, `dump.pm2.bak` fallback, "never `pm2 save` while apps are missing"), crash-loop triage (`grep -c 'Exiting for PM2 restart'` in the PM2 error log — 0–3 is normal; the 07-06 dxLink session-limit incident produced 23), and boot verification (confirm `[secret] attemptAuth sent` in the boot log — its absence was the root cause of the July silent-notification outage). Keep `docs/OPERATIONS.md` as the *review-cadence* doc it actually is.

**1.3 — `docs/GLOSSARY.md`.** Seed it from the audit (each term with a `file` origin): **spray** (cash-only execution primitive: one working chasing order driven against a front-loaded cumulative fill target, `src/bot/actions/spray-*.ts`), **seed** (opening a position in one account driven by conditions in the other; also feed-driven auto-seed), **chase / tick-chase** (walking a limit order across bid/mid/ask; urgent = 10s ticks, normal = 30s), **candidate** (the contract picked by the `option-candidate/` pipeline after IV/spread/liquidity gates), **WAF** (weighted-average fill), **per-leg cost basis**, **cooldowns** (the four outcome-keyed timers: placed 10m / no-chain 6h / no-candidate 2h / retry 3m, plus the 15-min early-session window), **holdScore / willBuy / crashRegime / plateauScore** (secret-feed fields, `src/strategy/secret/types.ts`), **do-not-touch group / read-only account / closing-only**, **held-contract fallback**, **ITM fallback**, **overnight reduction**, **GL** (this bot).

### Phase 2 — the reference layer (a weekend)

**2.1 — `docs/ENV.md`, generated from code.** ~112 vars exist; README documents a stale subset. Write (or have an agent write) a small script that greps `readEnvPct/readEnvInt/toBooleanFlag` call sites and emits a table: name, default, safety-critical vs. tuning, and the fraction-or-integer-percent parsing rule (`12` == `0.12`). Generated reference can't drift. Include the retired list and the ~30 obsolete names `startup-config.ts` already warns about — that warning list is your machine-readable retirement registry, lean on it.

**2.2 — `docs/ARCHITECTURE.md` — the module map.** The README's 3-layer table is right but stops at directories. Add file-level ownership for the confusing clusters: the `run-cycle*` quartet (cycle vs. context vs. seed vs. logging), the `actions/` executors, the `option-candidate/` pipeline, the `secret/` feed modules — plus honest notes on the two things an agent *will* trip over: the 17 circular deps (two roots: `tastytrade-client ↔ execute-position-evaluations`, worked around via lazy import; and `manage-allocation → option-candidate → effective-buying-power`) and the `manage-allocation.ts` complexity monster (1,353 lines; `manageAllocationForGroup` cyclomatic 98 — the fallow audit already prescribes the split).

**2.3 — `docs/DATA-CONTRACTS.md`.** Field schemas for the four stores (`data/runs/*.ndjson`, `data/runs/position-registry.json`, `data/day-reports/`, `data/ledger/`), what writes them, what reads them, pruning rules (registry keeps 2 days), and the ledger-completeness gap stated as a contract term.

**2.4 — `docs/DECISIONS.md`.** A dated, one-line-per-decision index distilled from `IMPROVEMENTS.v1–v10` + STRATEGY.v2 §14: *2026-07-21: dollar caps retired for %-of-NLV band + 1.5× rail, because…; 2026-07-19: daytradeScore became telemetry-only, because…; why bid-based stops; why average-down-only; why margin force-closes overnight positions at open.* Each line links to the full writeup. This is halsted_devices' contract-doc pattern applied to strategy history — and it's what stops a future agent from "simplifying away" a rule that a July incident put there.

### Phase 3 — enforcement & automation (ongoing)

**3.1 — Skills for the workflows you repeat.** `.claude/skills/<name>/SKILL.md`, committed:
- `status-check` — the IPC one-liners (`bot:getMarketOpenSchedulerStatus`, positions, balances) and what healthy looks like.
- `crash-triage` — the RUNBOOK crash-loop procedure as an executable checklist.
- `eod-review` — the OPERATIONS.md §daily routine (greps, ledger reconciliation, day report).
- `deploy` — build → typecheck → test → restart → verify boot log, with **`disable-model-invocation: true`** so no agent ever *decides on its own* to restart the bot mid-session.

**3.2 — Extend the hook layer from code-health to safety.** You already run fallow via `PreToolUse`. Add:
- A `PreToolUse` hook denying edits to `.env` and `data/**` (exit 2 with a reason — the model doesn't get a vote).
- A guard on `SAFETY.md`-enforcement files: editing `evaluate-trading-strategy.ts`, `risk-limits.ts`, `seed-sizing-live.ts`, `close-position.ts` injects a reminder that a safety invariant may be in play (a `PostToolUse` or `UserPromptSubmit` notice is enough — the point is the agent can't *not know*).

**3.3 — A doc-drift gate.** The one mechanism none of the three repos has, and the industry's clearest lesson (*"stale agent docs are worse than missing ones"*). Start tiny — a script in the pre-commit hook (or CI) that fails when:
- a file path mentioned in AGENTS.md / CLAUDE.md / SAFETY.md / STRATEGY.v2.md doesn't exist;
- an env var documented in `docs/ENV.md` isn't in `.env.example` (or vice versa);
- a var on the retired list reappears anywhere in docs as live.

That's ~50 lines of script, and it would have caught every stale-doc finding in this audit — including both safety traps — automatically.

**3.4 — Freshness policy.** Steal halsted_devices' rule but invert the burden: living docs carry an `Updated:` line *and* the drift gate checks that any commit touching `src/strategy/` or `src/bot/actions/` also touches at least one of SAFETY.md / STRATEGY.v2.md / docs/DECISIONS.md *or* includes a `docs-reviewed` trailer. Soft-warn first; tighten if drift recurs. And replace STRATEGY.v2.md's decaying `file:line` anchors with stable anchors: function names + a grep hint ("`manageAllocationForGroup` in manage-allocation.ts — grep it, line numbers drift"), which is exactly how the halsted_devices contract docs stay usable.

### The target tree

```text
tastytrade-silver-lynx/
├── AGENTS.md            ← ~60-line router (Phase 0) — the canonical brain
├── CLAUDE.md            ← @AGENTS.md + Claude-specific notes only
├── SAFETY.md            ← invariants + enforcement points + kill switches
├── RUNBOOK.md           ← start/stop/recover/triage under PM2
├── README.md            ← for humans; env section corrected, links to docs/ENV.md
├── docs/
│   ├── STRATEGY.v2.md   ← unchanged crown jewel (anchors → function names)
│   ├── OPERATIONS.md    ← review cadence (gotchas promoted to RUNBOOK.md)
│   ├── ENV.md           ← generated env reference
│   ├── ARCHITECTURE.md  ← file-level module map + known hazards
│   ├── DATA-CONTRACTS.md├── GLOSSARY.md  ├── DECISIONS.md
│   ├── improvements/    ← unchanged history (indexed by DECISIONS.md)
│   └── plans/           ← dated snapshots, immutable
├── .claude/
│   ├── settings.json    ← existing fallow hooks + new .env/data-dir denies
│   ├── hooks/           ← fallow-gate, fallow-coverage, + doc-drift check
│   └── skills/          ← status-check, crash-triage, eod-review, deploy
└── .githooks/pre-commit ← fallow gate + doc-drift gate
```

Total always-loaded context: AGENTS.md (~60 lines) + CLAUDE.md stub (~10). Everything else loads when the task needs it. That's the LawEngine architecture at 1/10th the weight — with enforcement LawEngine doesn't have.

---

## 5. Anti-patterns: what NOT to build

Learned the hard way by the other two repos — and by the industry:

1. **Don't grow a 64 KB front door.** LawEngine's AGENTS.md self-describes as "short" at 1,076 lines. Long always-loaded files don't just cost tokens — they *reduce adherence* (Anthropic's own guidance: keep each memory file lean; under ~200 lines). If AGENTS.md wants to grow, that's a doc trying to be born in `docs/` — link it.
2. **Don't put dated facts in the router.** "Current Truth Snapshot (2026-04-06)" containing July facts is how a front door becomes a liability. Volatile state belongs in generated or dated files.
3. **Don't maintain the same fact twice.** The triplicated UFW block in halsted_devices and the README-vs-.env.example split in *this* repo are the same bug at different ages. One owner per fact; links elsewhere.
4. **Don't date the filenames of living documents.** `master_fleet_reference_2026_04_08.md` needed a written rule saying "ignore the filename." Role-name the living, date the dead.
5. **Don't commit blobs and scratch to the repo root.** LawEngine's ~37 MB of loose parquet/zip at root and halsted_devices' `to_send_devices.zip`/`tes.md` are attention competitors for every agent that lands. Golden Lion's root is currently clean — keep it that way (gitignore `data/`, archive dead docs, no zip "backups" in git).
6. **Don't let the permission allowlist become a junk drawer.** LawEngine's `.claude/settings.json` holds ~190 hyper-specific pre-approved commands. Prefer a few well-chosen patterns.
7. **Don't rely on prose for anything that must be true.** If it matters, it's a hook, a test, a generated file, or a CI gate. If it's only a sentence, it's a suggestion.
8. **Skip `llms.txt`.** For an in-repo codebase it's noise — no major lab reads it in production; AGENTS.md/CLAUDE.md are the load-bearing files. (Only relevant if you ever publish a docs website.)

---

## 6. Sources

- **AGENTS.md open standard** — https://agents.md (Linux Foundation / Agentic AI Foundation; 60k+ repos; read by Claude Code, Codex, Cursor, Copilot, Gemini CLI, et al.)
- **Anthropic — Claude Code memory (CLAUDE.md, imports, hierarchy)** — https://code.claude.com/docs/en/memory
- **Anthropic — Skills** — https://code.claude.com/docs/en/skills · Agent Skills standard: https://agentskills.io
- **Anthropic — Hooks (deterministic guardrails)** — https://code.claude.com/docs/en/hooks-guide
- **Doc-drift prevention / docs-as-code** — https://github.com/fiberplane/drift · https://document360.com/blog/documentation-drift/
- **ADRs** — https://adr.github.io/
- **AI-agent guardrails & kill switches in production** — https://www.codebridge.tech/articles/ai-agent-guardrails-for-production-kill-switches-escalation-paths-and-safe-recovery
- Full audit reports (architecture inventory, docs audit, LawEngine teardown, halsted_devices review, standards research) available on request — this document is their synthesis.

---

*Prepared 2026-07-23 by Claude (Fable 5) with five Opus 4.8 sub-auditors, at Stephen's request, for the Chief Smurf himself. Audit basis: `tastytrade-silver-lynx` @ `fafdc51`.*
