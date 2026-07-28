# Golden Lion Fallow and World-Class Readiness Audit

**Audit date:** 2026-07-23  
**Repository:** `tastytrade-silver-lynx`  
**Audited HEAD:** `fafdc5189303f0545160b0d7006e6e3d6a37dfdd` (`main`, exactly matching `origin/main`)  
**Fallow audit commit:** `4c9db5b4adec0dec5ddd81c9d6f13590ee961fec`  
**Mode:** Read-only investigation plus this report; no trading source code, configuration, or user-owned work was changed  
**Decision:** **NO-GO for applying the July 22 audit wholesale or promising unattended, full-size live trading tomorrow with no degradation**

---

## 1. Executive decision

Golden Lion has a stronger foundation than its Fallow letter grade implies:

- A clean, isolated Node 24 environment passes TypeScript, the production bundle, and all **51 test files / 472 tests**.
- Fresh coverage is **65.00% statements/lines, 82.47% branches, and 67.82% functions**.
- Average cyclomatic complexity is only **2.5**, p90 is **5**, maintainability averages **88.8**, and duplication is approximately **0.6%**.
- The repository contains real safety work: strict TypeScript, structured run history, read-only account support, confirmed-cancel guards, risk rails, quote-session recovery, startup configuration reporting, and an owner-only IPC socket.

The risk is concentrated in the exact code that moves money:

1. The repository does not pin its required Node 24 runtime. Its declared test command fails on this host's Node 22 before 32 of 51 test files can execute.
2. Scheduled and IPC-triggered cycles have no shared single-flight lock, so two paths can overlap, cancel each other's orders, and make decisions from overlapping snapshots.
3. The advertised graceful shutdown is broken: stopping the scheduler clears `inFlight` immediately, and a second signal handler can exit before order cancellation and streamer teardown finish.
4. All Pacific-time trading logic only warns on a wrong timezone. The current audit host is in Chicago, and neither the PM2 config nor `.env.example` sets `TZ`.
5. The July 22 audit's first prescribed mutation, `fallow fix --yes`, is demonstrably unsafe and breaks TypeScript barrel exports.
6. HEAD changed sell execution after the audit, but there is no historical replay, fill/slippage comparison, cycle-latency benchmark, or live canary evidence proving non-degradation.
7. Operator documentation promises a retired `$200` seed-order cap while current sizing can target **12–35% of account NLV**. That is a materially false risk assumption.
8. A stop-loss close can still be blocked by the morning spread gate; a checked-in test explicitly preserves a **-31%** losing-position skip.

### Final confidence rating

**35/100 confidence that the current repository can be run tomorrow with no feature or performance degradation, based on the evidence available in this checkout.**

That rating means:

- **Do not deploy the Fallow cleanup/refactor plan tonight.**
- **Do not claim unattended or full-size live readiness.**
- A supervised run of an already-known-good artifact may be reasonable only after the hard preflight gates in section 12 pass on the actual deployment host.

The hostile red-team rating for **applying the audit plan wholesale and then trading tomorrow** is lower: **15/100**.

With a clean Node 24 gate, actual-host verification, Pacific timezone enforcement, read-only broker canary, exact deployed-SHA confirmation, a single execution control path, and a tested rollback, confidence could reasonably rise to approximately **80/100**. It should not exceed 90 without deterministic old-versus-new replay and a controlled shadow/canary run.

---

## 2. How the 35/100 rating was calculated

This is a conservative non-inferiority score, not a subjective grade:

| Dimension | Weight | Current score | Weighted points | Why |
|---|---:|---:|---:|---|
| Reproducible build and unit correctness | 20% | 88 | 17.6 | Node 24 passes all local gates, but the runtime is not encoded |
| Deployment/environment truth | 15% | 20 | 3.0 | Actual PM2 host, deployed SHA, env, timezone, and account state were not inspected |
| Concurrency and shutdown safety | 20% | 20 | 4.0 | No global cycle lock; shutdown state and signal ownership are broken |
| Feature/decision parity evidence | 15% | 20 | 3.0 | No golden transcript or old-versus-new differential replay |
| Performance non-inferiority evidence | 10% | 10 | 1.0 | No cycle/API/slippage/fill benchmark; “76% fewer logs” is not a runtime benchmark |
| Trading-risk correctness | 15% | 30 | 4.5 | Useful rails exist, but stop/spread, concentration, stale-signal, and daily-loss gaps remain |
| Observability and rollback | 5% | 40 | 2.0 | Run history and notifications exist; exact release artifact and automated rollback proof do not |
| **Total** | **100%** |  | **35.1 → 35/100** | |

“No degradation” is an unusually strong claim. Passing unit tests proves sampled correctness; it does not prove identical broker-call ordering, fill quality, latency, slippage, account exposure, or scheduler behavior.

---

## 3. Scope and method

The audit followed and cross-checked:

- `docs/fallow-audit-2026-07-22.md`
- `docs/improvements/FALLOW.md`
- `README.md`
- `AGENTS.md`
- `CLAUDE.md`
- `.fallowrc.json`
- `docs/OPERATIONS.md`
- `docs/STRATEGY.v2.md`
- `docs/improvements/STATUS.md`
- the current source, tests, hooks, package metadata, PM2 configuration, and recent Git history

Three independent lanes were used:

1. **Audit lane A:** independent Fallow, build, test, coverage, dead-code, architecture, and tomorrow-readiness review.
2. **Audit lane B:** separate clean Node 24 reproduction, quantitative baseline, strict-complexity analysis, and operational review.
3. **Hostile red team:** argued against the audit, the metric, the runtime assumptions, the refactor prescription, and the no-degradation claim.

The lanes did not edit the workspace. Temporary copies under `/tmp` were used for destructive experiments such as applying Fallow fixes or removing suppression comments.

### Important limitations

This was not a live-trading validation:

- No Tastytrade order was placed, modified, or cancelled.
- No production credentials or `.env` were read.
- The actual PM2/deployment host was not inspected.
- No market-open scheduler or live quote-stream session was exercised.
- No brokerage sandbox, historical broker-event replay, or shadow execution environment is present in the repository.
- NPM advisory checks reported zero known vulnerabilities in the isolated install, but this is not a full dependency, secret, supply-chain, or application security assessment.

