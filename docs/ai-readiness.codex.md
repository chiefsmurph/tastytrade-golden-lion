# Chief Smurf: Canonical AI-Ready Repository Blueprint

## A three-repository audit of Golden Lion, LawEngine, and Halsted Devices

> **Audit snapshot:** 2026-07-23 CDT  
> **Primary codebase:** `tastytrade-silver-lynx` at commit `fafdc51`  
> **Reference repositories:** `LawEngine` and `halsted_devices`  
> **Requested report location:** `/home/halsted/projects/chiefsmurph`  
> **Important boundary:** the actual Golden Lion Git root is the nested
> `tastytrade-silver-lynx/` directory. This report is therefore outside the Git
> repository, exactly as requested.

This report answers two related questions:

1. How do the three repositories differ, and what should Golden Lion borrow or
   avoid from each one?
2. What would a world-class repository and safety architecture look like if
   humans and coding agents are expected to work on a real-money trading system?

The short answer is:

> **Borrow LawEngine's ownership, provenance, and machine-readable control-plane
> ideas; borrow Halsted Devices' simple routing and explicit truth precedence;
> preserve Golden Lion's compact codebase, tests, and operational evidence. Do
> not copy LawEngine's documentation volume or Halsted Devices' use of Markdown
> as a duplicated database.**

Golden Lion is not a weak codebase. It is a fast-moving, domain-rich trading
daemon with meaningful tests, structured operational evidence, and several
thoughtful safety mechanisms. Its next problem is that the code has evolved
faster than its repository contract. The result is a system that is increasingly
difficult for either a human or an agent to interpret with confidence.

The world-class destination is not “more documentation.” It is a
**self-describing, self-checking repository**:

```text
short agent router
        +
typed configuration and command registries
        +
generated reference documentation
        +
one mandatory execution/risk boundary
        +
transactional state and replayable evidence
        +
independent CI and release receipts
```

---

## 1. Executive verdict

### What is already impressive

Golden Lion already has the difficult ingredients:

- A real TypeScript implementation of scheduling, account evaluation, option
  selection, order routing, quote streaming, restart recovery, reporting, and
  cross-account strategy.
- Strict TypeScript settings.
- 51 test files containing roughly 472 declared test cases and 8,413 test lines.
- A 42.5% test-to-production-line ratio.
- Structured NDJSON histories, day reports, a P&L ledger, position registry,
  quote-streamer recovery, and API accounting.
- A current static-analysis report showing only 0.6% duplication.
- Useful causal comments and production-informed strategy notes.
- Startup warnings for obsolete settings, a resolved-config snapshot, `.env`
  exclusion, and owner-only IPC socket permissions.
- A clear instinct for risk controls, cancel-before-replace behavior, dry-run
  broker validation, and shutdown handling.

Those are not superficial strengths. They make incremental hardening realistic.

### What must change before this becomes genuinely agent-ready

The main issue is **authority and enforcement**:

- The untracked root `AGENTS.md` is empty, so Codex skips it.
- `CLAUDE.md` now tells agents to read that empty file and contains stale paths.
- Several documents claim to be current or authoritative while contradicting
  current code.
- Configuration facts are duplicated among code, `.env.example`, README prose,
  strategy prose, and startup warnings.
- The README lists 34 IPC routes while source registers 38.
- A link audit found 36 broken local targets among 90 local Markdown links.
- The README promises that configured read-only accounts “should not trade,” but
  direct purchase, seed, close, and secret auto-seed paths do not consistently
  enforce that guard.
- Mutating operations do not all pass through one mandatory policy boundary.
- Multiple execution sources can overlap without a global idempotency and
  serialization contract.
- There is no independent CI workflow.
- The currently installed dependency pair allows typecheck to pass but causes 32
  of 51 test-file processes to fail during module loading.

The most important recommendation is therefore:

> **Do not expose Golden Lion's live-mutating commands to an AI agent until every
> broker mutation passes through one default-off `ExecutionCoordinator` that
> enforces mode, account, authorization, idempotency, concurrency, risk, and
> audit policy.**

An agent can help write, test, analyze, replay, and document the system. It
should not be able to infer that code presence or a local Unix socket grants
permission to trade.

### Recommended sequence

1. **Restore and independently enforce a green baseline.**
2. **Close the universal safety-boundary gaps.**
3. **Create one concise, tracked agent front door and one document registry.**
4. **Create typed config and capability registries; generate their docs.**
5. **Enforce dependency boundaries, contracts, and drift checks in CI.**
6. **Refactor large orchestration modules vertically, not through a big-bang
   folder move.**
7. **Promote changes through replay → shadow → paper → bounded-live → live.**

---

## 2. Audit scope, method, and limitations

### Repositories inspected

- Golden Lion:
  [`tastytrade-silver-lynx/`](tastytrade-silver-lynx/)
- LawEngine:
  [`../LawEngine/`](../LawEngine/)
- Halsted Devices:
  [`../halsted_devices/`](../halsted_devices/)

The audit read repository instructions, root and scoped documentation,
configuration files, source code, tests, operations files, Git history, current
worktree state, and representative generated or historical artifacts.

Three independent read-only audit lanes were used:

- Golden Lion architecture, runtime, safety, persistence, and verification.
- Golden Lion agent instructions, documentation drift, configuration, and IPC.
- LawEngine and Halsted Devices pattern comparison.

The requested Opus 4.8 model was not available in this environment. The audit
used the strongest available subagents and independently rechecked material
claims in the primary session.

### Live verification performed

No broker, secret feed, scheduler, deployment, or production service was called.
No `.env` file was read or modified.

The following local checks were run against Golden Lion:

| Check | Result |
|---|---|
| `npm run typecheck` | **Pass** |
| `npm test` | **Fail**: 19/51 test-file processes pass; 32 fail at module import |
| Import failure | `@tastytrade/api@7.0.2` requests `DXLinkFeed`, which installed/locked `@dxfeed/dxlink-api@0.3.0` does not export |
| Git branch | `main`, aligned with `origin/main` |
| Preserved user state | Modified `CLAUDE.md`; untracked, zero-byte `AGENTS.md` |

The test failure is not evidence that 32 strategy assertions are wrong. Those
files fail before their test bodies run because the broker/streamer dependency
graph is imported. It is still a release-governance failure: a clean baseline
must prove that the supported runtime and locked dependency set work together.

### Important integrity note

During the audit, a separate
`GOLDEN_LION_AI_BLUEPRINT.md` appeared and continued changing in the outer
workspace. None of the delegated audit agents created it, and this audit did not
modify or use it as evidence. It was preserved as concurrent user/external work.
This report uses a distinct filename to avoid overwriting it.

---

## 3. Quantitative comparison

Counts below are current working snapshots, not measures of product quality.
The repositories serve very different purposes, so the important signal is the
shape and maintenance burden, not which raw number is largest.

| Measure | Golden Lion | LawEngine | Halsted Devices |
|---|---:|---:|---:|
| Tracked files | 183 | 11,296 | 131 |
| Markdown files | 27 | 3,592 | 84 |
| Tracked `AGENTS.md` files | 0 | 187 | 9 |
| Tracked `README.md` files | 1 | 527 | 15 |
| JSON/YAML/TOML files | 5 | 1,703 | 9 |
| Broad test-file heuristic | 51 | 744 | 0 |
| HEAD commits | 347 | 1,552 | 172 |
| Tracked CI workflows | 0 | 0 | 0 |
| Root `AGENTS.md` size | 0 bytes, untracked | 64,046 bytes / 1,076 lines | 9,751 bytes / 227 lines |
| Root README size | 27,249 bytes / 437 lines | 81,676 bytes / 1,221 lines | 22,815 bytes / 433 lines |

Golden Lion-specific measures:

| Measure | Current value |
|---|---:|
| TypeScript files | 141 |
| Production TypeScript | 90 files / about 19,799 lines |
| Test TypeScript | 51 files / about 8,413 lines |
| Declared `test(...)` calls | 472 |
| Assertion calls | 1,334 |
| IPC commands in source | 38 |
| IPC commands listed in README | 34 |
| Local Markdown links | 90 |
| Broken local Markdown targets | 36, or 40% |
| Current Fallow complexity findings | 69 |
| Fallow critical/high complexity | 10 critical / 17 high |
| Fallow-reported circular dependencies | 17 |
| Fallow suppressions | 50 |
| Fallow-reported duplication | 0.6% |

Velocity is a major explanatory variable. The 347 commits span 2026-06-19
through 2026-07-22 and use one committer identity. The README was last changed on
July 12, while the current HEAD is July 22. The strategy document was last
changed on July 19; 31 later source commits followed. At this pace,
hand-maintained inventories will drift unless generation and CI replace memory.

