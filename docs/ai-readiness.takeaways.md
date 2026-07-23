# AI-Readiness Takeaways — our working checklist

Synthesis of the two same-prompt reviews — `ai-readiness.codex.md` (Codex) and
`ai-readiness.claude.md` (Claude) — **filtered through the actual code.** This is
the decision doc: what we believe, what we'll do, what we're skipping. When it
disagrees with either source doc, this one wins.

**Method.** Every finding below was checked against code at the current `main`.
Status tags:
- **CONFIRMED** — verified true against the cited `file:line`.
- **FALSE** — claimed by a source doc, debunked here (kept so nobody re-raises it).
- **NEEDS-TRACE** — plausible and specific, not yet verified end-to-end.
- **OPINION** — a design preference, not a defect.

---

## 1. The headline call

Both docs are worth mining; **neither should be adopted wholesale.**

- **Claude doc** — tight (331 lines), documentation/governance focused. Every
  concrete claim checked was true. Take its safety-doc corrections nearly as-is.
  It does not touch code architecture, so it won't move the fallow/complexity goal.
- **Codex doc** — deep (2244 lines), engineering focused. Contains the single most
  valuable finding (read-only gap) plus other real correctness leads — **but** one
  of its P0s is a phantom (see 3.x FALSE), so nothing from it ships unverified, and
  the bulk of it (ports/adapters ×78, control planes, capability registry, promotion
  ledger) is enterprise architecture over-scoped for a ~28k-LOC solo bot. **Harvest
  its findings; decline its rebuild.**

---

## 2. Do-now, real-money risk (ranked)

### 2.1 Read-only account guard is bypassable — **CONFIRMED (traced, exploitable)**
Source: Codex 6.1. `isReadOnlyAccount()` (`core/default-account.ts:26`) is called in
**exactly three files, all run-cycle paths** (`execute-position-evaluations.ts`,
`run-cycle-seed.ts`, `run-cycle-context.ts`). It is **not** enforced anywhere else on
the way to the broker. Full trace:
- **Order chokepoint has no guard.** `tastytrade-order-service.ts` `createOrder` /
  `replaceOrder` are thin wrappers over the raw broker service — no read-only check.
- **Manual IPC bypasses it.** `ipc-server.ts:121-142` dispatches `bot:seedSymbol`,
  `bot:purchaseSymbol`, `bot:closePosition` straight into `seed-symbol.ts` /
  `purchase-symbol.ts` / `close-symbol-position.ts` — none of which reference read-only.
  `bot:seedSymbol` even **defaults to the margin account** when none is passed.
- **Automated seeding bypasses it too.** `strategy/secret/secret-auto-seed.ts:1` imports
  `seedSymbol` directly and picks the account by number — so the *unattended* auto-seed
  path can trade a read-only account with no human in the loop.

**Concrete danger:** the dev `.env` marks the cash account read-only precisely so local
work can't trade it (see project memory). But a developer running `bot:purchaseSymbol` /
`bot:closePosition` against that account — trusting the read-only marking — **would place
a real order.** The marking gives false confidence on exactly the paths a human uses by
hand. In prod, severity depends on whether `BOT_READ_ONLY_ACCOUNTS` is populated.
**Fix:** enforce read-only at the lowest mandatory boundary (the order service /
`createOrder`+`replaceOrder`), not per-caller — one check that every path must cross.

### 2.2 README sells retired safety caps as live — **CONFIRMED**
Source: Claude 1.3. `README.md:112` documents `BOT_MAX_SEED_ORDER_COST` as a live
per-seed dollar cap ("defaults to 200"); `.env.example:41` says it was retired
2026-07-21 and sizing is now %-of-NLV. `README.md:154` documents
`STRATEGY_MAX_UNDERLYING_NOTIONAL` as an active ceiling; it now returns `Infinity`.
An agent (or human) reasoning from the README believes in a hard cap that no longer
exists. **Fix:** correct the README, add a "Retired variables" note.

### 2.3 The real leverage rail is undocumented — **CONFIRMED**
Source: Claude 1.3. The live 1.5× cap on margin option exposure vs. margin NLV lives
in `seed-sizing-live.ts:51` (`DEFAULT_MARGIN_MAX_TOTAL_UTILIZATION = 1.5`, env
`STRATEGY_MARGIN_MAX_TOTAL_UTILIZATION`) and appears in **neither README nor
CLAUDE.md**. The single most important risk limit is invisible unless you read
`.env.example`. **Fix:** document it prominently (belongs in a SAFETY doc).