---

## 4. Reproducible evidence

### 4.1 Repository and runtime

| Check | Result |
|---|---|
| Branch | `main` |
| HEAD vs remote | `HEAD == origin/main == fafdc518...` |
| Pre-existing workspace changes | `M CLAUDE.md`, `?? AGENTS.md` |
| Current host Node | `v22.23.1` |
| Current host npm | `12.0.1` |
| Current host timezone | `CDT -0500` / `America/Chicago` |
| `.env` in this checkout | Absent |
| `.nvmrc`, `.node-version`, Volta, or tool-version pin | None |
| CI workflows | No `.github` directory found |
| TypeScript files | 141 |
| Test files | 51 |
| Static `test(...)` declarations | 472 |
| Raw TypeScript lines | 28,212 |

The missing `.env` is not proof that production is unconfigured; it means production configuration could not be verified from this checkout and must not be assumed.

### 4.2 Stock current-host result: Node 22

```text
npm run typecheck   PASS
npm run build       PASS
npm test            FAIL
```

Test outcome:

- 19 of 51 test-file processes pass.
- 32 fail during module loading, before their assertions run.
- Error: `@dxfeed/dxlink-api` does not provide the named export `DXLinkFeed` through the `tsx` loader path.
- Native Node can see the package exports; the failure is specific to the loader/package interoperability path.

This matters because `package.json` declares both tests and direct TypeScript startup through `tsx`, but the repository does not state or enforce the Node version under which that path is valid.

### 4.3 Clean isolated Node 24 result

Independent lane B used an isolated clean checkout and exact Node binary:

```text
/tmp/fallow-audit-lane-b.jPivq1/node24/node_modules/node-linux-x64/bin/node
v24.18.0
```

Commands:

```bash
PATH=/tmp/fallow-audit-lane-b.jPivq1/node24/node_modules/node-linux-x64/bin:$PATH npm ci
PATH=/tmp/fallow-audit-lane-b.jPivq1/node24/node_modules/node-linux-x64/bin:$PATH npm run typecheck
PATH=/tmp/fallow-audit-lane-b.jPivq1/node24/node_modules/node-linux-x64/bin:$PATH npm run build
PATH=/tmp/fallow-audit-lane-b.jPivq1/node24/node_modules/node-linux-x64/bin:$PATH npm test
PATH=/tmp/fallow-audit-lane-b.jPivq1/node24/node_modules/node-linux-x64/bin:$PATH npm run test:coverage
```

Results:

| Gate | Result |
|---|---|
| `npm ci` | Pass |
| Typecheck | Pass |
| Build | Pass |
| Test files | **51/51 pass** |
| Tests | **472**, zero failures |
| Test duration | Approximately 609 ms in the isolated environment |
| Bundle | 429.2 kB JavaScript; 937.0 kB source map |
| NPM known vulnerabilities | 0 reported |

Coverage:

| Measure | Covered / total | Percentage |
|---|---:|---:|
| Statements | 10,202 / 15,693 | **65.00%** |
| Lines | 10,202 / 15,693 | **65.00%** |
| Branches | 1,647 / 1,997 | **82.47%** |
| Functions | 428 / 631 | **67.82%** |

The clean Node 24 pass is strong evidence that the code and test corpus are substantially healthy. It is also strong evidence that Node 24 is a real runtime contract and must be encoded, not left in an operations paragraph.

### 4.4 Fresh Fallow result

With valid Node 24 coverage and Fallow 3.1.0:

| Metric | Current result |
|---|---:|
| Health grade | **C, 59.9** |
| Visible health findings | **69** |
| Critical / high / moderate | **26 / 18 / 25** |
| Files analyzed | 144 |
| Functions analyzed | 1,996 |
| Fallow LOC | 28,772 |
| Average cyclomatic | 2.5 |
| p90 cyclomatic | 5 |
| Average maintainability | 88.8 |
| Circular dependencies | 17 |
| Dead exports | 10.8% |
| High coupling | 3.6% |

Fallow score penalties:

| Source | Penalty |
|---|---:|
| Circular dependencies | 25.0 |
| Unit size | 10.0 |
| Dead exports | 2.2 |
| Coupling | 1.8 |
| Complexity | 0.8 |
| Dead files | 0.3 |

This is why the grade should not be read as “the strategy is 59.9% correct.” Most of the score damage is architecture/dead-surface count, not tested trading correctness.

---

## 5. The “below 15%” complexity goal must be corrected

The July 22 audit actually says:

> Get each function under cyclomatic 15 / cognitive 15.

Cyclomatic and cognitive complexity are point counts, not percentages. There are two possible interpretations:

### Interpretation A: fewer than 15% of functions violate

After stripping suppression comments in an isolated copy:

- 33 of 1,996 configured functions violate the strict threshold.
- Violation rate = **1.653%**.
- Compliance rate = **98.347%**.

Under a percentage interpretation, the repository already passes comfortably. That metric would hide `manageAllocationForGroup` at cyclomatic **98** and is therefore not useful as the primary safety objective.

### Interpretation B: every function is strictly below 15

This is what the audit text says and what should be implemented:

- Maximum allowed cyclomatic: **14**
- Maximum allowed cognitive: **14**
- Allowed unsuppressed violations in production: **0**

Current result:

- **17** violations are visible with current inline suppressions.
- **33** violations exist when suppression comments are removed.
- Current strict result: **FAIL**.

`.fallowrc.json` does not encode the goal. It only points to coverage and leaves `rules` empty. Fallow therefore uses its default cyclomatic maximum of 20 and cognitive maximum of 15.

Recommended configuration intent:

```json
{
  "health": {
    "coverage": "coverage/coverage-final.json",
    "maxCyclomatic": 14,
    "maxCognitive": 14,
    "suggestInlineSuppression": false
  }
}
```

Do not merge that configuration alone against the inherited debt: first create a reviewed baseline or phased exception registry so the gate blocks new debt without forcing a dangerous all-at-once rewrite.

### 5.1 Suppression truth

There are **50** `fallow-ignore` comments:

- 48 complexity suppressions
- 1 unused-type suppression
- 1 file-level circular-dependency suppression

