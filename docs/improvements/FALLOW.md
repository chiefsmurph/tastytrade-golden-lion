# Fallow — state, findings, and backlog

**This is the live tracker for [fallow](https://fallow.tools) static-analysis findings.** It answers "where did we leave off" so "let's address fallow findings" resumes here. Last updated 2026-07-05.

Fallow is deterministic (no AI). It measures four things: dead code, circular dependencies, complexity/CRAP, and duplication. Treat it as a **prompt for judgment, not an oracle** — see Gotchas below.

## How it's wired

- **Dev dependency** `fallow` (v3.1.0). Config: [.fallowrc.json](../../.fallowrc.json) — entry points (tools, tests, ipc-client, ecosystem), `health.coverage` → `coverage/coverage-final.json`, `duplicates.minOccurrences: 3`.
- **Gate**: blocks `git commit`/`git push` on **newly-introduced** findings (attribution gate = "new-only"; inherited findings on touched files do NOT block).
  - Claude Code path: `.claude/settings.json` → `.claude/hooks/fallow-coverage.sh` (regenerates coverage) then `.claude/hooks/fallow-gate.sh` (audits).
  - Terminal path: `.githooks/pre-commit` (tracked; `core.hooksPath` set by the package.json `prepare` script). Bypass once with `git commit --no-verify` — note this only skips the git hook, NOT the Claude Code PreToolUse hook.
- **Commands**: `npm run fallow` (audit) · `fallow:health` · `fallow:dead` · `fallow:fix` (dry-run only — unsafe to apply here) · `test:coverage` (regenerates Istanbul coverage). Raw: `npx fallow health|dead-code|dupes|audit`.

## Current state (2026-07-05)

Grade **D (43.2)**. Vital signs: `dead_export_pct 16.9%`, `circular_dep 20`, `maintainability_avg 87.3`, `avg_cyclomatic 2.9`. Tests: 171.

## Gotchas (the non-obvious stuff — read before acting)

1. **The letter grade is finding-COUNT driven, not CRAP magnitude.** Proven: covering `manageAllocationForGroup` cut its CRAP 4556→126 and the grade did not move. A function with cyclomatic > 20 stays a finding no matter how well covered. So "get to A" requires *clearing* findings (CC-reduction refactors, dead-export removal, the circular hub) — the riskier work. Coverage is still real risk-reduction; just don't expect the grade to reward it.
2. **Editing `manage-allocation.ts` false-flags pre-existing complexity as "introduced."** fallow's attribution is line-sensitive; shifting a function's line number can re-attribute an unchanged finding as new and block the gate. Worked around `placeRouteOrders` by refactoring it; `manageAllocationForGroup` stays a finding, so this can recur.
3. **`fallow fix` is UNSAFE here — it broke the build.** It removed exports used via barrel re-exports (`~/strategy/secret`, etc.). Keep `fallow:fix` as dry-run/preview only. `npx fallow dead-code --trace <file>:<export>` before deleting anything.
4. **Coverage must be fresh.** CRAP uses `coverage/coverage-final.json` (gitignored). The commit hooks auto-regenerate it; if running audits by hand, run `npm run test:coverage` first.
5. **Duplication defaults hide pairs.** `duplicates.minOccurrences: 3` means `fallow dupes` reports "clean" while pair-duplicates exist. Use `--min-occurrences 2` to see them.

## ✅ Done (this session, committed)

- **Fallow gate + coverage pipeline stood up** — `4ac4716`, `48328de`, `d921071`, `a0973c5`.
- **seedSymbol**: 81→39 cyclomatic via base-object dedup + phase-helper extraction, helpers unit-tested — `cc2e7f0`, `48328de`.
- **placeRouteOrders**: cognitive 31→9 (extracted `chaseRouteOrderFill` + `buildBuyToOpenOrder`), covered — cleared — `205539d`.
- **Circular deps**: 2 type-only imports → `import type` (`19bed5e`); `group-execution-targets ↔ secret` real value cycle broken (`229611e`).
- **Unused code**: `noUnusedLocals` enabled + 9 unused imports/locals removed — `205539d`.
- **manageAllocationForGroup**: base-result dedup + injectable deps seam + 8 characterization tests → CRAP 4556→126, coverage 0→78% (safety net) — `056e1e8`, `1f8642b`. NOTE: still cyclomatic 72 (a finding); coverage does not clear that.

## 🔴 Open backlog (prioritized, with plans)

### 1. `manageAllocationForGroup` cyclomatic-clear (biggest, has a safety net)
Still CC 72 / cog 52 (a critical finding). It now has **78% characterization coverage**, so a refactor is safe. Plan:
- **First add a clock-injection seam.** The affordability-retry block calls `getHeldContractFallbackCandidate(evaluation, accountType)` with **no time arg**, so it uses wall-clock `new Date()`. A robust test of that path needs an injectable clock (otherwise the test is date-fragile).
- Then extract 3–4 sub-blocks (budget/exposure math [pure], available-capital sizing [pure], the two held-contract fallback blocks [async]) and test each. Each extracted branchy helper needs its own coverage or the gate flags it (new CRAP finding).
- Target: main function CC < 20 to clear the finding.

### 2. Dead exports — `dead_export_pct 16.9%` (biggest grade lever, but delicate)
~50 unused exports. **`fallow fix` cannot be trusted** (breaks barrels). Must be done by hand: `fallow dead-code --trace <file>:<export>` each, remove the export AND any barrel re-export together, verify typecheck + tests. Many are default-vs-named export mismatches (the named export is unused because consumers import the default).

### 3. Other 0%-coverage hotspots (risk reduction; won't clear CC findings)
`purchaseSymbol` (CC51, CRAP2652), `maybeSeedCashAccountFromMarginAccount` (CC49/cog74, CRAP2450), `seedSymbol` orchestration (CC39, CRAP1560), `runBotCycle` (CC29), `buildTopOptionCandidateResult` (CC28). Same deps-seam + characterization-test pattern as manageAllocationForGroup. Compare: `closePosition` (CC42) and `buildPnlLedgerEntries` (CC41) already have low CRAP because they're 85–100% covered.

### 4. Duplication — 112 lines (0.8%, healthy overall)
Only worth touching: **`run-cycle-seed.ts` clone family** (2 groups, 35 lines: `145-163 ↔ 281-299` and `166-181 ↔ 316-325`) — the seed-from-cash vs seed-from-margin paths have copy-pasted blocks that could silently drift. Also a cross-file pair `run-cycle-context.ts ↔ run-history.ts` (17 lines) and a small `position-gate.ts` pair (7 lines).

### 5. Circular deps — 20 (mostly benign; the ceiling)
~16–18 route through the `tastytrade-client` lazy `await import()` hub — benign (dynamic imports deliberately avoid load-order cycles) but counted. Clearing them needs an architectural change to the client (not worth it). 1 real value cycle deliberately left: `manage-allocation ↔ option-candidate ↔ effective-buying-power` (runtime-benign static cycle; the clean fix adds 5 new benign hub cycles). Detail in the memory note / this repo's history.