### 2.4 Dead file paths in the primary docs — **CONFIRMED**
Source: Claude 1.3. `CLAUDE.md:55` references `src/bot/secret/` (actually
`src/strategy/secret/`); `CLAUDE.md:67` references `cash-position-gate.ts` (renamed
to `position-gate.ts`). Both dead. Erodes trust in every other pointer. **Fix:** trivial.

### 2.5 Cert-host on the account streamer — **NEEDS-TRACE**
Source: Claude 1.4. `tastytrade-client.ts:19` hardcodes
`wss://streamer.cert.tastyworks.com/streamer` — a `.cert.` (certification) host in an
otherwise production-pointed client. The dxLink *quote* streamer is fine (fetches its
URL dynamically). **Next step:** confirm whether the account streamer being on cert is
intentional or a latent bug.

---

## 3. Debunked / lower priority

### 3.1 "Test baseline is not green" — **FALSE**
Source: Codex 6.3. Claimed 32/51 test files fail on a missing dxLink export. This was a
**restricted-sandbox install artifact** — `@dxfeed/dxlink-api` is a barrel that
re-exports `DXLinkFeed` from `@dxfeed/dxlink-feed`, which a partial clean-install under a
throttled registry didn't fully fetch. Locally the suite is **472/472 green**. Discard
the finding. *Keep* its secondary insight though (3.2).

### 3.2 Pure strategy tests reach the broker adapter — **NEEDS-TRACE / same root as cycles**
Source: Codex 6.3 (secondary). Strategy tests import a graph that pulls in the live
broker adapter. This is the **same root cause as the 17 circular deps** — breaking the
cycles (relocating shared types/helpers to leaf modules) fixes this too. Folds into the
fallow cleanup, not a separate task.

### 3.3 Other Codex correctness leads — **NEEDS-TRACE**
Worth verifying, not yet checked: 6.6 (money-touching calls can overlap — concurrency),
6.8 (NDJSON persistence isn't transactional). Both plausible for a file-state bot. Trace
before acting; remember 6.3 was wrong.

---

## 4. The fallow/complexity goal (separate track)

Neither doc gets us to "0 cycles, cognitive < 15" — that's a code job, not a doc job.
Live fallow: **17 circular cycles, 69 functions over threshold** (but avg cyclomatic 2.5,
p90 5 — it's ~6 fat functions, e.g. `closePosition` cog 70, `maybeSeedCashAccount…` cog
74, not broad rot). Plan: break type-only cycles first, then extract the fat functions,
re-running fallow after each pass. **Do not** adopt Codex's ports/adapters rewrite to get
there — it's a detour far larger than the goal.

---

## 5. Governance ideas worth keeping (lower urgency)

From the Claude doc's "10 laws," sized correctly for this repo:
- **One brain, thin stubs** — `AGENTS.md` canonical (done — grounded router landed),
  `CLAUDE.md` → thin `@AGENTS.md` stub (not yet).
- **A `SAFETY.md`** listing invariants + where each is enforced (margin-flat-by-1PM, the
  1.5× rail, bid-based stops, confirmed-cancel-before-replace, read-only/do-not-touch).
  High value for a money system; mostly assembly from verified facts.
- **A doc-drift gate** (~50 lines in pre-commit): fail when a doc references a
  nonexistent path, or a retired var reappears as live. Would have caught 2.2 and 2.4
  automatically.
- Nice-to-have, not urgent: GLOSSARY, DECISIONS.md, generated ENV reference.

**Skip** (over-scoped for this repo): ports/adapters rewrite, typed config control plane,
capability/promotion registries, multi-mode execution state machine
(`disabled→shadow→…→live`). Revisit only if the bot grows well past a single process.

---

## 6. Suggested order

1. Trace the read-only gap (2.1) — decide if it's a real hole; fix at the boundary if so.
2. The 4 verified doc corrections (2.2–2.4) — cheap, high-trust, do together.
3. Fallow cleanup (§4) — cycles-first, tests green throughout.
4. `SAFETY.md` + doc-drift gate (§5) — lock the safety facts in so they can't rot again.
5. Verify then triage the remaining Codex leads (3.3).