Sixteen of the complexity suppressions hide functions that currently violate the strict `<15` cyclomatic/cognitive rule. Other suppressions cover CRAP or functions whose current structural metrics are below 15. The July 22 instruction calling all 50 “complexity comments” is incorrect.

### 5.2 Strict unsuppressed hotspots

| Priority | Function | Location | Cyclomatic | Cognitive | Function LOC |
|---:|---|---|---:|---:|---:|
| 1 | `manageAllocationForGroup` | `src/bot/actions/manage-allocation.ts:818` | **98** | **74** | 478 |
| 2 | `seedSymbol` | `src/bot/seed-symbol.ts:563` | **79** | **57** | 432 |
| 3 | `purchaseSymbol` | `src/bot/purchase-symbol.ts:46` | **51** | 16 | 201 |
| 4 | `buildPnlLedgerEntries` | `src/bot/pnl-ledger.ts:135` | **50** | **73** | 126 |
| 5 | `maybeSeedCashAccountFromMarginAccount` | `src/bot/run-cycle-seed.ts:254` | **49** | **74** | 206 |
| 6 | `buildTopOptionCandidateResult` | `src/strategy/option-candidate/selection.ts:164` | **49** | **36** | 264 |
| 7 | `closePosition` | `src/bot/actions/close-position.ts:216` | **43** | **70** | 229 |
| 8 | `evaluationsWithGroupTargets` | `src/bot/run-cycle-context.ts:437` | **37** | **32** | 213 |
| 9 | `runBotCycle` | `src/bot/run-cycle.ts:192` | **36** | **46** | 361 |
| 10 | `getClosedPositionsTodayForAccount` | `src/bot/get-closed-positions-today.ts:12` | **29** | **44** | 138 |
| 11 | `buildRunCycleContext` | `src/bot/run-cycle-context.ts:306` | **28** | **52** | 577 |
| 12 | `maybeSeedMarginAccountFromCashAccount` | `src/bot/run-cycle-seed.ts:111` | **25** | **34** | 141 |
| 13 | option-chain probe `main` | `src/tools/probe-option-chain.ts` | 23 | 9 | 96 |
| 14 | realized-P&L fill processing | `src/tools/realized-pnl.ts` | 22 | 9 | — |
| 15 | realized-P&L `main` | `src/tools/realized-pnl.ts` | 21 | 34 | — |
| 16 | `logExecutionTargetsByGroup` | `src/bot/run-cycle-logging.ts` | 21 | 32 | 99 |
| 17 | `executeOvernightReductions` | `src/bot/overnight-reduction-executor.ts` | 21 | 27 | — |
| 18 | `executePositionEvaluations` | `src/bot/execute-position-evaluations.ts` | 21 | 23 | 209 |
| 19 | run-cycle-context mapping function | `src/bot/run-cycle-context.ts` | 21 | 18 | — |
| 20 | `cancelAllLiveOrders` | `src/bot/execute-position-evaluations.ts:89` | 20 | 31 | — |
| 21 | `cashGateFailReason` | cash seed/gate path | 20 | 18 | — |
| 22 | `createPositionQuoteSnapshot` | `src/bot/evaluate-position.ts` | 20 | 11 | 56 |
| 23 | `describeFailure` | option-service path | 17 | 10 | — |
| 24 | `removeListener` | `src/core/option-service.ts` | 16 | 20 | 33 |
| 25 | `chooseOptionCandidates` | `src/bot/option-contracts.ts` | 15 | 36 | — |
| 26 | `merge` | option-service path | 15 | 27 | — |
| 27 | `computePositionGate` | `src/strategy/position-gate.ts` | 15 | 13 | — |
| 28 | session inference | `src/core/market-sessions.ts` | 15 | 10 | — |
| 29 | Greek extraction | option selection path | 15 | 9 | — |

There are additional cognitive-only violations, including an option-service `merge` and options-mirror logging path. The machine-readable Fallow JSON should become a retained CI artifact so this list is generated, not manually maintained.

### 5.3 Coverage is weakest where complexity matters most

Fresh coverage reports important orchestration functions at 0%:

- `purchaseSymbol`: CRAP approximately 2,652
- `runBotCycle`: CRAP approximately 1,332
- `executePositionEvaluations`: CRAP approximately 462
- `createPositionQuoteSnapshot`: CRAP approximately 420

`manageAllocationForGroup` has approximately 82% coverage but remains structurally extreme. This is precisely why coverage and complexity must be managed together.

### 5.4 A threshold can be gamed

Extracting five helpers can make the parent function appear “under 15” while preserving the same hidden state, mutation order, and total decision-path risk. A world-class definition of done must include:

- per-function cyclomatic/cognitive ceilings;
- no increase in module-level decision complexity;
- behavior-equivalence replay;
- explicit state-machine phases;
- pure policy functions with truth-table/property tests;
- broker-call transcript equality for no-functional-change refactors;
- mutation testing on risk and order-routing decisions.

---

## 6. The July 22 audit: what is right, wrong, and unsafe

| Audit claim/prescription | Current finding | Verdict |
|---|---|---|
| Run `fallow fix --yes`; it removes 45 exports with no logic changes | Current dry-run proposes 35 changes; isolated apply breaks typecheck with seven errors, including a secret barrel re-export | **Unsafe—do not run** |
| 69 complexity findings, 10 critical / 17 high | Fresh valid-coverage health has 69 visible findings, but severity is 26 critical / 18 high / 25 moderate | Count survives; severity is stale/mischaracterized |
| Delete 21 unused types | Some are barrel/public shapes; repository-only search cannot prove no external consumer | Manual contract review required |
| `regime-sizing-backtest.mjs` is safe to delete if inactive | `docs/regime-sizing-backtest.md` identifies it as the reproducible analysis entry point and exact command | False positive; retain or archive deliberately |
| `src/bot/index.ts` is an orphan | It is empty/orphaned | Likely safe after a final entry-point trace |
| No duplication | Config hides pairs with `minOccurrences: 3`; 120 lines remain | Misleading |
| Cycle B is fixed by moving a shared interface | The dependency is a runtime call from option-candidate to buying-power to allocation | Factually wrong |
| Remove 50 complexity suppressions | Only 48 are complexity comments | Incorrect |
| Zero functional changes | HEAD changed live sell chase after the audit commit | Audit is stale relative to current `main` |

