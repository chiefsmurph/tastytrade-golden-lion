# Rename status: `tastytrade-silver-lynx` → `silver-lynx-tastytrade`

_Last updated: 2026-08-25_

Renaming this app's identity from `tastytrade-silver-lynx` to `silver-lynx-tastytrade`
to match the sibling-repo convention (`silver-lynx-alpaca`, `silver-lynx-tastytrade`).

## Scope decision

**Rename** the app's *identity*: pm2 process name, npm package name, and human/doc references.

**Do NOT rename** wire/infra identifiers — strings that are written to disk, sent to the
broker, or consumed by another system. Renaming those orphans history or breaks a live
integration. They can only change via a deliberate, coordinated migration (see
[Outstanding](#outstanding)).

---

## Done

### silver-lynx-tastytrade repo
- **`83c1e68`** — pm2 app + living-doc references:
  - `ecosystem.config.cjs` — pm2 app name
  - `README.md` — process label, local clone dir, "registers the app as…", pm2 commands
  - `AGENTS.md` — title + pm2 delete reference
  - `docs/OPERATIONS.md` — pm2 commands (deploy/rollback/gotchas) + one-time cutover note
  - `docs/STRATEGY.v2.md` — the `pm2 logs …` grep example
- **`a774f69`** — npm package identity:
  - `package.json` + `package-lock.json` — `name` field (verified nothing in `src` reads the package name)
  - `src/strategy/exit-decision-log.ts` — pm2 log example in the doc comment

### silver-lynx-alpaca repo
- **`18aeac4`** — `src/strategy/exit-decision-log.ts`: fixed a copy-paste that referenced the
  *tastytrade* bot; now references its own name `silver-lynx-alpaca`. (Not part of this rename
  per se — a pre-existing bug surfaced during the sweep. ⚠️ Assumed alpaca's pm2 name is
  `silver-lynx-alpaca` from its `package.json`; alpaca has no `ecosystem.config.cjs` to confirm.)

---

## Deliberately NOT renamed (wire/infra — leave as `tastytrade-silver-lynx`)

| What | Where | Why it stays |
|---|---|---|
| Broker order-source strings | `src/bot/order-sources.ts` (`BOT_ORDER_SOURCE` + seed sources), `src/bot/actions/manage-allocation.ts:406`, `src/bot/actions/order-utils.ts:171`, `src/bot/position-provenance.ts:83` | Written into Tastytrade order history + NDJSON ledgers. Renaming orphans historical P&L attribution. |
| Realized-pnl tests | `src/tools/tests/realized-pnl-paging.test.ts`, `realized-pnl-report.test.ts` | Assert the exact order-source strings above. |
| Secret-server log prefix | `src/strategy/secret/secret-socket-state.ts:267` (`SECRET_LOG_PREFIX`); doc ref `docs/OPERATIONS.md:11` | The secret server routes/greps on this prefix. |
| IPC socket filename `.tastytrade-silver-lynx.sock` | `src/ipc-server.ts:69`, `ipc-client.js:4`, `README.md` (socket refs) | golden-lion hardcodes the full path (below). Change only in lockstep. |
| Server deploy dir | `~/tastytrade-silver-lynx` / `/home/deploy/tastytrade-silver-lynx`; docs `OPERATIONS.md` `cd` lines | golden-lion's socket path depends on it. |
| Dated historical reports | `docs/ai-readiness.*`, `docs/fallow-*`, `docs/plans/*`, `docs/findings-*`, `docs/improvements/*` | Point-in-time snapshots — like commit messages, not living config. |

### Cross-repo references (golden-lion) — left as-is
- `utils/ipc-client.js:3` — hardcoded `/home/deploy/tastytrade-silver-lynx/.tastytrade-silver-lynx.sock`. **Load-bearing** — only change if the socket filename and/or deploy dir are migrated (in lockstep).
- `types/index.ts:632`, `.claude/skills/profit-audit/SKILL.md:19`, `docs/findings-2026-07-07.md:61`, `docs/options-mirror-bots-2026-07-13.md:169` — prose/historical references; safe to leave.

---

## Outstanding

1. **Server pm2 cutover (manual, on the box, markets closed).** The running process is still
   `tastytrade-silver-lynx`. Cut it over once:
   ```bash
   pm2 delete tastytrade-silver-lynx && pm2 start ecosystem.config.cjs && pm2 save
   ```
   After this, pm2 log filenames become `silver-lynx-tastytrade-out-N.log` (documented in
   `docs/OPERATIONS.md`). The deploy dir and socket filename intentionally stay unchanged.

2. **Confirm alpaca's pm2 name** (`silver-lynx-alpaca` was assumed) — adjust `18aeac4` if wrong.

3. **Optional future wire migrations** (only if ever desired — each needs coordination, not a sweep):
   - **Order-source strings** → requires a back-compat mapping so historical broker orders still
     attribute correctly in provenance + realized-pnl.
   - **Socket filename** → change in lockstep across `src/ipc-server.ts`, `ipc-client.js`, `README.md`,
     **and** golden-lion `utils/ipc-client.js` + the running process/socket file.
   - **Log prefix** → coordinate with the secret-server consumer that greps the prefix.
   - **Server deploy dir** → update golden-lion's hardcoded path + move/re-clone on the server.