---

## 4. What each repository teaches

## 4.1 Golden Lion

### Strengths to preserve

#### Compact, understandable product boundary

Compared with LawEngine, Golden Lion is still small enough that one person or
agent can form a useful system model without an indexing platform. Its root
README provides a good runtime diagram and a helpful `core` / `bot` / `strategy`
vocabulary.

That compactness is an asset. Do not bury it under hundreds of routing files.

#### Strong characterization-test base

The 51 test files cover meaningful behaviors:

- Allocation caps.
- Cancel-before-replace and chase behavior.
- Closing-only handling.
- Position registry behavior.
- Seed sizing and cooldowns.
- Quote-streamer recovery.
- Time/session logic.
- Strategy gates and risk thresholds.

The current dependency import failure limits their value, but the test investment
is real and gives refactoring protection once the runtime boundary is decoupled.

#### Causal domain documentation

The improvement and strategy documents often record *why* a behavior exists,
including production counts, incidents, and hypotheses. That is more valuable
than generic module descriptions.

The right move is to preserve this as ADRs and dated evidence—not leave every
discovery log looking like a live backlog.

#### Operational evidence and structured state

NDJSON history, day reports, P&L attribution, config snapshots, and restart
state are exactly the kinds of artifacts an agent needs for evidence-based work.
The system already thinks in receipts; it needs schema versions, provenance,
retention, and a queryable transactional core.

#### Good local safety instincts

Examples include:

- IPC socket mode `0600`.
- Broker dry-run before seed placement.
- Buy-power and exposure checks.
- Cancel confirmation before replacement.
- Obsolete-setting warnings.
- `.env` exclusion.
- Explicit market-session and shutdown logic.

These should be centralized and made impossible to bypass.

### Weaknesses to fix

#### The agent front door is functionally absent

The actual Git root contains a zero-byte, untracked `AGENTS.md`. Current Codex
guidance says empty instruction files are skipped. `CLAUDE.md:3` now instructs
agents to read that empty file first.

`CLAUDE.md` also points to:

- Nonexistent `src/bot/secret/` instead of `src/strategy/secret/`.
- Nonexistent `cash-position-gate.ts` instead of
  `src/strategy/position-gate.ts`.

This is a classic bootstrap failure: the file intended to prevent agent drift is
itself untracked and empty.

#### Several documents compete for “current truth”

Examples:

- `docs/STRATEGY.v2.md` calls itself authoritative.
- `docs/improvements/STATUS.md` calls itself live, but its body says it was last
  reconciled July 6 and that v9/v10 are not folded.
- The same status file says `config:show` shipped around line 74 and later says
  it does not exist around line 148.
- Historical improvement files still contain open tasks and stale code links.
- `docs/eod-log.md` describes a daily log but contains a bounded historical
  snapshot.

The repository needs document lifecycle classes and one current backlog.

#### Configuration is prose-replicated

The README still documents:

- `BOT_MAX_SEED_ORDER_COST`, retired July 21.
- Two day-trade score thresholds, removed July 19.
- `STRATEGY_MAX_UNDERLYING_NOTIONAL`, retired in favor of percentage-based
  controls.

Meanwhile `.env.example` contains newer spray, seed-sizing, concentration, and
margin-utilization settings not represented consistently in README prose.

The example file also supplies behavior-changing values for settings described
as disabled when unset. It is therefore a profile, not a neutral example.

#### The described layer direction is not the implemented direction

The README says:

```text
strategy → core
bot → core
bot → strategy
```

Current reverse dependencies include:

- `core/get-positions-and-balances.ts` importing strategy and bot modules.
- `core/tastytrade-client.ts` importing bot execution behavior.
- Strategy option-candidate modules importing bot modules.
- Secret strategy modules importing bot seeding, registry, and scoreboards.

The current Fallow audit reports 17 cycles. The folder names communicate a
cleaner architecture than the import graph actually enforces.

#### Complexity is concentrated in orchestration

The largest production files include:

| File | Lines |
|---|---:|
| `src/bot/actions/manage-allocation.ts` | 1,353 |
| `src/bot/seed-symbol.ts` | 995 |
| `src/bot/run-cycle-context.ts` | 884 |
| `src/bot/actions/spray-buy.ts` | 642 |
| `src/core/option-service.ts` | 627 |
| `src/bot/run-history.ts` | 580 |
| `src/strategy/secret/secret-auto-seed.ts` | 572 |
| `src/bot/run-cycle.ts` | 552 |

The Fallow report places `manageAllocationForGroup` at cyclomatic complexity 98
and cognitive complexity 74.

This does not call for arbitrary file splitting. It calls for extracting stable
policy, use-case, port, and adapter boundaries.

### Bottom-line pros and cons

| Pros | Cons |
|---|---|
| Compact enough to understand | Agent instructions are absent/drifted |
| Strong domain logic and comments | Multiple competing “current” docs |
| High test investment | Current dependency pair blocks much of the suite |
| Rich operational evidence | No independent CI |
| Low duplication | High concentrated complexity and 17 cycles |
| Good local safety instincts | Safety checks are path-specific, not universal |
| Typed implementation | Config and commands are manually duplicated |

---

## 4.2 LawEngine

### Patterns worth copying

#### Explicit ownership and truth precedence

LawEngine repeatedly asks:

- Which repository owns this fact?
- Which subsystem owns this value?
- Is this live, loaded, enabled, public, default, or merely present?
- Is this a canonical statement, a proposal, or a dated receipt?

That mindset is excellent for agents. Golden Lion should adopt it in a much
smaller form.

#### Nearest-scope routing

LawEngine uses root guidance for cross-cutting rules and nearest-folder guidance
for specialized areas. This matches how Codex discovers `AGENTS.md`: root first,
then closer files override it.

For Golden Lion, only a few nested guides are initially justified:

- `src/strategy/AGENTS.md`
- `src/bot/actions/AGENTS.md`
- `docs/AGENTS.md`

Do not create an `AGENTS.md` in every folder.

#### Config ownership and typed loaders

LawEngine's strongest reusable pattern is:

> A behavior-changing value has one owner and one typed loader.

Its configuration guidance distinguishes:

- Checked-in, nonsecret policy.
- Host-local secrets and credentials.
- File lifecycle and reload behavior.
- Consumers and tests.
- Cold-start failure versus last-known-good hot reload.
- Schema/hash/load-state observability.
- Generated registry tables checked against code.

This is exactly what Golden Lion needs for trading thresholds and capability
policy.

#### Anti-drift and provenance discipline

LawEngine distinguishes:

- Current code/runtime truth.
- Canonical reference.
- Active owner backlog.
- Plans.
- Historical evidence.
- Generated artifacts.

It also expects dated receipts, hashes, explicit unverified claims, concrete
restart points, and owner decisions. Golden Lion's existing production analyses
would become much more trustworthy under this model.

#### Capability-promotion language

LawEngine is careful not to infer “public/default” from “loaded” or “available.”
The direct Golden Lion analogue is:

```text
implemented ≠ enabled
enabled ≠ paper-verified
paper-verified ≠ bounded-live
bounded-live ≠ generally live
```

That promotion ledger is valuable for strategy changes and AI-facing tools.

### Patterns not to copy

#### The “short” root front door is too large

LawEngine's root `AGENTS.md` calls itself a short front door but is:

- 1,076 lines.
- 64,046 bytes.

This workstation raises `project_doc_max_bytes` to 65,536, so the file barely
fits by itself and leaves almost no project-instruction budget for nested files.
The official Codex default is 32 KiB, making it nonportable without custom
configuration.

Golden Lion should target roughly 100–150 lines and under 12 KiB at the root.

#### Documentation indexes became databases

Examples include:

- Root README: 1,221 lines.
- Consolidated TODO: about 6,958 lines.
- Docs routing index: 525 lines.
- Hundreds of README and AGENTS files.

The principles are good, but the context tax is enormous. Current facts copied
across those files have drifted despite anti-drift rules.

#### Governance exists without independent enforcement

LawEngine has substantial local quality tooling, but no tracked GitHub Actions
workflow. A current-document quality check still reports stale facts. Golden
Lion should install the mechanism and its independent enforcement together.

### Bottom-line pros and cons

| Pros to transfer | Cons to avoid |
|---|---|
| Explicit owner/source-of-truth rules | Huge mandatory read surface |
| Typed config and generated registries | Volatile state embedded in root guidance |
| Clear canonical/history distinction | Markdown backlogs used as databases |
| Provenance, receipts, and hashes | Duplicate current facts still drift |
| Nearest-scope routing | Too many nested instruction files |
| Promotion-state discipline | No required CI backstop |