### 6.1 Why `fallow fix --yes` is prohibited

The live tracker already says:

> `fallow fix` is UNSAFE here — it broke the build.

The independent experiment confirms it:

- Fallow proposes only 35 export-keyword removals, not 45.
- It removes `getSecretExecutionTargetForRun` from its definition while the secret barrel still re-exports it.
- Typecheck then fails with `TS2724`.
- Six additional unused-declaration errors appear.

Safe dead-surface workflow:

1. Generate one finding at a time.
2. Run `fallow dead-code --trace <file>:<symbol>`.
3. Search source, tests, scripts, docs, IPC commands, dynamic imports, barrels, and package/public entry points.
4. Classify as:
   - genuinely private;
   - redundant named/default export;
   - barrel/public contract;
   - executable/tool entry;
   - intentionally externally consumed.
5. Remove the definition export and every barrel re-export atomically.
6. Run typecheck, full tests, build, API-extractor/contract tests, and a consumer compile.
7. Commit one small family at a time.

### 6.2 Duplication truth

Configured `minOccurrences: 3` reports zero clone groups, yet statistics still show:

- 120 duplicated lines
- 0.596% duplication

At `--min-occurrences 2`:

- 4 clone groups
- 8 instances

The overall level is healthy. The meaningful risk is not the percentage; it is duplicated behavior in seed-from-cash versus seed-from-margin paths that can drift independently.

### 6.3 Circular dependency truth

Sixteen of 17 cycles include `src/core/tastytrade-client.ts`. The architectural inversion is concrete:

- Core `tastytrade-client.ts` dynamically imports market-data and option-service modules.
- It also dynamically imports the bot-layer `cancelAllLiveOrders`.
- Those feature modules already import the core client.

The audit is right that the client hub is central, but moving a type alone cannot remove runtime imports.

Cycle B is also a runtime cycle:

```text
manage-allocation
  -> option-candidate/account
  -> getEffectiveBuyingPowerSummary
  -> getCurrentAllocationBudget
  -> manage-allocation
```

World-class fix:

- Keep `tastytrade-client` as a pure SDK adapter.
- Define narrow `BrokerPort`, `MarketDataPort`, `OrderPort`, and `AccountPort` interfaces in an application/core boundary.
- Implement those ports in adapter modules.
- Compose implementations once in the application entry point.
- Inject cancellation/order services into run-cycle use cases.
- Add an architectural test preventing `core/domain -> bot/application` imports.

Do not blindly eliminate every dynamic cycle; replace the inversion with a coherent dependency direction and verify runtime initialization.

---

## 7. Release-blocking engineering findings

### P0-1: Node 24 is required but not encoded

**Evidence**

- `docs/OPERATIONS.md:78` says the app requires Node 24.
- Node 24.18.0 passes all 472 tests.
- Node 22.23.1 fails 32 test files through the declared loader path.
- There is no `engines`, `.nvmrc`, `.node-version`, `packageManager`, or startup assertion.
- PM2 uses `interpreter: process.execPath`, so the Node running the PM2 CLI determines the application runtime.

**Risk**

A developer, reboot hook, PM2 daemon, or deployment shell can silently select the wrong Node. Typecheck/build may pass while the TypeScript runtime/test path fails.

**World-class fix**

- Pin Node 24 at all layers:
  - `.nvmrc`
  - `.node-version`
  - `package.json.engines.node`
  - exact `packageManager`
  - CI image/version
  - PM2 startup environment
- Add a startup hard check for the supported major version.
- Test both `start:build` and the supported development loader.
- Prefer the bundled production artifact in PM2; never use `tsx` for production.

**Acceptance**

- Fresh clone + `npm ci` + all gates pass on the pinned version.
- Unsupported Node exits before broker authentication with a clear message.
- Rebooted PM2 reports the expected Node binary and version.

### P0-2: Timezone is fail-open

**Evidence**

- Strategy documentation requires `America/Los_Angeles`.
- Schedule calculations use local `Date.getHours()` / `getMinutes()`.
- `startup-config.ts` only logs a warning.
- `ecosystem.config.cjs` and `.env.example` do not set `TZ`.
- The audit host is `America/Chicago`, a two-hour difference in July.

**Risk**

If the production host inherits Chicago time, entry windows, exposure ramps, cooldowns, EOD arming, and liquidation cutoffs shift by two hours. A warning is inadequate for a money-moving scheduler.

**World-class fix**

- Set `TZ=America/Los_Angeles` in the deployed process environment.
- Fail startup in live/scheduled mode if the resolved timezone differs.
- Better: use explicit zoned time conversion for policy decisions and use the broker's session calendar for open/closed state.
- Pass a `Clock` into time-sensitive policies for deterministic DST and boundary tests.

**Acceptance**

- Automated tests cover DST transitions, half-days, holidays, 06:30, 12:50, and 13:00 PT boundaries.
- Scheduled/live mode cannot start with a mismatched timezone.

### P0-3: No global single-flight coordinator

**Evidence**

- The scheduler only checks `schedulerState.inFlight`.
- IPC `bot:runCycle` directly calls `runBotCycle`.
- The IPC server handles multiple sockets/requests.
- `runBotCycle` has no process-wide lock or idempotency key.

**Risk**

A manual IPC cycle can overlap a scheduled cycle. Two executions may:

- both cancel live orders;
- evaluate overlapping account snapshots;
- compute the same headroom;
- place duplicate or conflicting orders;
- race registry and NDJSON writes;
- misreport budget and fill state.

This is a direct financial correctness risk, not style debt.

**World-class fix**

- Introduce a single `RunCycleCoordinator`.
- Every money-touching entry point—scheduler, IPC, secret auto-seed, and future API—must submit through it.
- Support:
  - one global/account-scoped active execution;
  - explicit queue/reject/coalesce semantics;
  - run ID and idempotency key;
  - active promise/status;
  - structured start/finish/failure events;
  - shutdown drain;
  - per-account order-intent deduplication.

**Acceptance**

