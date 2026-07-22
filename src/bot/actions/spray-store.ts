import * as fs from "fs/promises";
import * as path from "path";

// Cross-cycle store for in-flight spray-buy RAMPS.
//
// golden-lion runs many short cycles per day (~4min each), so a multi-minute
// spray spans several cycles: it CANNOT live in a single run's memory. This
// module owns the ramp + working-order state, persisted to disk (same pattern
// as position-registry.ts) so a restart mid-spray resumes rather than
// double-fires or strands the target. Follows the module-vars + exported-fns
// convention (no classes / `this`).
//
// The model is a SINGLE tick-chasing order against a time-ramped cumulative
// target (see spray-ramp.ts). The record therefore holds only:
//   - the ramp parameters (total, window, front-load) so the allowed cumulative
//     target is recomputable from elapsed time on any cycle / after a restart,
//   - the state of AT MOST ONE working (live) chasing order, and
//   - the last OBSERVED filled quantity read back from the broker.
//
// Idempotence rules that keep restart safe:
//   - Each spray has a stable `id`. Re-registering the same id is a no-op (the
//     in-flight state wins over a replayed start).
//   - There is never more than one working order id at a time (single-order
//     invariant). On restart the executor reconciles that one id against the
//     broker before deciding to place anything — it never blindly re-places.
//   - `observedFilled` only ever moves forward from what the broker reports, so
//     a cancel-vs-fill race cannot double-count.
//   - Completed sprays (observedFilled >= total, or aborted) are dropped on the
//     next load so the file does not grow unbounded.

export interface SprayWorkingOrder {
  // Broker order id of the single live chasing order (string form).
  orderId: string;
  // Contracts requested on this working order (the shortfall at placement).
  quantity: number;
  // Limit price the working order currently rests at.
  limitPrice: number;
  // Absolute epoch ms the current limit was placed / last re-priced. The dwell
  // curve measures patience from here.
  lastMoveMs: number;
  // Cumulative contracts filled by all PRIOR (retired) orders at the moment this
  // order was placed. The spray's true cumulative fill is this plus the live
  // fill on THIS order — recomputed each cycle so re-reading the same live order
  // never double-counts.
  filledBefore: number;
}

export interface SprayRampRecord {
  id: string;
  accountNumber: string;
  symbol: string;
  contractSymbol: string;
  side: "call" | "put";
  orderSource: string;
  // Streamer/quote symbol for the live bid/ask read (may differ from the OCC
  // contractSymbol). Persisted so a per-cycle advance / a restart re-quotes the
  // right symbol.
  quoteSymbol: string;
  // Account type for the entry spread-gate ceiling. Persisted for the same
  // reason as quoteSymbol.
  accountType: "margin" | "cash" | "unknown";
  // Absolute epoch ms at which the spray started (ramp elapsed is relative).
  startedAtMs: number;
  // Absolute epoch ms past which no further chasing is allowed (min of the
  // spray window end and the market-close guard). Near it, patience collapses
  // (take the ask) or the remainder aborts.
  deadlineMs: number;
  // Ramp parameters (see spray-ramp.ts cumulativeAllowed).
  totalContracts: number;
  windowMs: number;
  frontLoad: number;
  // Contracts OBSERVED filled so far (monotonic, broker-confirmed). The whole
  // decision keys off this — never off what we THINK we ordered.
  observedFilled: number;
  // The single live chasing order, or null when nothing is working right now.
  workingOrder: SprayWorkingOrder | null;
  // Sticky abort flag (signal change / stop / thesis flip): keep fills, stop.
  aborted: boolean;
  // First epoch ms at which quote was unavailable in a consecutive streak.
  // Reset to undefined when a quote resolves. Used to abort dead contracts.
  quoteUnavailableSinceMs?: number;
  createdAt: string;
  updatedAt: string;
}

type SprayData = Record<string, SprayRampRecord>;

function getStorePath(): string {
  const dataDir = process.env.BOT_DATA_DIR?.trim() || undefined;
  return path.join(
    dataDir ?? path.join(process.cwd(), "data"),
    "runs",
    "spray-buys.json",
  );
}

// A spray is DONE when it has filled its whole target or been aborted. Pure.
export function isSprayComplete(record: SprayRampRecord): boolean {
  if (record.aborted) return true;
  return record.observedFilled >= Math.floor(record.totalContracts);
}

// Drop fully-resolved sprays so the file does not accumulate dead records. Pure.
function pruneCompletedSprays(data: SprayData): SprayData {
  const next: SprayData = {};
  for (const [id, record] of Object.entries(data)) {
    if (!isSprayComplete(record)) {
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

// Load all in-flight (not-yet-complete) sprays, pruning resolved ones as a side
// effect so callers never see stale records and the file self-trims.
export async function loadActiveSprays(): Promise<SprayRampRecord[]> {
  const data = await readStore();
  const pruned = pruneCompletedSprays(data);
  if (Object.keys(pruned).length !== Object.keys(data).length) {
    await writeStore(pruned);
  }
  return Object.values(pruned);
}

// Register a new spray ramp. Idempotent by id: if a spray with the same id
// already exists it is returned untouched (a restart that replays registration
// does not clobber in-flight ramp / working-order state). Returns the stored
// record.
export async function registerSpray(
  record: SprayRampRecord,
): Promise<SprayRampRecord> {
  const data = await readStore();
  const existing = data[record.id];
  if (existing) {
    return existing;
  }
  data[record.id] = record;
  await writeStore(data);
  return record;
}

export async function getSpray(id: string): Promise<SprayRampRecord | null> {
  const data = await readStore();
  return data[id] ?? null;
}

// Persist a whole updated record (working-order transitions, observed fills,
// abort). No-op if the spray is gone. Refreshes updatedAt and prunes if the
// update completed the spray.
export async function saveSpray(record: SprayRampRecord): Promise<void> {
  const data = await readStore();
  if (!data[record.id]) return;
  record.updatedAt = new Date().toISOString();
  data[record.id] = record;
  await writeStore(pruneCompletedSprays(data));
}

// Abort a spray (signal change / stop / thesis flip): keep whatever filled,
// stop chasing. Idempotent; safe when the id is unknown. Leaves any live
// working-order id in place so the executor / cancel sweep can clean it up.
export async function abortSpray(id: string): Promise<void> {
  const data = await readStore();
  const record = data[id];
  if (!record) return;
  record.aborted = true;
  record.updatedAt = new Date().toISOString();
  await writeStore(pruneCompletedSprays(data));
}

// Test/ops hook: wipe the store file.
export async function clearSprayStore(): Promise<void> {
  await writeStore({});
}
