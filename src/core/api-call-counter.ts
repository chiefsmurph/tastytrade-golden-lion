import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Daily tastytrade API call counting, mirroring the feed repo's
// utils/api-call-counter.js pattern: in-memory counts, daily rollover,
// debounced 5s persist, hydrate-on-restart. The feed reads these files, so the
// on-disk contract is fixed: `<dir>/tastytrade-<M-D-YYYY>.json` containing
// { date, chainWalks, quotes, marketMetrics, orders, other, updatedAt }.
// Counting must NEVER break trading — every impure step is silent-safe.

export type ApiCallCategory =
  | "chainWalks"
  | "quotes"
  | "marketMetrics"
  | "orders"
  | "other";

const API_CALL_CATEGORIES: readonly ApiCallCategory[] = [
  "chainWalks",
  "quotes",
  "marketMetrics",
  "orders",
  "other",
];

export interface ApiCallCounts {
  date: string;
  chainWalks: number;
  quotes: number;
  marketMetrics: number;
  orders: number;
  other: number;
}

const PERSIST_DEBOUNCE_MS = 5000;

// Categorize a tastytrade REST path as the feed understands the buckets.
// Bid/ask quotes stream over the dxLink websocket (not REST), so `quotes`
// here counts the REST market-data + quote-token endpoints.
export function categorizeTastytradeApiPath(url: string): ApiCallCategory {
  const pathname = String(url ?? "").split("?")[0];

  if (/^\/(futures-)?option-chains\//.test(pathname)) return "chainWalks";
  if (pathname.startsWith("/market-metrics")) return "marketMetrics";
  if (pathname.startsWith("/market-data") || pathname.startsWith("/api-quote-tokens")) {
    return "quotes";
  }
  if (/\/(complex-)?orders(\/|$)/.test(pathname)) return "orders";
  return "other";
}

// M-D-YYYY with no zero padding, matching the feed's date-key format
// (e.g. 7-19-2026).
export function getApiCallDateKey(now: Date = new Date()): string {
  return `${now.getMonth() + 1}-${now.getDate()}-${now.getFullYear()}`;
}

// Daily rollover: keep counts that already belong to `dateKey`, otherwise
// start a fresh zeroed day.
export function rollCountsForDate(
  counts: ApiCallCounts | null,
  dateKey: string,
): ApiCallCounts {
  if (counts && counts.date === dateKey) return counts;
  return {
    date: dateKey,
    chainWalks: 0,
    quotes: 0,
    marketMetrics: 0,
    orders: 0,
    other: 0,
  };
}

// Directory contract: env API_CALL_COUNTS_DIR wins; the default resolves via
// homedir expansion of ~/golden-lion/json/api-call-counts so it lands
// on /home/deploy/... on prod and the laptop's home locally.
export function resolveApiCallCountsDir(): string {
  const fromEnv = process.env.API_CALL_COUNTS_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), "golden-lion", "json", "api-call-counts");
}

let counts: ApiCallCounts | null = null;
let hydrated = false;
let saveTimer: NodeJS.Timeout | null = null;

function countsFilePath(dateKey: string): string {
  return path.join(resolveApiCallCountsDir(), `tastytrade-${dateKey}.json`);
}

// Turn whatever was persisted on disk into safe counts for `dateKey`, or null
// when the file is stale (previous day) or malformed. Junk, negative, or
// missing category values hydrate as 0.
export function hydrateCountsFromSaved(
  saved: unknown,
  dateKey: string,
): ApiCallCounts | null {
  const record = saved as Partial<Record<keyof ApiCallCounts, unknown>> | null | undefined;
  if (!record || record.date !== dateKey) return null;

  const base = rollCountsForDate(null, dateKey);
  for (const category of API_CALL_CATEGORIES) {
    const value = Number(record[category]);
    base[category] = Number.isFinite(value) && value > 0 ? value : 0;
  }
  return base;
}

// Hydrate today's counts from disk once per process so a restart doesn't
// reset the day to 0. Synchronous on the first record only.
function ensureHydrated(todayKey: string): void {
  if (hydrated) return;
  hydrated = true;

  try {
    const saved: unknown = JSON.parse(fs.readFileSync(countsFilePath(todayKey), "utf8"));
    if (counts === null) counts = hydrateCountsFromSaved(saved, todayKey);
  } catch {}
}

async function persist(): Promise<void> {
  if (!counts) return;
  const dir = resolveApiCallCountsDir();
  const payload = { ...counts, updatedAt: new Date().toISOString() };
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, `tastytrade-${counts.date}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

function schedulePersist(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist().catch(() => {});
  }, PERSIST_DEBOUNCE_MS);
  // Never hold the process open just to flush counters.
  saveTimer.unref?.();
}

// The single entry point wired into the tastytrade HTTP client boundary.
export function recordTastytradeApiCall(url: string): void {
  try {
    const todayKey = getApiCallDateKey();
    ensureHydrated(todayKey);
    counts = rollCountsForDate(counts, todayKey);
    counts[categorizeTastytradeApiPath(url)] += 1;
    schedulePersist();
  } catch {}
}