- A concurrency test starts scheduler and IPC simultaneously and proves only one broker order transcript occurs.
- Duplicate request IDs return the original result.
- No order can be replaced until prior cancellation is confirmed.

### P0-4: Graceful shutdown is not graceful

**Evidence**

- `src/index.ts:23-31` stops the scheduler and then polls `inFlight`.
- `src/bot/market-open-scheduler.ts:145-149` immediately assigns `inFlight = false`.
- The wait therefore cannot observe the actual active cycle.
- `src/ipc-server.ts:302-308` registers separate signal handlers and calls `process.exit(0)`.
- `src/index.ts:55-56` registers another pair of handlers.

**Risk**

The process can exit while a cycle is active, before order cancellation, quote-stream teardown, or persistence finishes. README's 30-second completion guarantee is false.

**World-class fix**

- One shutdown owner only.
- Scheduler stop means “reject new work,” not “pretend work completed.”
- Retain and await the active execution promise.
- Shutdown phases:
  1. mark draining;
  2. stop accepting money commands;
  3. stop future scheduler ticks;
  4. await/cancel active cycle with deadline;
  5. reconcile/cancel known working orders;
  6. flush state/telemetry;
  7. close IPC and quote streams;
  8. exit once.
- Make shutdown idempotent across repeated signals.

**Acceptance**

- Test sends SIGTERM mid-cycle and proves no new order follows the signal, active work is accounted for, working orders are cancelled/reconciled, the socket is removed, and exit occurs after teardown.

### P0-5: Quality gates fail open and there is no CI

**Evidence**

- No `.github` workflow exists.
- Pre-commit exits successfully when Fallow is unavailable.
- Coverage regeneration is explicitly best effort.
- If tests fail, Fallow audits existing or partial coverage.
- The gate is “new-only” and can be bypassed.
- The failed Node 22 coverage run produced only partial coverage and materially different Fallow findings.

**Risk**

A developer can see a passing static gate backed by stale/partial coverage. Local hooks are useful ergonomics; they are not a release control.

**World-class fix**

- Add fail-closed CI for:
  - clean install;
  - runtime version assertion;
  - format/lint;
  - typecheck;
  - all tests;
  - coverage;
  - production build/startup smoke;
  - Fallow strict-new-debt gate;
  - architecture boundaries;
  - dependency/license/advisory checks.
- Write coverage into a temporary directory and atomically promote it only after all tests pass.
- Upload raw coverage, Fallow JSON, bundle metadata, and test results as artifacts.
- Require CI on protected `main`.

**Acceptance**

- A failed test cannot produce a reusable “fresh” coverage file.
- Branch protection prevents merging when any required gate fails.

### P0-6: Current HEAD has unproven execution changes

The audit commit is not current HEAD. Commit `fafdc51` followed it and changed 11 files:

```text
318 insertions, 61 deletions
perf(logs)+feat(exec): GL log cleanup (~76% fewer lines) + start-high sell chase
```

For sell-to-close:

- Non-urgent chasing now starts at the ask and walks toward the bid.
- At ten 30-second waits, it can take roughly five minutes to exhaust the path.
- It reaches the midpoint only around halfway through a symmetric path.
- Urgent chasing uses ten-second waits and can take roughly 100 seconds.

The unit test validates a non-urgent sample price sequence. There is no equally explicit end-to-end urgent sequence, partial-fill, broker-latency, slippage, or EOD-deadline replay proving the new behavior is non-inferior.

The “76% fewer lines” claim is a log-volume estimate, not proof of lower CPU, event-loop delay, broker calls, or improved fill performance. Reducing successful-action detail may also reduce incident forensics.

**Fix and acceptance**

- Retain structured metrics even when reducing verbose logs.
- Replay old and new versions against identical recorded quote/order/fill events.
- Compare:
  - fill rate;
  - time-to-fill;
  - slippage versus midpoint and NBBO;
  - cancellations/replacements;
  - unfilled positions;
  - EOD flatten completion;
  - API calls;
  - cycle p50/p95/p99;
  - event-loop delay and memory.
- Define a rollback tag before enabling the scheduler.

---

## 8. Trading and risk-control findings

### 8.1 A “hard” stop can be blocked by the spread gate

`closePosition` evaluates the morning spread gate before using `isUrgentClose` to control chase behavior. It bypasses the gate for EOD and high take-profit closes, but not for an ordinary intraday stop.

A checked-in test preserves this production-shaped case:

```text
fill 0.61
bid 0.42
ask 0.56
bid return -31%
spread 28.57%
time 07:46
expected result: skip close
```

That means the documented -30% intraday hard stop is not actually hard.

There is a legitimate tradeoff: crossing a very wide spread can realize a poor price. The correct design is not to silently skip risk liquidation.

Recommended policy:

- `HARD_RISK_CLOSE` bypasses the ordinary spread block.
- Attempt staged marketable-limit execution with a strict deadline.
- Alert immediately when a hard-risk close encounters abnormal liquidity.
- Continue reconciling until the broker confirms fill/cancel.
- Record “risk trigger,” “liquidity condition,” “attempted prices,” and “residual quantity” separately.
- For truly untradeable contracts, move to an explicit `STUCK_RISK_POSITION` state with operator escalation.

### 8.2 Operator documentation materially understates seed risk

README says:

```text
BOT_MAX_SEED_ORDER_COST defaults to $200
```

Current code says that control was retired. `.env.example` configures:

- seed target floor: **12% NLV**
- seed target ceiling: **35% NLV**
- per-underlying account cap: **60%**
- combined cash+margin cap: **70%**
- total margin option utilization: **1.5x NLV**

README also advertises retired daytrade-score gates and a retired notional cap. `docs/STRATEGY.v2.md` says it is current as of July 14, but seed sizing changed July 21.

This is a release blocker because an operator following README may believe an absolute dollar loss rail exists when it does not.

### 8.3 Sizing configuration fails open in several places

Observed behaviors:

