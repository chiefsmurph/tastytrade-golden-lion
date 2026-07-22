import * as fs from "fs/promises";
import * as path from "path";
import {
  SpraySliceState,
  abortOpenSlices,
  summarizeSprayProgress,
} from "./spray-schedule";

// Cross-cycle store for pending spray-buy schedules.
//
// golden-lion runs many short cycles per day (~4min each), so a multi-minute
// spray spans several cycles: it CANNOT live in a single run's memory. This
// module owns the pending-schedule state, persisted to disk (same pattern as
// position-registry.ts) so a restart mid-spray resumes rather than double-fires
// or strands slices. Follows the module-vars + exported-fns convention (no
// classes / `this`).
//
// Idempotence rules that keep restart safe:
//   - Each spray has a stable `id`. Re-registering the same id is a no-op.
//   - A slice moves pending -> placed exactly once (guarded by status); a
//     restart after a placed-but-unrecorded order is reconciled by the executor
//     against the broker, never blindly re-placed.
//   - Completed sprays (all slices filled or aborted) are dropped on the next
//     load so the file does not grow unbounded.

export interface SprayRecord {
  id: string;
  accountNumber: string;
  symbol: string;
  contractSymbol: string;
  side: "call" | "put";
  orderSource: string;
  // Absolute epoch ms at which the spray started (slice offsets are relative).
  startedAtMs: number;
  // Absolute epoch ms past which no further slices may be placed (market close
  // guard). Slices due after this are aborted, never spilled past the close.
  notAfterMs: number;
  // Per-slice limit price. The executor re-quotes at placement, but this anchors
  // the schedule and lets the store round-trip without a live quote.
  limitPrice: number;
  slices: SpraySliceState[];
  createdAt: string;
  updatedAt: string;
}

type SprayData = Record<string, SprayRecord>;

function getStorePath(): string {
  const dataDir = process.env.BOT_DATA_DIR?.trim() || undefined;
  return path.join(
    dataDir ?? path.join(process.cwd(), "data"),
    "runs",
    "spray-buys.json",
  );
}

// Drop sprays that are fully resolved (every slice filled or aborted) so the
// file does not accumulate dead records. Pure.
function pruneCompletedSprays(data: SprayData): SprayData {
  const next: SprayData = {};
  for (const [id, record] of Object.entries(data)) {
    if (!summarizeSprayProgress(record.slices).isComplete) {
      next[id] = record;
    }
  }
  return next;
}

async function readStore(): Promise<SprayData> {
  try {
    const raw = await fs.readFile(getStorePath(), "utf8");
    return JSON.parse(raw) as SprayData;
  } catch {
    return {};
  }
}

async function writeStore(data: SprayData): Promise<void> {
  const filePath = getStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

// Load all pending (not-yet-complete) sprays, pruning resolved ones as a side
// effect so callers never see stale records and the file self-trims.
export async function loadActiveSprays(): Promise<SprayRecord[]> {
  const data = await readStore();
  const pruned = pruneCompletedSprays(data);
  if (Object.keys(pruned).length !== Object.keys(data).length) {
    await writeStore(pruned);
  }
  return Object.values(pruned);
}

// Register a new spray schedule. Idempotent by id: if a spray with the same id
// already exists it is returned untouched (a restart that replays registration
// does not clobber in-flight slice state). Returns the stored record.
export async function registerSpray(record: SprayRecord): Promise<SprayRecord> {
  const data = await readStore();
  const existing = data[record.id];
  if (existing) {
    return existing;
  }
  data[record.id] = record;
  await writeStore(data);
  return record;
}

export async function getSpray(id: string): Promise<SprayRecord | null> {
  const data = await readStore();
  return data[id] ?? null;
}

// Persist an updated slice array for a spray (e.g. a slice moved to placed /
// filled / aborted). No-op if the spray is gone. Refreshes updatedAt.
export async function updateSpraySlices(
  id: string,
  slices: SpraySliceState[],
): Promise<void> {
  const data = await readStore();
  const record = data[id];
  if (!record) return;
  record.slices = slices;
  record.updatedAt = new Date().toISOString();
  await writeStore(data);
}

// Abort every still-open slice on a spray (signal change / stop / thesis flip)
// and persist. Whatever already filled is kept; nothing is chased.
export async function abortSpray(id: string): Promise<void> {
  const data = await readStore();
  const record = data[id];
  if (!record) return;
  record.slices = abortOpenSlices(record.slices);
  record.updatedAt = new Date().toISOString();
  await writeStore(pruneCompletedSprays(data));
}

// Test/ops hook: wipe the store file.
export async function clearSprayStore(): Promise<void> {
  await writeStore({});
}
