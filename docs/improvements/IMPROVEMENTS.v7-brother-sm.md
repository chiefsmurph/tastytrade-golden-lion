# Improvements v7 — Brother's branch review pass

> **Discovery log (2026-07-04).** Source material: the `sync/from-brother-sm` branch, which contains an early independent review of the codebase by Stephen (Claude Opus 4.8) and Codex before most of v1–v6's fixes landed. The branch holds ~15 `.md` files under `docs/Initial_look_and_plans/` and `docs/` covering API connectivity, architecture, strategy, execution flow, and a config proposal. Every item below was cross-checked against STATUS.md and v1–v6 before inclusion — nothing here duplicates an open, shipped, or deferred item. Where a finding is adjacent to an existing one, the relation is stated explicitly.
>
> Most bugs from those early docs are long fixed (streamer symbol/OCC split, short P/L math, timezone, run lock, cost-basis units, etc.). This doc captures only the residuals.

---

## Code / correctness

### 1. `inferIsRegularSession` ignores an explicit `state` field — falls through to the 7.5h heuristic

**File:** [src/core/market-sessions.ts:149–176](src/core/market-sessions.ts#L149-L176)

The function reads `sessionStatus` (populated from `state`, `session-status`, etc.) and passes it into `inferIsRegularSession`. But the logic only looks for "regular", "extended", "pre", or "post" as substrings. If the broker returns `state: "Open"` or `state: "Closed"`, none of those match, and the function falls to the duration heuristic (`closesAt - opensAt ≤ 7.5h → isRegularSession = true`).

The duration check was a reasonable workaround when the state field was absent. It's now a liability: if the session is 8h long (which can happen during extended daylight saving transitions or broker config changes), the heuristic returns `false` and the bot thinks it's in an extended session all day.

**Fix direction:** check `sessionStatus` directly before the substring scan — if it matches "open" or "closed" (case-insensitive), use that as the authoritative `isRegularSession = (status === 'open')` and skip the heuristic entirely.

*Not in STATUS. Distinct from v3/v4 timezone items (those were about strategy clock not using Pacific time; this is about session-type classification).*

---

### 2. `UNDERLYING::side` grouping averages across expirations — a profitable long-dated leg masks a stopping short-dated leg

**File:** [src/bot/evaluate-position.ts:61](src/bot/evaluate-position.ts#L61)

The group key is `${underlyingSymbol}::${side}`. All expirations of the same underlying+side land in one group. The group's bid/ask return and weighted-average-fill are quantity-weighted across all legs. Concretely: a MARA call expiring Friday at −45% return (should stop) and a MARA call expiring next month at +15% return (healthy) blend to roughly −15%, which clears neither the 40%→7% take-profit target nor the −30% stop. Neither action fires.

v5 strategy #5 ("per-expiration circuit breakers") addresses the same structural gap but from the angle of adding per-expiration stops/targets as an overlay. The complementary angle here is simpler: **log the per-leg return breakdown alongside the blended metric** so the operator can see when legs are diverging wildly. That's additive, zero behavior change, and gives the data needed to tune v5 strategy #5 when it ships.

**Fix direction (log-first):** in the position group evaluation, compute and log each leg's individual bid return alongside the blended group return. Flag groups where the max-to-min per-leg spread exceeds, e.g., 20 percentage points.

*Adjacent to v5 strategy #5 (per-expiration circuit breakers, AFTER MONDAY). This log-first step is a BEFORE-MONDAY diagnostic.*

---

### 3. `ecosystem.config.cjs` interpreter pinned to a specific host path

**File:** [ecosystem.config.cjs:7](ecosystem.config.cjs#L7)

```js
interpreter: "/home/deploy/.nvm/versions/node/v24.17.0/bin/node"
```

That path doesn't exist on any machine except the deploy host. Running `pm2 start ecosystem.config.cjs` anywhere else silently picks up a wrong Node version or fails with a misleading "spawn error." `interpreter: "node"` lets nvm/PATH resolve the version on any machine.

**Fix:** change `interpreter` to `"node"`, or add a comment marking the file as deploy-host-specific and noting that the path must be updated per host.

*Not tracked anywhere. Pure ops. Merge-safe.*

---

## Ops / observability

### 4. `core:cancelAllLiveOrders` is not documented — an emergency command operators can't discover

The IPC command exists and works, but it does not appear in the README. An operator who needs to cancel all working orders in an emergency (e.g., during a flash spike) must grep the source to find it. The startup log and `ipc-client.js` help CLI don't surface it.

**Fix:** add `core:cancelAllLiveOrders` to the README's IPC command table with a one-line description ("Cancel all open orders across all accounts immediately"). Also consider aliasing it as `bot:panic` or ensuring `bot:panic` (if it exists) calls through to it and is documented.

*Not in STATUS. Docs-only. Merge-safe.*

---

### 5. No `config:show` IPC command — no way to query effective runtime parameters mid-session

The startup banner (shipped per STATUS v4 #51) logs some settings at boot. But there's no command to ask the running bot "what are you actually configured with right now?" without restarting. If env vars are changed and the process is restarted, the banner scrolls past. If an operator wants to confirm `STRATEGY_INTRADAY_STOP_LOSS_PCT` or the IV-rank gate without reading the log file from the beginning, they have no tool.

**Fix direction:** add a `config:show` IPC command that dumps all effective strategy/risk parameters (reading from `process.env` via the existing `readEnvPct`/`toBooleanFlag` helpers) in a single structured JSON response. Redact credentials. Should be read-only (no state mutation). Under 30 lines.

*Not in STATUS. Additive, no behavior change. BEFORE MONDAY eligible.*

---

### 6. Named env-var profile sets — no way to switch posture atomically

There are 20+ `BOT_*` / `STRATEGY_*` env vars. Changing trading posture (e.g., from "aggressive morning accumulation" to "conservative risk-off") requires editing many individual vars, with no guarantee of consistency (e.g., changing the stop-loss floor but forgetting to tighten the spread gate).

Stephen's config proposal suggested conservative / balanced / aggressive profiles. The JSONC config idea isn't applicable here (the project is env-var-based), but the profile concept is: a set of `.env.profile.conservative`, `.env.profile.balanced`, `.env.profile.aggressive` files that override the base `.env` defaults as a group, loaded via `dotenv`'s override mechanism or a simple shell alias.

**Fix direction:** commit three `.env.profile.*` example files alongside `.env.example`, each containing only the vars that differ from the others (with comments explaining the trade-off). Document loading order in README. No code change required — this is a conventions + docs item.

*Not in STATUS. Docs/config. Merge-safe.*

---

## Conceptual / design framing

### 7. The "preview is a promise, not a contract" gap deserves explicit operator documentation

The cycle preview (`bot:getRunCyclePreview`) shows a plan built from quotes at T₀. Execution re-fetches quotes at T₁ (potentially minutes later). For volatile underlyings, the actual orders can differ materially from the preview — different sizes, different candidates, different groups triggering — with no reconciliation output.

v4 #88 (per-cycle memoization, AFTER MONDAY) and v4 #91 (unify normalizers) address this on the implementation side. The missing piece is **operator expectation-setting**: the preview output should include a disclaimer line ("quotes as of HH:MM:SS — live execution may differ") and the run-cycle log should note which plan items diverged from what was actually executed.

This is documentation + a one-line timestamp addition, not a behavior change.

*Related to v4 #88 and #91 (both AFTER MONDAY). This framing and the timestamp addition are BEFORE MONDAY.*

---

### 8. "What's the one check that gates everything?" framing for Monday verification

Stephen's early review identified a hierarchy: some bugs matter only if others are wrong first (cost-basis units gated all strategy correctness). That pattern applies to the current state going into Monday.

Suggested hierarchy for Monday verification, ordered so that finding a failure early avoids wasted debugging:

1. **Do cycle logs show the correct Pacific-time gates firing?** — confirm allocation cutoff and EOD liquidation fire at ~12:30 and ~12:55 PT (not local time). (One session-start check; blocks all timing analysis.)
2. **Does the IV-rank gate read a real value, not null?** — the 2026-07-02 MARA incident showed null IV after 11:28 AM; if this recurs, the gate is open all session. (Check the startup log for non-null IV reads within 5 min.)
3. **Does at least one position reach MANAGE_ALLOCATION and generate an order plan?** — if everything shows SKIP, the crash-loop backoff or signal gate is still blocking. (Check the first preview after market open.)
4. **Does the route-chase log show the new mid-lean behavior?** — bid rests, mid ≤3 ticks, ask-starts-at-mid. If you see the old bid→ask chase pattern, the route-chase code didn't bundle correctly.

This isn't a code item — it's a structured reminder of what to look for. Consider adding it to `docs/plans/` as a Monday log-reading guide.

*Not a code change. Cross-references project_monday_verification memory.*