- Invalid/missing favorability input resolves to `1.0`, the maximum/ceiling target.
- `readEnvFraction` interprets `150` as `1.5`; it does not cap percentage-of-account fields at 100%.
- If floor exceeds ceiling, `Math.max(rawCeiling, floor)` raises the effective ceiling to the floor despite the comment describing the ceiling as a hard upper bound.
- The min-one rule can place one contract even when the model cannot fit one within target notional, unless a separate hard rail blocks it.
- Concentration caps are off in code when env values are absent, although `.env.example` enables them.
- Open-interest gating defaults off.
- Phantom-quote protection defaults off.
- Unknown liquidity fields pass.

Some fail-open choices intentionally prevent a data-shape change from stopping all trading. For live risk, they need explicit mode-dependent semantics:

- **Data availability failure:** do not silently turn uncertainty into maximum size.
- **Configuration failure:** fail startup.
- **Optional alpha signal absence:** neutral may be acceptable only inside a lower safe size.
- **Risk-control data absence:** fail closed or enter read-only/reduced-risk mode.

### 8.4 Missing portfolio-level risk controls

The improvement tracker says several controls remain open; because that tracker was last reconciled earlier in July, each should be revalidated against current code before implementation:

- account-level daily-loss circuit breaker;
- cost-basis rather than decayed market-value exposure accounting;
- stale secret-signal execution gate;
- confirmed-fill registry mutation;
- fee-aware targets and minimum-premium floor;
- portfolio Greeks and scenario stress;
- side-aware handling for puts versus calls;
- cross-process/auto-seed registry serialization.

Recommended hard portfolio limits:

- max daily realized + unrealized loss;
- max gross option premium at risk;
- max exposure by underlying, sector, direction, expiry, and account pair;
- max delta/gamma/vega/theta and defined stress scenarios;
- max contracts and max dollars per order;
- max concurrent working orders;
- max stale quote/signal age;
- max broker/API error rate;
- mandatory close-only mode after any invariant breach.

All limits should be versioned, typed, validated at startup, logged as resolved values, and enforced from one central risk service.

### 8.5 The strategy evidence is promising but not options-alpha proof

The regime-sizing analysis is thoughtful and reproducible, but its own limitations are important:

- 2,885 joined buys out of 17,369 total;
- a two-week window;
- source trades are from a stock bot, used as a proxy for option seeds;
- newer `regimeMult`/market fields have only 172 rows;
- survivorship and day-clustering are material;
- the apparent effect is mostly cross-day pacing, not per-name prediction;
- it does not model option convexity, implied-volatility changes, spread, fees, or fill probability.

The result supports a hypothesis: regime may be useful for a **daily deployment budget**. It does not justify scaling individual option positions aggressively without direct option-level out-of-sample evidence.

### 8.6 World-class research protocol

For each strategy change:

1. Write the hypothesis, mechanism, primary metric, risk metric, and rejection criterion before looking at results.
2. Use direct options event/order/fill data when the intervention trades options.
3. Split data chronologically; use walk-forward evaluation and purged/embargoed validation where labels overlap.
4. Cluster bootstrap confidence intervals by trading day and underlying.
5. Model commissions, exchange fees, bid/ask spread, partial fills, cancel latency, and market impact.
6. Report:
   - mean/median return;
   - win rate;
   - drawdown;
   - expected shortfall/CVaR;
   - turnover;
   - exposure time;
   - slippage;
   - fill rate;
   - tail loss;
   - result by liquidity/regime/account/DTE bucket.
7. Correct for multiple testing and show sensitivity to reasonable parameter changes.
8. Run shadow mode, then a capped canary, before normal size.
9. Require post-trade reconciliation against broker truth.

No single market day can statistically establish “no performance degradation.” Tomorrow can validate operational correctness, not trading alpha.

---

## 9. Target architecture

The desired architecture is a deterministic trading state machine around narrow adapters:

```text
Scheduler / IPC / signal feed
            |
            v
   RunCycleCoordinator
   - single flight
   - run ID/idempotency
   - shutdown drain
            |
            v
   Build immutable snapshot
            |
            v
   Pure policy pipeline
   - session/time policy
   - risk policy
   - close policy
   - allocation policy
   - seed policy
            |
            v
   Order-intent plan
            |
            v
   Central RiskGuard
            |
            v
   Execution state machine
   - submit
   - observe
   - cancel-confirm
   - replace
   - reconcile
            |
            v
   BrokerPort / MarketDataPort
            |
            v
   Append-only events + projections
```

### Design rules

- Domain/policy code cannot import the broker SDK, filesystem, wall clock, PM2, IPC, or bot application modules.
- All time comes from an injected `Clock`.
- Money, percentages, quantities, prices, and account IDs use validated value objects/types.
- Policies return explicit actions such as:
  - `HOLD`
  - `MANAGE_ALLOCATION`
  - `TAKE_PROFIT_CLOSE`
  - `HARD_RISK_CLOSE`
  - `EOD_LIQUIDATE`
  - `DO_NOT_TOUCH`
  - `STUCK_RISK_POSITION`
- `DO_NOT_TOUCH` must be an unexecutable action, not a reason-string prefix later filtered by one executor.
- All money-touching commands pass through the same coordinator and risk guard.
- Persistence is append-only first; projections/registries are rebuilt or reconciled from broker truth.
- Every broker command carries a run ID, intent ID, account, symbol, side, quantity, limit, source, and idempotency key.
- Every state transition is observable and replayable.

### Configuration design

Keep secrets in environment/secret storage. Move non-secret strategy defaults into a versioned, schema-validated configuration layer:

```yaml
schemaVersion: 1

runtime:
  nodeMajor: 24
  timezone: America/Los_Angeles
  mode: live

execution:
  maxConcurrentCycles: 1
  shutdownDeadlineMs: 30000
  requireCancelConfirmation: true

risk:
  maxDailyLossPct: null       # must be intentionally resolved for live
  maxOrderPctNlv: null
  maxUnderlyingPctNlv: null
  maxCombinedUnderlyingPctNlv: null
  maxMarginUtilization: null
  maxQuoteAgeMs: null
  maxSignalAgeMs: null

quality:
  maxCyclomatic: 14
  maxCognitive: 14
  minGlobalLineCoveragePct: 85
  minCriticalBranchCoveragePct: 95
```

Live mode should reject `null`, inconsistent, out-of-range, or obsolete risk settings. Version the resolved configuration fingerprint into every run-history entry.