---

## 4.3 Halsted Devices

### Patterns worth copying

#### One obvious owner boundary

The core organizing idea is simple:

- One top-level folder per physical machine.
- Machine facts belong in that machine's folder.
- Cross-fleet facts belong at root.
- Update the owner first, then dependent summaries.

Golden Lion should imitate this with subsystem ownership:

- Strategy truth belongs with strategy.
- Execution truth belongs with execution.
- Config metadata belongs in the config registry.
- Command truth belongs in the capability registry.
- Cross-system summaries are generated or deliberately maintained at root.

#### Explicit live-fact precedence

Halsted Devices clearly says live observations beat older current-state files,
which beat older audits and root summaries. It also requires confidence-qualified
wording when facts are not freshly verified.

Golden Lion needs the same distinction among:

- Current observed runtime state.
- Intended code behavior.
- Configured policy.
- Historical production evidence.

#### Exact runbooks and bounded scans

The strongest device runbooks specify:

- Exact target.
- Exact command.
- Expected output.
- What a specific failure does and does not prove.

Its scoped instructions also tell agents not to scan corpora, archives,
dependencies, dumps, or generated artifacts by default. That is a very useful
pattern for keeping Golden Lion agents out of runtime data and stale archives.

#### Clear secret boundaries

Device instructions distinguish public routing material from private keys.
Golden Lion should similarly distinguish versioned policy from credentials,
account identifiers, refresh tokens, socket keys, and live runtime state.

### Patterns not to copy

#### Markdown is used as an unvalidated fleet database

IPs, roles, aliases, and services are repeated across root docs, device docs,
networking docs, and current-state notes. The root quick-fleet table visibly
duplicates both EAP and NUC rows.

Golden Lion should not store configuration and command inventories as repeated
Markdown tables. Generate them from registries.

#### Stable files with stale dates are cognitively expensive

Halsted Devices sometimes keeps a dated filename for link stability while
updating its contents. A clearer pattern is:

- Stable semantic filename for current truth.
- Immutable dated receipt for historical evidence.

#### There is no validation layer

No machine-readable fleet manifest, schema test, link check, or CI workflow
ensures that repeated facts agree.

### Bottom-line pros and cons

| Pros to transfer | Cons to avoid |
|---|---|
| Simple owner boundaries | Repeated facts in Markdown |
| Live-fact precedence | Visible duplicate/stale rows |
| Exact runbooks | No schema or generation |
| Bounded agent scans | No CI validation |
| Clear secret handling | Historical/artifact clutter |
| Update owner first | Mutable content under dated filenames |

---

## 5. The canonical-source-of-truth model Golden Lion needs

A single linear “this file always wins” list is not enough. Different claim
types need different owners.

## 5.1 Truth ownership by claim type

| Question | Canonical owner | Generated/derived views |
|---|---|---|
| What may an agent do? | User scope + root/scoped `AGENTS.md` | Tool help |
| What commands exist? | Typed capability registry | CLI help, README table, JSON Schema |
| Which commands can mutate? | Capability registry + execution policy | Agent tool manifest |
| What settings exist? | Typed config registry | `.env.example`, config reference, `config:show` |
| What values are active now? | Validated runtime config snapshot | Redacted health/status output |
| What does the strategy intend? | Pure policy code + strategy invariants + tests | Human strategy explanation |
| What happened in production? | Broker receipts + versioned runtime records | Reports and analyses |
| Why was a decision made? | Accepted ADR | README summary |
| What is currently being worked on? | One roadmap/issue authority | Status summary |
| How is the service operated? | Versioned runbook | Quick-start excerpt |
| What is old evidence? | Immutable dated archive | Index only |

### Conflict rule

If sources disagree:

1. Do not silently choose the convenient source.
2. Stop any live-mutating action.
3. Record the exact disagreement.
4. Use the stricter safety interpretation.
5. Resolve the owning source first.
6. Regenerate derived documentation and rerun drift checks.

Observed live state can establish what *is happening*. It never grants
authorization for what an agent *may do*.

## 5.2 Document lifecycle classes

Every durable Markdown document should be one of:

| Class | Meaning | Mutability |
|---|---|---|
| `canonical` | Current human explanation owned by a subsystem | Updated in place |
| `decision` | Accepted rationale and tradeoff record | Immutable except supersession metadata |
| `current-status` | One bounded active roadmap/status | Updated in place |
| `proposal` | Not accepted or live | May evolve; never treated as behavior truth |
| `evidence` | Dated run, audit, experiment, or incident receipt | Immutable |
| `generated` | Derived from code/config/schema | Never hand-edited |
| `historical` | Superseded context | Immutable and clearly non-authoritative |
| `deprecated` | Retained only for links/migration | Points to replacement |

A minimal frontmatter contract:

```yaml
---
status: canonical
owner: execution
last_verified: 2026-07-23
last_verified_sha: fafdc51
update_triggers:
  - capability-registry
  - order-gateway
supersedes: []
---
```

Frontmatter is useful only if CI validates it. Do not add metadata that nobody
checks.

## 5.3 Stable current files, immutable receipts

Use:

```text
docs/strategy/CURRENT.md
docs/operations/RUNBOOK.md
docs/status/CURRENT.md
```

for current truth, and:

```text
docs/evidence/2026/07/2026-07-22-fallow-audit.md
docs/evidence/2026/07/2026-07-06-production-session.md
docs/incidents/2026/07/INC-2026-07-06-*.md
```

for immutable history.

This avoids both Golden Lion's competing live trackers and Halsted Devices'
mutable content under stale dated names.

## 5.4 One owner per value

No risk threshold, timeout, cap, command, persistence field, or profile state
should be independently restated in several places.

The pattern should be:

```text
machine-readable owner
        ↓ validates/generates
runtime + reference docs + examples + health output + tests
```

Prose may explain intent and tradeoffs, but it should link to the registry for
the exact default and range.

---

## 6. Immediate safety and correctness findings

These are code-audit findings, not claims that a live incident occurred.

## 6.1 P0 — read-only account protection is path-specific

The README says `BOT_READ_ONLY_ACCOUNTS` contains accounts the bot can inspect
but should not trade.

Normal run-cycle paths do enforce this:

- `src/bot/execute-position-evaluations.ts`
- `src/bot/run-cycle-seed.ts`
- `src/bot/run-cycle-context.ts`

Direct paths do not consistently enforce it:

- `src/ipc-server.ts:121-142` dispatches seed, purchase, and close directly.
- `src/bot/purchase-symbol.ts:46-60` enters the purchase path without the guard.
- `src/bot/close-symbol-position.ts:50-85` enters manual close without the guard.
- `src/bot/seed-symbol.ts` has no read-only guard.
- `src/strategy/secret/secret-auto-seed.ts` calls seed directly.

Omitted accounts also tend toward margin:

- `getDefaultAccountNumber()` prefers margin.
- IPC seed defaults explicitly to margin.
- Manual close defaults explicitly to margin.
- Purchase defaults through `getDefaultAccountNumber()`.

### Required design

Do not add another set of caller checks. Put the invariant at the lowest
mandatory boundary:

```text
all order create/replace/cancel/close intents
                    ↓
             ExecutionCoordinator
                    ↓
               OrderGateway
                    ↓
              Tastytrade adapter
```

The gateway must be the only module allowed to access raw broker mutation
methods. It should require:

- Explicit account alias for every mutating request.
- Valid execution mode.
- Valid operator capability.
- Read-only/allow-list decision.
- Idempotency key.
- Global/account/symbol concurrency key.
- Fresh balance/quote/session inputs.
- Risk-policy decision.
- Durable intent/audit record.

Then test the property:

> For every account classified read-only, every possible command and execution
> source produces zero raw broker mutation calls.

## 6.2 P0 — default-off execution modes are missing

There are dry-run operations and read-only account handling, but no universal
system mode such as:

```text
disabled
shadow
paper
bounded-live
live
close-only
halted
```

For a coding-agent workspace, the process should start in `disabled` unless a
validated deployment profile explicitly selects another mode.

Recommended state split:

- **Promotion stage:** disabled → shadow → paper → bounded-live → live.
- **Runtime risk state:** normal → close-only → halted.

An agent must not be able to mint the token or mutate the state that promotes
itself.

## 6.3 P0 — the current test baseline is not green

Current local results:

- Typecheck passes.
- 19 test-file processes pass.
- 32 fail during import because the locked/installed dxLink package lacks a
  named export requested by the Tastytrade SDK.

