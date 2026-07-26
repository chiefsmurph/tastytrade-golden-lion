import * as fs from "fs/promises";
import * as path from "path";

// Last seed-spray OUTCOME per account+symbol+side.
//
// The dashboard's per-account status comes from a fresh pre-trade candidate
// evaluation (strategy:getTopOptionCandidateForSymbol) that renders "✅ buying
// power" whenever a viable candidate exists. That is a LIE when the most recent
// seed spray actually placed and then aborted with zero fills — but neither the
// candidate (fresh eval) nor the spray-store (prunes aborted sprays immediately,
// see spray-store.ts) carries that execution state. This small persistent map
// does: the spray executor records a terminal outcome here, and the candidate
// path overlays a skippedReason from it so the dashboard shows the truth.
//
// Bounded by distinct account+symbol+side keys (one row each, overwritten on the
// next outcome); rows older than the retention window are pruned on write.

export type SeedOutcomeState = "aborted" | "filled" | "partial";

export interface SeedOutcome {
  accountType: "margin" | "cash" | "unknown";
  symbol: string;
  side: "call" | "put";
  state: SeedOutcomeState;
  // For aborts: the discriminated chase reason (no-quote / spread-too-wide /
  // bad-mid / deadline). Absent for fills.
  reason?: string;
  observedFilled: number;
  totalContracts: number;
  at: string;
  atMs: number;
}

type SeedOutcomeData = Record<string, SeedOutcome>;

// Rows older than this are dropped on write so the file cannot accumulate stale
// symbols forever. Comfortably longer than the overlay recency window.
const RETENTION_MS = 24 * 60 * 60 * 1000;

function keyFor(
  accountType: "margin" | "cash" | "unknown",
  symbol: string,
  side: "call" | "put",
): string {
  return `${accountType}::${String(symbol).trim().toUpperCase()}::${side}`;
}

function getStorePath(): string {
  const dataDir = process.env.BOT_DATA_DIR?.trim() || undefined;
  return path.join(
    dataDir ?? path.join(process.cwd(), "data"),
    "runs",
    "seed-outcomes.json",
  );
}

async function readStore(): Promise<SeedOutcomeData> {
  try {
    const raw = await fs.readFile(getStorePath(), "utf8");
    return JSON.parse(raw) as SeedOutcomeData;
  } catch {
    return {};
  }
}

function pruneExpired(data: SeedOutcomeData, now: number): SeedOutcomeData {
  const next: SeedOutcomeData = {};
  for (const [key, row] of Object.entries(data)) {
    if (now - row.atMs <= RETENTION_MS) {
      next[key] = row;
    }
  }
  return next;
}

async function writeStore(data: SeedOutcomeData): Promise<void> {
  const filePath = getStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

// Record a terminal seed-spray outcome. Best-effort: NEVER throws, so a store
// write failure can't break spray execution (the caller runs in the order loop).
export async function recordSeedOutcome(
  outcome: Omit<SeedOutcome, "at" | "atMs"> & { atMs?: number },
): Promise<void> {
  try {
    const atMs = outcome.atMs ?? Date.now();
    const data = await readStore();
    data[keyFor(outcome.accountType, outcome.symbol, outcome.side)] = {
      accountType: outcome.accountType,
      symbol: outcome.symbol,
      side: outcome.side,
      state: outcome.state,
      reason: outcome.reason,
      observedFilled: outcome.observedFilled,
      totalContracts: outcome.totalContracts,
      at: new Date(atMs).toISOString(),
      atMs,
    };
    await writeStore(pruneExpired(data, atMs));
  } catch {
    // observe-only surfacing; swallow so the spray loop is never affected.
  }
}

// The most recent outcome for this account+symbol+side, or null when there is
// none or it is older than maxAgeMs. Never throws.
export async function getRecentSeedOutcome(
  accountType: "margin" | "cash" | "unknown",
  symbol: string,
  side: "call" | "put",
  maxAgeMs: number,
  now: number = Date.now(),
): Promise<SeedOutcome | null> {
  try {
    const data = await readStore();
    const row = data[keyFor(accountType, symbol, side)];
    if (!row) return null;
    if (now - row.atMs > maxAgeMs) return null;
    return row;
  } catch {
    return null;
  }
}

// Test/ops hook: wipe the store file.
export async function clearSeedOutcomeStore(): Promise<void> {
  await writeStore({});
}