---

## 10. Safe Fallow remediation program

Do not optimize for the letter grade first. Optimize for money-moving risk, testability, and architectural direction.

### Wave 0: establish trustworthy measurement

- Pin Node/npm.
- Make coverage fail closed and atomic.
- Store raw Fallow JSON with commit SHA, tool version, thresholds, entry set, and coverage completeness.
- Encode max cyclomatic/cognitive 14.
- Split production, test, tool, and research profiles so a probe script does not obscure trading-runtime risk.
- Replace ad hoc inline suppressions with a reviewed exception registry containing:
  - file/function;
  - metric;
  - rationale;
  - owner;
  - issue;
  - expiry/review date.

### Wave 1: freeze behavior

Before refactoring:

- capture representative run-history inputs;
- add deterministic clock and broker fakes;
- snapshot decision plans and broker-call transcripts;
- add characterization tests for error/fallback/empty/partial-fill paths;
- add single-flight and shutdown tests;
- define performance baseline.

### Wave 2: fix architecture and operational safety

1. `RunCycleCoordinator`
2. coordinated shutdown
3. broker/application ports
4. typed/versioned config
5. central risk guard
6. append-only intent/fill reconciliation

These changes reduce both real risk and cycle counts.

### Wave 3: refactor hotspots one seam at a time

Recommended order:

1. `runBotCycle` / `buildRunCycleContext` into explicit phases
2. `manageAllocationForGroup`
3. `seedSymbol` and cross-account seed paths
4. `closePosition` execution state machine
5. option candidate selection pipeline
6. P&L ledger transformation
7. tools/research scripts

For each pull request:

- one behavioral seam;
- old/new differential replay;
- zero broker-transcript differences for “no logic change” work;
- strict complexity for new/modified functions;
- property tests for pure math;
- mutation tests for risk gates;
- no latency/API-call regression beyond the declared budget;
- an independent reviewer signs the equivalence artifact.

### Wave 4: dead surface and cycles

- Remove dead exports manually in small contract families.
- Compile at least one external/IPC consumer.
- Retain the regime backtest as a research artifact or move it to a clearly configured `research/` entry set with input manifest.
- Remove `src/bot/index.ts` only after entry-point trace.
- Break cycles through ports/composition, not type shuffling that leaves runtime inversion intact.

---

## 11. Performance and non-degradation gates

The repository currently has no quantified performance baseline. Establish one before claiming improvement.

### Required service-level indicators

- cycle wall time p50/p95/p99;
- event-loop delay p95/p99;
- RSS/heap high-water mark;
- broker calls per cycle/account/symbol;
- quote age at decision;
- signal age at decision;
- submit acknowledgement latency;
- cancel-confirm latency;
- replacements per order;
- fill rate;
- partial-fill rate;
- slippage versus midpoint and bid/ask at intent time;
- EOD flatten completion time;
- duplicate-order count;
- scheduler drift/missed cycles;
- run-history/ledger reconciliation lag;
- error and restart rate.

### Initial non-inferiority guardrails

These are proposed engineering guardrails and should be ratified from a measured baseline:

- decision and broker-intent transcript equality: **100%** for stated no-functional-change refactors;
- duplicate live intents: **0**;
- risk-cap violations: **0**;
- unaccounted broker fills: **0** after reconciliation deadline;
- margin EOD flatten success: **100%**;
- p95 cycle time regression: no more than **5%**;
- p99 cycle time regression: no more than **10%**;
- broker API-call regression: **0%** unless explicitly justified;
- critical risk/order branch coverage: at least **95%**, with 100% coverage of named invariants;
- global line coverage staged from 65% toward **85%+**;
- global function coverage staged from 67.82% toward **85%+**;
- mutation survival on critical risk policies: target below **10%**.

Fill/slippage thresholds must use confidence intervals and matched market conditions; do not impose an arbitrary absolute price threshold without baseline data.

---

## 12. Tomorrow runbook: hard go/no-go gates

### 12.1 What not to do tonight

- Do not run `fallow fix --yes`.
- Do not delete the listed types/files in bulk.
- Do not remove suppressions in bulk.
- Do not merge broad complexity refactors.
- Do not change strategy thresholds to “make tomorrow safer” without replay.
- Do not use Node 22.
- Do not start PM2 from a shell whose `node -v` is not the validated Node 24 version.

### 12.2 Required preflight on the actual deployment host

Every item must be evidenced, not assumed:

- [ ] Exact deployed SHA recorded and equal to the intended release artifact.
- [ ] Working tree clean and build generated from that SHA.
- [ ] Node is validated Node 24; npm/package lock match the release.
- [ ] `npm ci`, typecheck, all 472 tests, fresh coverage, Fallow, and build pass.
- [ ] Production process runs the bundled build, not `tsx`.
- [ ] Resolved timezone is `America/Los_Angeles`.
- [ ] Required credentials exist and obsolete variables are absent.
- [ ] Resolved risk configuration is reviewed against README and `.env.example`.
- [ ] Broker authentication, account discovery, session status, and quote freshness pass read-only smoke.
- [ ] Secret feed authentication/status is healthy if signals are required.
- [ ] Existing positions and live orders match operator expectations.
- [ ] Margin is flat before enabling scheduled trading unless a deliberate opening position is documented.
- [ ] Only one process instance exists.
- [ ] No manual `bot:runCycle` will be invoked while the scheduler can run.
- [ ] PM2 restart count and prior error logs are reviewed.
- [ ] Rollback artifact/commit and exact restart command are ready.
- [ ] Operator coverage is scheduled from before open through margin EOD flatten.

### 12.3 Canary sequence

1. Start scheduler off with all managed accounts read-only.
2. Verify startup config, timezone, Node version, broker auth, quote stream, and IPC.
3. Run `getRunCyclePreview` / `runCycleLogOnly`; reconcile decisions against positions manually.
4. Confirm no money-touching command can overlap.
5. If live authorization is granted, enable one allowlisted account at deliberately capped size.
6. Supervise the first complete cycle and verify every order in broker truth, run history, and logs.
7. Stop on the first unexplained mismatch, duplicate intent, stale quote/signal, scheduler drift, or cancellation anomaly.
8. Expand only after the canary closes/reconciles cleanly.

