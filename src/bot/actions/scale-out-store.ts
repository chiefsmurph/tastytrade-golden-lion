import * as fs from "fs/promises";
import * as path from "path";

import type { StrategyAccountType } from "~/strategy/evaluate-trading-strategy";

// Persistent "has this group already been scaled out?" memory for the partial
// take-profit runner (see src/strategy/scale-out.ts). The strategy engine is
// stateless per cycle, so without this the runner's remaining half would just
// re-trip the base take-profit target every cycle and get sold off in tranches.
//
// One row per account + UNDERLYING::side. A row means "the first tranche was
// scaled out at this WAF; treat the remainder as a runner." Rows are pruned
// when the group is fully closed (clearScaled), when the position no longer
// exists (pruneOpenGroups each cycle), or by age (RETENTION_MS on write). The
// stored WAF is a re-entry guard: if a group's cost basis has moved materially
// from the scaled WAF, the flag is stale (a different position) and ignored.
//
// Mirrors the seed-outcome-store pattern: read-through per call, best-effort,
// NEVER throws — a store failure degrades to "fresh" (safe: full/partial
// take-profit, never a spurious runner breakeven exit).

interface ScaledRow {
  accountType: StrategyAccountType;
  groupKey: string;
  waf: number;
  at: string;
  atMs: number;
}

type ScaleOutData = Record<string, ScaledRow>;

// A cash runner can legitimately ride for days; keep this comfortably long.
// pruneOpenGroups is the primary cleanup — this is just a backstop against a
// row for a group that vanished without a clean close ever being observed.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Re-entry guard: if the live WAF has drifted more than this from the WAF at
// scale-out time, the "scaled" flag belongs to a different position — ignore it.
// Runners suppress adds so the WAF should not move at all; this is insurance.
const WAF_DRIFT_TOLERANCE = 0.05;

function keyFor(accountType: StrategyAccountType, groupKey: string): string {
  return `${accountType}::${String(groupKey).trim().toUpperCase()}`;
}

function getStorePath(): string {
  const dataDir = process.env.BOT_DATA_DIR?.trim() || undefined;
  return path.join(
    dataDir ?? path.join(process.cwd(), "data"),
    "runs",
    "scale-out-state.json",
  );
}

async function readStore(): Promise<ScaleOutData> {
  try {
    const raw = await fs.readFile(getStorePath(), "utf8");
    return JSON.parse(raw) as ScaleOutData;
  } catch {
    return {};
  }
}

function pruneExpired(data: ScaleOutData, now: number): ScaleOutData {
  const next: ScaleOutData = {};
  for (const [key, row] of Object.entries(data)) {
    if (now - row.atMs <= RETENTION_MS) {
      next[key] = row;
    }
  }
  return next;
}

async function writeStore(data: ScaleOutData): Promise<void> {
  const filePath = getStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

// True when this group already had its first tranche scaled out (→ runner) AND
// the live WAF still matches the WAF recorded at scale-out (re-entry guard).
// Each branch is a required guard on untrusted persisted data (exists / not
// expired / positive WAFs / drift); covered by scale-out-store.test.ts. CRAP is
// inflated only because the audit runs without a coverage dump.
// fallow-ignore-next-line complexity
export async function isScaled(
  accountType: StrategyAccountType,
  groupKey: string,
  currentWaf: number,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const data = await readStore();
    const row = data[keyFor(accountType, groupKey)];
    if (!row) return false;
    if (now - row.atMs > RETENTION_MS) return false;
    if (!(currentWaf > 0) || !(row.waf > 0)) return false;
    const drift = Math.abs(row.waf - currentWaf) / currentWaf;
    return drift <= WAF_DRIFT_TOLERANCE;
  } catch {
    return false;
  }
}

// Record that this group's first tranche was scaled out at `waf`.
export async function markScaled(
  accountType: StrategyAccountType,
  groupKey: string,
  waf: number,
  atMs: number = Date.now(),
): Promise<void> {
  try {
    const data = await readStore();
    data[keyFor(accountType, groupKey)] = {
      accountType,
      groupKey,
      waf,
      at: new Date(atMs).toISOString(),
      atMs,
    };
    await writeStore(pruneExpired(data, atMs));
  } catch {
    // best-effort: a persist failure just means the group is treated as fresh
    // next cycle (it may scale out an extra tranche — bounded and rare).
  }
}

// Drop the flag when a group is fully closed so a later re-entry starts fresh.
export async function clearScaled(
  accountType: StrategyAccountType,
  groupKey: string,
): Promise<void> {
  try {
    const data = await readStore();
    const key = keyFor(accountType, groupKey);
    if (!(key in data)) return;
    delete data[key];
    await writeStore(data);
  } catch {
    // best-effort
  }
}

// Each cycle: drop rows for this account whose group is no longer open (fully
// closed / disappeared) so stale flags can't freeze a re-entered position.
// Loop + account/open/expiry guards are all required; covered by
// scale-out-store.test.ts. CRAP is inflated only by the missing coverage dump.
// fallow-ignore-next-line complexity
export async function pruneOpenGroups(
  accountType: StrategyAccountType,
  openGroupKeys: Set<string>,
  now: number = Date.now(),
): Promise<void> {
  try {
    const data = await readStore();
    const open = new Set(
      Array.from(openGroupKeys, (k) => keyFor(accountType, k)),
    );
    let changed = false;
    for (const key of Object.keys(data)) {
      const row = data[key];
      if (row.accountType !== accountType) continue;
      if (!open.has(key)) {
        delete data[key];
        changed = true;
      }
    }
    const pruned = pruneExpired(data, now);
    if (changed || Object.keys(pruned).length !== Object.keys(data).length) {
      await writeStore(pruned);
    }
  } catch {
    // best-effort
  }
}