This reveals two design issues:

1. The supported Node/dependency combination is not independently enforced.
2. Pure strategy tests import a graph that reaches the live broker adapter.

Required response:

- Determine an upstream-compatible Tastytrade/dxLink pair; do not guess a
  version from this report.
- Add a tiny broker-adapter import/contract smoke test.
- Pin and document the supported Node and package-manager versions.
- Move broker client creation to the composition root.
- Keep pure policy tests free of the SDK import graph.
- Require a fresh `npm ci` verification in CI.

## 6.4 P0 — runtime-data exclusion is incomplete

The application writes under:

- `data/runs/`
- `data/ledger/`
- `data/day-reports/`
- `data/overnight/`
- spray and secret/streamer state paths

The current `.gitignore` protects only selected locations. Example files under
`data/day-reports`, `data/ledger`, and `data/overnight` are not ignored by the
current rules.

Use a deny-by-default policy:

```gitignore
data/**
!data/README.md
!data/fixtures/
!data/fixtures/**
!data/examples/
!data/examples/**
```

Fixtures must be sanitized, minimal, and deliberately selected.

`src/tools/realized-pnl.ts` also contains two hard-coded full account
identifiers. Replace them with validated account aliases or broker discovery,
and never print raw account identifiers by default.

## 6.5 P0 — local hooks are not an independent gate

The pre-commit hook is useful developer feedback, but:

- Missing Fallow tooling fails open.
- Coverage errors are best-effort.
- There is no tracked CI workflow.

For a money-moving service, merge truth must be independent of one developer's
installed tools.

## 6.6 P1 — money-touching calls can overlap

The scheduler's `inFlight` flag protects scheduler ticks, not every path.
Separate IPC clients, direct IPC trade commands, the scheduler, and secret
auto-seed may overlap.

The repository's own improvement tracker already identifies this risk.

Required behavior:

- One global execution queue for operations that cannot overlap.
- Narrower account/symbol locks where concurrency is safe.
- Idempotency keys persisted across restart.
- Duplicate-intent detection.
- Timeouts and explicit terminal state.

An in-memory promise chain is a useful short-term fix. Durable intent state is
the long-term fix.

## 6.7 P1 — shutdown has two owners

`src/index.ts` installs the intended graceful shutdown flow. `src/ipc-server.ts`
also installs SIGINT/SIGTERM handlers and calls `process.exit(0)`.

Because IPC startup occurs first, the IPC close callback can exit while the main
shutdown is waiting for work, canceling orders, or closing the streamer.

Only the composition root should own process signals and exit. Components should
expose idempotent `start()` / `stop()` methods.

## 6.8 P1 — file persistence is not transactional

The position registry and spray state use read/modify/write JSON flows. A
concurrent writer can clobber another update, and a crash during write can
damage the file.

Short term:

- Serialize mutations.
- Write to a same-filesystem temporary file.
- `fsync` as appropriate.
- Atomically rename.
- Version the schema.

Medium term:

- Use SQLite in WAL mode for mutable state and order/risk transitions.
- Retain NDJSON as an append-only export/audit format.

SQLite is not mandatory because it is fashionable. It is a good fit because
this is a single-host daemon that needs transactions, constraints, migrations,
restart recovery, and queryable history without operating a separate database.

## 6.9 P1 — config masking leaks structure

Sensitive values are currently shown as their first four characters plus
length. That is better than full output but unnecessary.

Use metadata-driven redaction:

```text
[REDACTED]
```

Do not infer secrecy from a name regex alone. Each registered field should
declare whether it is sensitive.

## 6.10 P1 — IPC cleanup and production-only commands need hardening

Additional concerns:

- Stale-socket cleanup unlinks whatever path is configured without first
  proving it is a socket in an allowed directory.
- IPC input has no explicit size bound.
- The client lacks an explicit request timeout.
- `bot:johnsTestRun` is production-registered, undocumented, and prints broad
  account/position information.
- `config:show` returns every recognized prefixed environment value after
  regex-based masking.

Classify and constrain these surfaces in the capability registry.

## 6.11 Owner decision — account-level daily-loss state

The existing backlog identifies an account-level daily-loss circuit breaker as
unfinished. Before any autonomous live execution, consider a durable risk state:

```text
NORMAL → CLOSE_ONLY → HALTED
```

Potential triggers include:

- Realized plus unrealized daily loss.
- Drawdown from intraday equity high.
- Stale balance or quote state.
- Repeated broker rejection.
- Feed degradation.
- Registry/broker inconsistency.
- Operator kill switch.

Exact financial thresholds are an owner/risk decision, not something an agent
should invent.

---

## 7. World-class AI-tool architecture

There are two distinct goals:

1. Make the repository easy for a coding agent to maintain.
2. Potentially expose system capabilities to an AI tool.

The first can happen now. The second must wait for the safety boundary.

## 7.1 Deterministic core, agent as proposer

The AI should be allowed to:

- Read code and sanitized evidence.
- Explain current state.
- Draft changes.
- Run offline checks.
- Generate a proposed strategy/config diff.
- Run deterministic scenario replays.
- Compare outputs against invariants.

The AI should not own:

- Account authorization.
- Hard risk limits.
- Execution-mode promotion.
- Order idempotency.
- Market-session validation.
- Broker credentials.
- Final live execution.

Architecture:

```text
AI / human request
        ↓
typed read-only tools and proposal tools
        ↓
deterministic planner / policy engine
        ↓
human-visible preview + evidence
        ↓
operator capability check
        ↓
ExecutionCoordinator
        ↓
broker adapter
```

The AI can propose. Deterministic code decides whether a proposal is valid.
Explicit operator authority decides whether a valid proposal may become live.

## 7.2 Capability tiers

Every command should be one of:

| Tier | Examples | Default agent access |
|---|---|---|
| `read` | status, metrics, config metadata, previews | Allowed |
| `simulate` | replay, paper evaluation, dry-run plan | Allowed offline |
| `control` | start/stop scheduler, rotate state | Denied without explicit authorization |
| `trade` | seed, purchase, replace, close | Denied |
| `emergency` | cancel all, close-only, halt | Operator-controlled; separate policy |

“Emergency” does not mean “safe for any caller.” It means a deliberately
designed protective path with separate audit and authorization.

## 7.3 Promotion ledger

For every new strategy or execution capability, track:

```text
implemented
  → unit verified
  → replay verified
  → shadow/log-only
  → paper
  → bounded-live
  → live
  → deprecated/rolled back
```

Each promotion should record:

- Code SHA.
- Config hash.
- Dataset/evidence identifiers.
- Acceptance metrics.
- Risk limits.
- Rollback trigger.
- Owner approval.
- Expiry/review date.

Code existence must never imply live enablement.

## 7.4 Separate agent and service identities

Socket mode `0600` protects against other Unix users, but a coding agent running
as the same user can still reach the socket.

For stronger isolation:

- Run the live service under a dedicated OS account.
- Give coding agents no access to its live socket or secret store.
- Expose a separate read-only status surface.
- Require a short-lived, operator-created capability for protected control
  operations.
- Log capability subject, scope, expiry, request ID, code SHA, and config hash.

This is a much stronger boundary than “the agent was told not to call it.”

---

## 8. Proposed repository structure

This is a target map, not a recommendation to rename everything immediately.
Start by adding control-plane files and enforcing boundaries around the existing
folders. Migrate one vertical use case at a time.