### 12.4 Hard no-go conditions

Any one is sufficient to stop:

- Node is not the validated Node 24 build.
- Timezone is not Pacific.
- Deployed SHA is unknown.
- Full tests/coverage/build are not green from a clean install.
- Broker or feed health is uncertain.
- Existing orders/positions cannot be reconciled.
- More than one scheduler/process can trade.
- An IPC/manual cycle might overlap the scheduler.
- The rollback path is untested.
- The operator cannot supervise the risk window.

---

## 13. Prioritized roadmap

### P0 — before any confidence claim (today/tomorrow)

| Item | Outcome |
|---|---|
| Freeze audit refactors | Avoid unbounded pre-market regression |
| Pin and assert Node 24 | Reproducible test/runtime contract |
| Verify and enforce Pacific timezone | Correct schedule semantics |
| Verify actual deployed SHA/env/PM2/account state | Replace assumptions with host truth |
| Read-only premarket canary | Validate live integration without orders |
| One operational execution path | Avoid scheduler/IPC overlap |
| Correct README risk controls | Prevent operator misconfiguration |
| Rollback artifact and supervision | Contain first-session failure |

### P1 — next 1–3 engineering days

| Item | Outcome |
|---|---|
| Global `RunCycleCoordinator` | Single-flight/idempotent money actions |
| One shutdown controller | Truthful drain/cancel/teardown |
| Fail-closed CI and atomic coverage | Trustworthy release gate |
| Runtime/config schema validation | Fail fast on unsafe settings |
| Urgent-close spread policy | Make hard risk actually hard |
| Explicit urgent chase tests | Protect EOD/stop execution |
| Docs generated from config schema | Remove risk-control drift |

### P2 — next 1–2 weeks

| Item | Outcome |
|---|---|
| Deterministic broker/clock replay harness | Prove behavioral equivalence |
| Central broker ports/composition root | Collapse circular architecture |
| Refactor top orchestration hotspots | Reach strict `<15` safely |
| Confirmed-fill reconciliation | Broker truth over placement assumptions |
| Critical-path mutation/property tests | Test invariants, not examples only |
| Performance telemetry/SLOs | Quantify non-degradation |

### P3 — next 2–6 weeks

| Item | Outcome |
|---|---|
| Portfolio risk engine | Daily loss, Greeks, concentration, stress |
| Direct options research dataset | Replace stock-proxy inference |
| Walk-forward/shadow/canary framework | Evidence-based strategy releases |
| Event-sourced intent/order/fill ledger | Replayable audit and recovery |
| Automated release manifest | SHA, config fingerprint, tools, metrics, rollback |

---

## 14. What is already good

A fair audit should preserve strengths:

- Clean Node 24 execution proves the codebase is not fundamentally broken.
- 472 tests are a meaningful corpus.
- Branch coverage above 82% is a useful starting point.
- Average complexity and maintainability are healthy; debt is concentrated rather than pervasive.
- Duplication is quantitatively low.
- TypeScript is strict and typecheck passes.
- Cancel-confirm-before-replace logic addresses a real double-order hazard.
- Quote-stream session ownership/recovery shows good incident learning.
- IPC socket permissions are tightened to owner-only.
- Startup config masking and obsolete-variable warnings are thoughtful.
- Run history, P&L ledger, day reports, notifications, and position reconciliation create a valuable observability base.
- The strategy documentation explains mechanics and historical rationale better than most small trading systems.
- The regime research acknowledges survivorship and thin-sample limitations instead of hiding them.

The path to world-class is not a rewrite. It is to concentrate engineering discipline on coordination, configuration, risk state, broker truth, reproducibility, and release evidence.

---

## 15. Red-team objections that remain open

The strongest argument against proceeding is:

> The repository can pass hundreds of deterministic unit tests while still placing a duplicate order, exiting before cancellation completes, using the wrong wall clock, or degrading fills. Those failure modes live above the unit-tested functions.

Other unresolved objections:

- A per-function complexity target can be satisfied cosmetically.
- A test suite that requires an undocumented runtime is not reproducible.
- A local hook that audits stale coverage is not a gate.
- An audit that begins with a known build-breaking auto-fix is not safe to execute.
- “No functional change” cannot be established without decision/order transcript comparison.
- “No performance degradation” cannot be established without latency/fill/slippage data.
- The repo's authoritative docs disagree about actual risk controls.
- The highest-impact strategy evidence is indirect stock-proxy data, not direct options executions.

### Evidence that would change the verdict

The red team would materially raise confidence after seeing:

1. exact production SHA, runtime, timezone, env fingerprint, and process roster;
2. clean Node 24 CI with all tests and complete fresh coverage;
3. passing scheduler/IPC overlap and SIGTERM-mid-cycle tests;
4. deterministic old/new replay with identical decision and broker-intent transcripts;
5. live read-only broker/feed smoke;
6. capped shadow/canary results with fill, slippage, API-call, cycle-latency, and reconciliation metrics;
7. demonstrated rollback;
8. corrected operator documentation and startup-enforced risk invariants.

---

## 16. Final verdict

### Can the code compile and pass its test corpus?

**Yes, on Node 24.18.0:** typecheck, build, and all 51 files / 472 tests pass.

### Is the July 22 Fallow audit safe to follow literally?

**No.** Its automated cleanup breaks typecheck, its cycle-B prescription is factually incomplete, it hides pair duplication, its suppression count is mislabeled, and it predates a behavior-changing execution commit.

### Is the strict complexity goal met?

**No.** Thirty-three functions violate the zero-exception `<15` cyclomatic and cognitive goal when suppressions are removed. The repository passes only if “15%” is incorrectly interpreted as a percentage of functions.

### Can we confidently promise no feature or performance degradation tomorrow?

**No. Current confidence: 35/100.**

### Best decision

Freeze refactors. Validate the exact current artifact on the real Node 24/Pacific deployment host. Run a read-only premarket canary. Permit only one supervised, allowlisted execution path with a rollback ready. Fix single-flight, shutdown, runtime/config enforcement, and fail-closed CI before claiming unattended production readiness.