```text
tastytrade-silver-lynx/
├── AGENTS.md
├── CLAUDE.md                    # thin compatibility pointer only
├── README.md                    # product, setup, high-level architecture
├── CONTRIBUTING.md
├── SECURITY.md
├── CHANGELOG.md
├── package.json
├── package-lock.json
├── .node-version
├── config/
│   ├── README.md
│   ├── profiles/
│   │   ├── local-safe.yaml
│   │   ├── paper.yaml
│   │   └── production.example.yaml
│   └── policies/
│       └── risk-policy.example.yaml
├── schemas/
│   ├── config.schema.json       # generated
│   ├── commands.schema.json     # generated
│   └── records/
├── docs/
│   ├── AGENTS.md
│   ├── README.md                # small registry and truth map
│   ├── architecture/
│   │   ├── SYSTEM.md
│   │   ├── MODULE_BOUNDARIES.md
│   │   └── DATA_FLOW.md
│   ├── strategy/
│   │   ├── CURRENT.md
│   │   └── INVARIANTS.md
│   ├── operations/
│   │   ├── RUNBOOK.md
│   │   ├── DEPLOY.md
│   │   ├── ROLLBACK.md
│   │   ├── EMERGENCY.md
│   │   ├── DATA_RETENTION.md
│   │   └── INCIDENT_TEMPLATE.md
│   ├── reference/
│   │   ├── CONFIG.md            # generated
│   │   ├── IPC.md               # generated
│   │   └── DATA_FORMATS.md      # generated
│   ├── decisions/
│   │   └── ADR-0000-template.md
│   ├── status/
│   │   └── CURRENT.md
│   ├── evidence/
│   │   └── YYYY/MM/
│   └── archive/
│       └── AGENTS.md            # explicitly historical/non-authoritative
├── src/
│   ├── app/
│   │   ├── bootstrap.ts
│   │   ├── lifecycle.ts
│   │   └── runtime-context.ts
│   ├── domain/
│   │   ├── portfolio/
│   │   ├── strategy/
│   │   ├── risk/
│   │   └── orders/
│   ├── application/
│   │   ├── commands/
│   │   ├── cycles/
│   │   ├── execution/
│   │   └── ports/
│   ├── adapters/
│   │   ├── tastytrade/
│   │   ├── dxlink/
│   │   ├── ipc/
│   │   ├── persistence/
│   │   └── clock/
│   ├── config/
│   │   ├── registry.ts
│   │   └── loader.ts
│   └── observability/
├── tests/
│   ├── unit/
│   ├── property/
│   ├── integration/
│   ├── contract/
│   ├── replay/
│   └── fixtures/
└── tools/                        # tracked, safe operational/dev tooling
```

### Dependency direction

```text
domain ← application ← adapters / app bootstrap
```

Rules:

- `domain` imports no SDK, filesystem, environment, IPC, network, timers, or
  process globals.
- `application` depends on ports/interfaces, not concrete adapters.
- `adapters` implement ports.
- `app/bootstrap.ts` wires concrete dependencies.
- Raw broker mutation is available only inside the Tastytrade adapter and only
  through `OrderGateway`.
- Agent-facing command metadata lives with application commands, not in README
  prose.

### Migration without a big-bang rewrite

1. Add import-boundary checks describing the intended current layers.
2. Introduce ports at existing high-risk seams.
3. Move client creation out of import-time singletons.
4. Extract one path end to end—such as manual purchase—through the new
   coordinator.
5. Add characterization and contract tests.
6. Repeat for seed, close, scheduler, and secret auto-seed.
7. Rename folders only after dependency direction is real.

---

## 9. Ready-to-adapt root `AGENTS.md`

The following is a starter, not a file this audit silently installed. It should
be reviewed with the owner, placed inside the **actual Git root**, and committed.
Keep it concise; link to owned documents instead of copying volatile facts.

```markdown
# AGENTS.md — Tastytrade Golden Lion

Updated: YYYY-MM-DD
Scope: repository root

## Mission and safety

Golden Lion is a TypeScript options-trading service that can place real orders.
Treat every broker mutation, scheduler action, production configuration change,
and deployment as a high-impact operation.

Default to offline and read-only work. Never infer permission to trade from the
presence of credentials, a running socket, an existing command, or prior live
use.

## Repository boundary

The Git root is the directory containing this file and `package.json`.
Do not treat the outer workspace wrapper as the repository.

Preserve existing user changes. Do not rewrite or delete dirty files unless the
current task explicitly requires it.

## Read order

1. `AGENTS.md`
2. `README.md`
3. `docs/README.md`
4. `docs/status/CURRENT.md` when present
5. The nearest scoped `AGENTS.md` and README for paths being changed

Read historical evidence only when it is relevant. Files under `docs/archive/`
and dated evidence are not current requirements unless a canonical document
promotes them.

## Truth ownership

- Agent permissions and workflow: `AGENTS.md`
- Command existence and risk class: typed capability registry
- Config keys, defaults, units, and secrecy: typed config registry
- Runtime behavior: code, schemas, and passing tests
- Current strategy explanation: `docs/strategy/CURRENT.md`
- Safety invariants: `docs/strategy/INVARIANTS.md`
- Operations: `docs/operations/`
- Current work: one status/backlog authority
- Rationale: accepted ADRs
- Historical results: immutable evidence

If sources conflict, stop live-mutating work, report the disagreement, and use
the stricter safety interpretation until the owner is reconciled.

## Safe by default

Allowed without live-operation authorization:

- Read files and Git history.
- Run static analysis.
- Run typecheck, offline unit tests, builds, and deterministic replays.
- Edit code and docs within the requested scope.
- Use fake/sanitized fixtures.

Requires explicit authorization for the exact action:

- Reading or modifying secret values in `.env` or a secret store.
- Calling the broker or private signal feed.
- Starting the service or scheduler.
- Running mutating IPC commands.
- Restarting or deploying the production process.
- Changing a production profile or any risk threshold.
- Migrating or deleting runtime state.

Never:

- Guess an account number for a mutating command.
- Use the default account for a trade-class request.
- Allow tests to place live orders.
- Weaken a safety limit as incidental cleanup.
- Print or commit credentials, raw account identifiers, or private trade data.
- Treat implemented code as promoted to live.

## Current local commands

Install only when dependency changes or setup is in scope:

    npm ci

Offline verification:

    npm run typecheck
    npm test
    npm run build
    npm run fallow

Do not run `npm start`, PM2, the scheduler, or `node run <mutating-command>` as a
verification step.

If the known baseline is not green, state the exact failing command and root
cause. Do not claim a test pass from source test counts or historical output.

## Architecture rules

- Domain policy must remain pure and deterministic.
- Broker, filesystem, environment, clock, feed, and IPC access belong behind
  ports/adapters.
- Every broker mutation must pass through `ExecutionCoordinator` and
  `OrderGateway`.
- Do not add new reverse imports across enforced boundaries.
- Prefer dependency injection at side-effect seams.
- Refactor high-risk flows one vertical slice at a time with characterization
  tests.

## Configuration

- A behavior-changing value has one registered owner and one typed loader.
- Do not add bare tunable constants or unregistered environment variables.
- Environment/secret stores hold secrets and host-local identity only.
- Versioned profiles hold reviewed nonsecret behavior policy.
- Reject unknown keys, invalid units, and out-of-range values.
- Generated config docs and `.env.example` must match the registry.

## Commands and tools

- Add IPC/tool commands through the typed capability registry.
- Declare input/output schema, risk tier, allowed modes, account requirements,
  idempotency, concurrency key, timeout, audit event, and tests.
- Generate command help/reference from the registry.
- Agent access is read/simulate by default; trade/control/emergency permissions
  are separate and explicit.

## Data and privacy

- Runtime data is ignored by default.
- Commit only sanitized, minimal, intentional fixtures.
- Version durable schemas.
- Use account aliases in logs and docs.
- Never hand-edit generated references.

## Documentation

- README explains the product; AGENTS explains how to work.
- Use stable semantic filenames for current truth.
- Use dated immutable files for evidence and incidents.
- Keep exactly one current status/backlog authority.
- Add an ADR for consequential architectural or risk-policy decisions.
- Update the owner source first, then regenerate derived documentation.

## Verification by change type

| Change | Minimum proof |
|---|---|
| Pure strategy/risk policy | unit + property + replay |
| Order execution | above + fake-broker integration + race/idempotency tests |
| Config | schema + generated drift + invalid/unknown-key tests |
| IPC command | schema + risk authorization + integration + generated help |
| Persistence | migration + crash recovery + rollback |
| Operations | safe dry-run + rollback/health proof |
| Docs only | link + generated/current-state drift checks |

## Definition of done

- Requested behavior is implemented.
- Required checks pass or exact blockers are reported.
- No live system was touched without explicit authorization.
- Generated surfaces are current.
- Relevant docs/ADR/status are updated without creating a competing source.
- User changes remain preserved.
- The final handoff states files changed, checks run, results, risks, and next
  operator action.
```

### `CLAUDE.md` after the root contract exists

Make it a thin compatibility layer:

```markdown
# Claude Code

Read and follow `AGENTS.md`. Repository-wide source-of-truth, safety,
verification, and documentation rules live there.

Claude-specific hooks are configured under `.claude/`. They are local feedback,
not a substitute for required CI.
```

This prevents Codex and Claude instructions from becoming separate realities.

---

## 10. Typed configuration control plane

## 10.1 Separate metadata, values, and secrets

Recommended ownership:

| Concern | Owner |
|---|---|
| Key, type, unit, range, default, sensitivity, lifecycle | TypeScript registry |
| Reviewed nonsecret strategy values | Versioned YAML profile |
| Credentials, refresh tokens, private socket keys | Environment/secret store |
| Host-local account mapping | Secret/local identity config using aliases |
| Effective runtime snapshot | Validated, redacted generated output |
| Human reference | Generated Markdown |

This preserves the user's preference for YAML/config-driven growth without
making untyped YAML the safety system.

## 10.2 Example registry entry

```ts
export const configRegistry = defineConfigRegistry({
  STRATEGY_MARGIN_MAX_TOTAL_UTILIZATION: {
    type: "number",
    unit: "multiple_of_nlv",
    default: 1.5,
    minimum: 0,
    maximum: 2,
    sensitive: false,
    safetyClass: "hard_limit",
    owner: "risk",
    source: "profile",
    restartRequired: true,
    deprecatedAliases: [],
    description: "Maximum total margin option exposure as a multiple of NLV.",
  },
});
```

## 10.3 Example profile

```yaml
schema_version: 1
profile: local-safe
execution:
  mode: disabled
strategy:
  margin_max_total_utilization: 1.5
  max_underlying_account_pct: 0.60
  combined_underlying_cap_pct: 0.70
```

Rules:

- Reject unknown keys.
- Reject duplicate YAML keys.
- Reject ambiguous percent units; canonicalize ratios as `0..1`.
- Validate cross-field invariants.
- Fail cold start on invalid policy.
- If hot reload is later supported, retain an immutable last-known-good
  snapshot and expose stale/LKG status.
- Hash the validated effective config.
- Record config hash with each cycle/order/evidence receipt.
- Generate `.env.example` only for actual environment-owned keys.

## 10.4 Why this is better

| Benefit | Tradeoff |
|---|---|
| Defaults cannot silently disagree | Requires generator/validation work |
| Docs become reproducible | Adds schema discipline to small changes |
| Secrets are explicitly tagged | Registry must be kept mandatory |
| Units/ranges become testable | Migration from current env sprawl takes time |
| Config hashes support audit/replay | Production profile governance is needed |

This is worth the cost because a stale config description in this system can
misrepresent a real-money safety limit.

---

## 11. Typed capability and IPC registry

The current `Record<string, handler>` is a useful start, but it encodes only
names and handlers.

Recommended shape:

```ts
type CommandRisk = "read" | "simulate" | "control" | "trade" | "emergency";

const commands = defineCommands({
  "bot:purchaseSymbol": {
    description: "Create a validated purchase intent for one underlying.",
    input: PurchaseSymbolInputSchema,
    output: PurchaseSymbolResultSchema,
    owner: "execution",
    risk: "trade" satisfies CommandRisk,
    allowedModes: ["paper", "bounded-live", "live"],
    explicitAccountRequired: true,
    operatorCapabilityRequired: true,
    idempotencyRequired: true,
    concurrencyKey: ({ accountAlias, symbol }) =>
      `${accountAlias}:${symbol}:purchase`,
    timeoutMs: 30_000,
    auditEvent: "purchase-symbol-request",
    handler: purchaseSymbolCommand,
  },
});
```

Generate from the registry:

- Dispatch.
- Runtime input validation.
- `core:listCommands` rich help.
- `docs/reference/IPC.md`.
- JSON Schema/tool definitions.
- CLI completion.
- Permission/risk tables.
- Tests proving every command has classification and schemas.

### Immediate command cleanup

- Add the four currently undocumented routes to generated reference or remove
  them from production:
  - `config:show`
  - `bot:closePosition`
  - `bot:johnsTestRun`
  - `strategy:getUnderlyingIvMetrics`
- Remove or tightly guard `bot:johnsTestRun`.
- Require explicit accounts for trade-class commands.
- Add request size, timeout, and cancellation semantics.
- Make money-touching handlers use the global coordinator.
- Generate documentation; stop hand-maintaining the route list.

---

## 12. Persistence, evidence, and observability

## 12.1 Keep NDJSON, but give it a contract

NDJSON is excellent for append-only audit and human inspection. Add:

- `schemaVersion`.
- `eventId`.
- `correlationId`.
- `cycleId` / `commandId`.
- Account alias, not raw account ID.
- Code SHA.
- Config hash.
- Execution mode.
- Source capability.
- Observed/decision/execution timestamps.
- Redaction version.

Never rewrite historical receipts to make current conclusions look cleaner.

## 12.2 Use transactions for mutable truth

Mutable truth includes:

- Open/closed position registry.
- Execution intents.
- Idempotency records.
- Working-order state.
- Risk state.
- Promotion state.
- Schema migrations.

Recommended SQLite tables:

```text
schema_migrations
execution_intents
commands
orders
order_attempts
fills
positions
risk_events
account_snapshots
strategy_decisions
config_snapshots
promotion_events
```

SQLite tradeoffs:

| Pros | Cons |
|---|---|
| Transactions and constraints | Requires migration discipline |
| Durable idempotency | New failure/backup surface |
| WAL works well for one host | Not a multi-host database |
| Queryable audits | Existing NDJSON tools need adapters |
| Atomic state transitions | Must define retention and recovery |

Keep NDJSON export so operational workflows remain transparent.

## 12.3 Structured observability

The code contains hundreds of direct `console.*` calls. Many are structured,
but there is no universal event contract.

Move toward:

- Structured logger with event name and schema.
- Correlation from command → decision → order → fill → report.
- Redaction at logger boundary.
- Health/readiness status.
- Current mode and risk state.
- Broker/feed freshness.
- Registry/broker reconciliation status.
- Config hash and code SHA.
- Metrics for rejection, retry, fill, latency, and risk transitions.

Do not expose secret values or raw account identifiers in health output.

---

## 13. Testing strategy

## 13.1 Preserve the existing tests

The current tests are a major asset. First make their environment reproducible.
Do not discard them during architecture work.

## 13.2 Separate assurance levels

```text
tests/
  unit/         pure functions and deterministic policies
  property/     invariants across generated inputs
  contract/     sanitized SDK/broker/feed payload contracts
  integration/  fake broker + IPC + persistence
  replay/       recorded, sanitized production scenarios
  migration/    state/schema upgrade and rollback
  chaos/        cancellation, crash, timeout, concurrency
```

Critical properties:

- Read-only accounts can never generate a raw mutation call.
- Disabled/shadow modes can never mutate.
- Repeating one idempotency key cannot create a second order.
- Cancel failure cannot cause a replacement/double order.
- Exposure caps and risk state survive restart.
- Stale quotes/balances fail closed.
- EOD policy is deterministic under a fake clock.
- Shutdown cannot exit while an order transition is unresolved.
- Unknown configuration keys fail.
- Generated config and command docs are current.

## 13.3 Broker and feed contract isolation

Pure tests should not import a module that instantiates a live-capable client.

Use ports:

```ts
interface BrokerReadPort { /* balances, positions, quotes */ }
interface BrokerOrderPort { /* create, replace, cancel, status */ }
interface MarketClock { now(): Date }
interface StateStore { /* transactional methods */ }
```

Then:

- Pure tests use in-memory fakes.
- Contract tests load sanitized captured payloads.
- One adapter smoke test verifies the supported SDK pair.
- Paper/live checks are separate operator workflows, never ordinary unit tests.

## 13.4 Replay as the agent's laboratory

A coding agent becomes far more valuable when it can run:

```text
sanitized input snapshot
        +
code SHA
        +
config profile/hash
        +
fake clock
        ↓
deterministic decisions and order intents
        ↓
invariant checks and comparison report
```

This lets the agent quantify a change without touching a live account.

---

## 14. CI, supply chain, and releases

## 14.1 One proposed verification command

Add a single owner command:

```bash
npm run verify
```

It should orchestrate:

```text
typecheck
unit/property/contract tests
build
Fallow new-finding gate
dependency-boundary check
config schema and generated-doc drift
capability schema and generated-doc drift
Markdown link check
secret/runtime-data scan
```

Keep individual scripts for diagnosis, but make the definition of done obvious.

## 14.2 Required CI

A pull request workflow should use:

1. Checkout.
2. The pinned supported Node version.
3. `npm ci`.
4. `npm run verify`.
5. Upload test, coverage, Fallow, and generated-diff artifacts on failure.

GitHub's current official Node CI guidance uses `setup-node` and `npm ci` for
repeatable installs. Local hooks should remain fast feedback, while CI is the
required backstop.

Also add:

- Branch protection.
- CODEOWNERS for risk/execution/config paths.
- Dependency update automation.
- Secret scanning.
- Lockfile review.
- Minimal permissions in workflows.
- Pinned third-party action revisions.
- SBOM/release artifact inventory as the project matures.

## 14.3 Pin the runtime intentionally

Current operations documentation says production needs Node 24, while the audit
host ran Node 22.23.1. The repository has no `.node-version`, `engines`, or
`packageManager`.

First verify the supported runtime/dependency pair. If production remains Node
24, express it consistently in:

- `.node-version`
- `package.json` `engines`
- `package.json` `packageManager`
- CI
- deployment manifest
- runbook

Do not allow PM2's ambient shell to be the only runtime specification.

## 14.4 Build once, deploy by identity

Each deploy should record:

- Git SHA.
- Dependency lock hash.
- Build artifact hash.
- Node/npm versions.
- Config schema version and effective config hash.
- Migration version.
- Promotion stage.
- Operator.
- Health verification.
- Rollback target.

The service should deploy a tested artifact, not build ad hoc from an unknown
working tree.

## 14.5 Secure-development references

The recommendations align with:

- [OpenAI's current `AGENTS.md` discovery guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
  for layered, nearest-scope instructions, empty-file behavior, and instruction
  size limits.
- [GitHub's Node.js CI guidance](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs)
  for pinned Node setup and `npm ci`.
- [NIST SP 800-218 SSDF v1.1](https://csrc.nist.gov/pubs/sp/800/218/final)
  for integrating outcome-based secure-development practices into the lifecycle.
- [OpenSSF Scorecard](https://www.scorecard.dev/) as a useful supply-chain
  practice inventory, not a substitute for project-specific risk review.

---

## 15. Documentation operating system

## 15.1 Root files have distinct jobs

| File | Job |
|---|---|
| `AGENTS.md` | How agents/humans may work; safety and verification |
| `README.md` | What the product is; setup and high-level runtime |
| `docs/README.md` | Small routing and authority registry |
| `CONTRIBUTING.md` | Human contribution and PR/release workflow |
| `SECURITY.md` | Vulnerability reporting and sensitive-data rules |
| `CHANGELOG.md` | Release-level user/operator changes |

Do not put live metrics, current PIDs, account IDs, or large backlogs in
`AGENTS.md`.

## 15.2 Keep the read path bounded

Normal task:

```text
root AGENTS + README + nearest scoped guide + one owner doc
```

Broad architecture task:

```text
normal path + docs/README + system architecture + current status
```

Incident:

```text
root safety rules + runbook + exact live evidence + relevant incident receipt
```

Historical improvement files should not be mandatory startup reading.

## 15.3 Replace raw line anchors

The link audit found:

- 33 links with wrong relative paths, mostly under improvement logs.
- Three links to absent or moved intended targets.
- Additional strategy references whose raw source line numbers no longer point
  to the described symbol.

Canonical docs should link:

- Stable file and exported symbol.
- Test name.
- ADR.
- Generated registry entry.

Avoid `file.ts:883-910` as durable prose. Source lines move on every refactor.

## 15.4 One current backlog

Each item should have:

```yaml
id: GL-EXEC-001
status: ready
owner: execution
risk: P0
evidence:
  - src/ipc-server.ts
next_action: route direct trade commands through ExecutionCoordinator
acceptance:
  - all mutation paths pass the read-only property test
blockers: []
```

Use GitHub issues if that is the owner's preferred current system. If Markdown
is used, keep one bounded `docs/status/CURRENT.md`. Historical improvement
passes remain evidence, not parallel task databases.

## 15.5 Drift triggers

CI should know that:

- Config registry changes regenerate config schema/reference/example.
- Capability registry changes regenerate IPC schema/reference/help.
- Persistence schemas update data-format docs and migration tests.
- Strategy invariant changes require strategy docs, replay, and ADR review.
- Operations changes require runbook/rollback checks.

This is more reliable than asking a contributor to remember five files.

---

## 16. Prioritized implementation roadmap

Effort ranges are rough single-engineer estimates. Safety review may extend them.

## Phase 0A — restore a trustworthy baseline (1–3 days)

1. Capture the current SHA and preserve the dirty `CLAUDE.md` / empty
   `AGENTS.md`.
2. Resolve the Tastytrade/dxLink compatibility failure.
3. Pin the supported Node and package-manager versions.
4. Add `npm run verify`.
5. Add required CI using `npm ci`.
6. Make test output clearly report actual test cases and file-load failures.

**Exit gate:** a fresh checkout can install and pass the agreed offline suite.

## Phase 0B — close safety gaps before AI live access (2–5 days)

1. Add default-off execution mode.
2. Require explicit account alias for every mutating command.
3. Route all broker mutations through a mandatory `OrderGateway`.
4. Enforce read-only and capability policy inside that boundary.
5. Add global/account/symbol execution serialization and idempotency.
6. Protect all runtime data paths.
7. Remove hard-coded account identifiers.
8. Remove/guard production debug commands.
9. Unify shutdown ownership.

**Exit gate:** property and fake-broker tests prove no path can bypass
mode/account/authorization policy.

## Phase 1 — establish canonical authority without runtime redesign (2–4 days)

1. Review, populate, and track root `AGENTS.md`.
2. Reduce `CLAUDE.md` to a pointer.
3. Add small `docs/README.md`.
4. Declare truth ownership and document lifecycle.
5. Reconcile README/strategy/current status with code.
6. Fix all 36 broken local links.
7. Relabel improvement logs as evidence/history.
8. Create one current backlog/status.
9. Add deploy, rollback, emergency, and data-retention runbooks.

**Exit gate:** an agent can identify the owner for any behavior/config/command
claim in under two hops.

## Phase 2 — machine-readable control planes (4–8 days)

1. Implement typed config registry.
2. Separate safe/paper/production values from secrets.
3. Generate config schema, example, reference, redaction, and health metadata.
4. Implement typed capability registry.
5. Generate IPC help/reference/tool schema.
6. Add command risk tiers, required account behavior, allowed modes,
   idempotency, concurrency, timeout, and audit metadata.
7. Enforce generated-file drift in CI.

**Exit gate:** zero manually duplicated config defaults and command lists.

## Phase 3 — enforce architecture and transactional state (1–3 weeks)

1. Add import-boundary checks.
2. Move client construction to bootstrap.
3. Introduce broker/feed/clock/persistence ports.
4. Migrate manual purchase, seed, close, scheduler, and secret auto-seed one
   vertical path at a time.
5. Add transactional risk/idempotency/intent state.
6. Add schema versions and migrations.
7. Keep NDJSON as exports and evidence.

**Exit gate:** zero raw broker mutation calls outside the gateway and zero
enforced dependency-boundary violations.

## Phase 4 — replay, promotion, and releases (1–2 weeks, then ongoing)

1. Build sanitized deterministic scenario replay.
2. Define strategy promotion states and gates.
3. Add config/code/evidence hashes to receipts.
4. Establish paper and bounded-live canary workflows.
5. Add release tags, changelog, deploy receipts, health proof, and rollback.
6. Add an account-level risk-state owner decision and implementation if
   approved.

**Exit gate:** every live promotion is traceable to a green artifact, config
hash, evidence packet, owner approval, and rollback condition.

## Phase 5 — incremental complexity reduction (ongoing)

Prioritize by risk and dependency leverage:

1. `manageAllocationForGroup`
2. `closePosition`
3. `runBotCycle`
4. `seedSymbol`
5. option candidate selection
6. quote/option service lifecycle

Extract policies and seams with characterization tests. Do not set “all files
under N lines” as the goal; set enforceable responsibility and complexity
budgets.

---

## 17. Quantitative success criteria

### Safety

- 100% of broker mutations pass through `OrderGateway`.
- 100% of mutating commands require an explicit account alias.
- 100% of mutating commands have mode, capability, idempotency, concurrency,
  timeout, and audit metadata.
- 0 raw account identifiers in source, committed fixtures, docs, or default logs.
- 0 live broker/feed calls in ordinary test jobs.
- 0 ways for an agent to self-promote execution mode.

### Reproducibility

- Fresh `npm ci` + `npm run verify` is green.
- 51/51 test files load and all declared tests execute.
- Supported Node/npm versions are identical in local config, CI, and deployment.
- 100% of deployments identify code SHA, artifact hash, and config hash.

### Canonical truth

- 1 tracked root `AGENTS.md`, under 12 KiB.
- 1 current status/backlog authority.
- 0 broken internal links.
- 0 active config keys absent from the registry.
- 0 command names manually duplicated in docs.
- 100% of canonical docs have owner, lifecycle, and verification metadata.
- 0 raw source-line ranges in canonical documentation.

### Architecture

- 0 raw broker mutations outside the adapter/gateway.
- 0 enforced dependency-boundary violations.
- 0 circular dependencies as an eventual target.
- Every mutable store has schema version, migration, and crash-recovery test.
- Every high-risk use case has fake-broker integration and replay coverage.

### Operations

- Deploy, rollback, emergency, and restore runbooks are versioned and tested.
- Runtime state is ignored by default.
- Health output includes mode, risk state, dependency/feed freshness, code SHA,
  and config hash without secrets.
- Every incident and live promotion has an immutable receipt.

---

## 18. What not to build

Avoid these attractive mistakes:

- A 1,000-line root `AGENTS.md`.
- An `AGENTS.md` in every directory.
- A separate full Claude truth and full Codex truth.
- A vector database for a 183-file repository before basic routing works.
- Repeated Markdown tables for config, commands, or record fields.
- “AI safety” implemented only as prompt instructions.
- A broad MCP server that exposes live trade commands before capability
  enforcement exists.
- A big-bang clean-architecture rewrite.
- A YAML policy system without strict schema, units, range, and unknown-key
  validation.
- A generated doc that can be hand-edited.
- A fail-open local hook presented as release assurance.
- A status filename whose date becomes stale while its contents keep changing.
- Historical experiments that still look like active requirements.
- Raw production artifacts, archives, zips, or account data committed “for
  context.”
- Strategy thresholds invented by an agent because the current docs conflict.

---

## 19. Recommended first pull requests

Keep early changes reviewable.

### PR 1 — baseline and privacy

- Resolve SDK/dxLink compatibility.
- Pin runtime/package manager.
- Add CI and `npm run verify`.
- Ignore runtime data deny-by-default.
- Remove hard-coded account identifiers.

### PR 2 — universal execution safety

- Add execution-mode model.
- Require explicit account alias.
- Introduce `ExecutionCoordinator` / `OrderGateway`.
- Route direct IPC and secret auto-seed through it.
- Add read-only, idempotency, and concurrency property tests.

### PR 3 — repository front door

- Populate tracked `AGENTS.md`.
- Thin `CLAUDE.md`.
- Add docs registry/lifecycle.
- Fix link and obvious current-doc drift.
- Establish one current status.

### PR 4 — capability registry

- Convert the 38 IPC routes to typed definitions.
- Generate list/help/reference/schema.
- Remove or isolate debug commands.
- Add permission metadata and validation.

### PR 5 — config registry

- Register keys, units, defaults, ranges, sensitivity, owner, and deprecations.
- Generate `.env.example` and config reference.
- Add safe/paper profile boundary.
- Add config hash and strict validation.

Each pull request should be behavior-neutral unless its purpose explicitly
changes behavior, and should state whether it is safe to deploy independently.

---

## 20. Final assessment

Golden Lion's core advantage is not its current folder names. It is the
combination of:

- Fast domain learning.
- Quantitative production feedback.
- Meaningful tests.
- Operational receipts.
- Willingness to encode risk rules.

The repository's current weakness is that those strengths live in several
parallel truth systems:

```text
code
README
CLAUDE
strategy prose
environment template
improvement trackers
historical receipts
```

A coding agent sees all of them, but cannot reliably know which one is current.
Worse, some safety statements are stronger than the common execution boundary
actually guarantees.

The right transformation is:

```text
from:
  prose, memory, caller discipline, and local hooks

to:
  owned typed contracts, generated explanations, mandatory safety seams,
  deterministic replays, independent CI, and hash-bound releases
```

That is the best of all three repositories:

- **LawEngine:** ownership, canonical routing, config discipline, promotion
  state, receipts.
- **Halsted Devices:** simple boundaries, live-fact precedence, exact runbooks,
  bounded scans.
- **Golden Lion:** compactness, tests, domain intelligence, structured evidence,
  and rapid iteration.

If the P0 safety and reproducibility work lands first, Golden Lion can become a
very strong agent-maintained repository without becoming a documentation
monolith. More importantly, it can gain AI leverage without confusing AI access
with authority over real money.

---

## Appendix A — key evidence pointers

### Golden Lion

- Product and current hand-maintained config/IPC reference:
  [`tastytrade-silver-lynx/README.md`](tastytrade-silver-lynx/README.md)
- Empty agent front door:
  [`tastytrade-silver-lynx/AGENTS.md`](tastytrade-silver-lynx/AGENTS.md)
- Current Claude guidance:
  [`tastytrade-silver-lynx/CLAUDE.md`](tastytrade-silver-lynx/CLAUDE.md)
- Strategy prose:
  [`tastytrade-silver-lynx/docs/STRATEGY.v2.md`](tastytrade-silver-lynx/docs/STRATEGY.v2.md)
- IPC registry and lifecycle:
  [`tastytrade-silver-lynx/src/ipc-server.ts`](tastytrade-silver-lynx/src/ipc-server.ts)
- Account defaults/read-only set:
  [`tastytrade-silver-lynx/src/core/default-account.ts`](tastytrade-silver-lynx/src/core/default-account.ts)
- Direct purchase:
  [`tastytrade-silver-lynx/src/bot/purchase-symbol.ts`](tastytrade-silver-lynx/src/bot/purchase-symbol.ts)
- Direct manual close:
  [`tastytrade-silver-lynx/src/bot/close-symbol-position.ts`](tastytrade-silver-lynx/src/bot/close-symbol-position.ts)
- Seed path:
  [`tastytrade-silver-lynx/src/bot/seed-symbol.ts`](tastytrade-silver-lynx/src/bot/seed-symbol.ts)
- Secret auto-seed:
  [`tastytrade-silver-lynx/src/strategy/secret/secret-auto-seed.ts`](tastytrade-silver-lynx/src/strategy/secret/secret-auto-seed.ts)
- Startup config/deprecation/masking:
  [`tastytrade-silver-lynx/src/startup-config.ts`](tastytrade-silver-lynx/src/startup-config.ts)
- Current static-analysis receipt:
  [`tastytrade-silver-lynx/docs/fallow-audit-2026-07-22.md`](tastytrade-silver-lynx/docs/fallow-audit-2026-07-22.md)
- Competing current tracker:
  [`tastytrade-silver-lynx/docs/improvements/STATUS.md`](tastytrade-silver-lynx/docs/improvements/STATUS.md)
- Operations:
  [`tastytrade-silver-lynx/docs/OPERATIONS.md`](tastytrade-silver-lynx/docs/OPERATIONS.md)
- Runtime exclusion:
  [`tastytrade-silver-lynx/.gitignore`](tastytrade-silver-lynx/.gitignore)

### LawEngine

- Root routing:
  [`../LawEngine/AGENTS.md`](../LawEngine/AGENTS.md)
- Config owner rules:
  [`../LawEngine/config/AGENTS.md`](../LawEngine/config/AGENTS.md)
- Config registry/lifecycle:
  [`../LawEngine/config/README.md`](../LawEngine/config/README.md)
- Anti-drift protocol:
  [`../LawEngine/docs/canonical/AGENT_ANTI_DRIFT_PROTOCOL.md`](../LawEngine/docs/canonical/AGENT_ANTI_DRIFT_PROTOCOL.md)
- Documentation system rules:
  [`../LawEngine/docs/canonical/DOC_SYSTEM_RULES.md`](../LawEngine/docs/canonical/DOC_SYSTEM_RULES.md)

### Halsted Devices

- Root operator/routing contract:
  [`../halsted_devices/AGENTS.md`](../halsted_devices/AGENTS.md)
- Current fleet summary and visible duplication example:
  [`../halsted_devices/README.md`](../halsted_devices/README.md)
- Machine-specific bounded routing example:
  [`../halsted_devices/Halsted-AI/AGENTS.md`](../halsted_devices/Halsted-AI/AGENTS.md)
- Network secret/identity boundary:
  [`../halsted_devices/networking/AGENTS.md`](../halsted_devices/networking/AGENTS.md)

---

## Appendix B — audit verdict labels

- **Verified current:** directly inspected or run in this audit.
- **Committed receipt:** reported by a tracked historical/current audit file but
  not independently rerun.
- **Static finding:** inferred from source paths and call graphs; no live action
  performed.
- **Recommendation:** proposed future design, not a claim about current code.
- **Owner decision:** requires product/risk judgment and must not be invented by
  an agent.

The P0 read-only bypass, dependency import failure, empty agent file, IPC count,
broken-link count, runtime ignore gaps, hard-coded account identifiers, reverse
imports, duplicate signal ownership, and current worktree state were directly
verified. Fallow's complexity/cycle/duplication numbers are treated as a
committed July 22 receipt because that full audit was not rerun here.
