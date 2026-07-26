import tastytradeApi from "./tastytrade-client";

export interface UnderlyingIvMetrics {
  ivRank: number;              // 0–100 scale (matches UI "IV Rank")
  rawIvRank: number;           // pre-scale value straight from the API (0–1 decimal); kept for diagnostics/logs
  impliedVolatility: number | null; // raw IV index level (decimal, e.g. 1.187 = 118.7%)
}

const ivMetricsCache = new Map<string, { cachedAt: number; metrics: UnderlyingIvMetrics | null }>();
const IV_METRICS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The API returns implied-volatility-index-rank as a 0–1 decimal (live-verified
// 2026-07-03: MARA "0.355173693"); every threshold in this codebase (entry min
// 20, seed fallbacks 50/70) is 0–100, so fractional values are scaled up ×100.
//
// IV rank is contractually a 0–1 fraction, but it can transiently exceed 1.0 when
// current IV prints above its trailing-year high (rank slightly over 100%). The
// old `<= 1` guard mis-read such a raw 1.2 (= 120%, a HIGH-premium name) as a bare
// 1.2% "low premium" and skipped it. We now treat any raw value below
// IV_RANK_FRACTIONAL_MAX as a fraction and scale it; values at/above the cutoff are
// assumed already on the 0–100 scale (defensive against an API scale change). A
// real 0–1 rank never reaches the cutoff (max ~1.x), so the partition is clean.
const IV_RANK_FRACTIONAL_MAX = 2;

export function parseUnderlyingIvMetricsEntry(entry: unknown): UnderlyingIvMetrics | null {
  const record = entry as Record<string, unknown> | null | undefined;
  const rawIvRank = toNumber(record?.["implied-volatility-index-rank"]);
  if (rawIvRank == null) return null;

  return {
    ivRank: rawIvRank < IV_RANK_FRACTIONAL_MAX ? rawIvRank * 100 : rawIvRank,
    rawIvRank,
    impliedVolatility: toNumber(record?.["implied-volatility-index"]),
  };
}

// IPC boundary wrapper for `strategy:getUnderlyingIvMetrics`. The feed process
// skips the chain-walking candidate command for tickers this bot already holds,
// so this lightweight call is its only IV source for held names. Contract:
// unavailable data is a clean `null` — no error may cross the IPC boundary.
// `fetchMetrics` is injectable for tests only; production uses the cached
// getUnderlyingIvMetrics below (which itself resolves null on any failure).
export async function getUnderlyingIvMetricsForIpc(
  rawSymbol: string | undefined,
  fetchMetrics: (symbol: string) => Promise<UnderlyingIvMetrics | null> = getUnderlyingIvMetrics,
): Promise<UnderlyingIvMetrics | null> {
  const symbol = rawSymbol?.trim().toUpperCase();
  if (!symbol) return null;

  try {
    return (await fetchMetrics(symbol)) ?? null;
  } catch {
    return null;
  }
}

export async function getUnderlyingIvMetrics(
  symbol: string,
): Promise<UnderlyingIvMetrics | null> {
  const key = symbol.toUpperCase();
  const now = Date.now();
  const cached = ivMetricsCache.get(key);

  if (cached && now - cached.cachedAt <= IV_METRICS_CACHE_TTL_MS) {
    return cached.metrics;
  }

  try {
    // Must be the comma-separated string form: the SDK serializes arrays as
    // symbols[]=X (qs brackets), which the API rejects with a bare 400.
    const data = await tastytradeApi.marketMetricsService.getMarketMetrics({
      symbols: key,
    });

    // Response is an array of per-symbol objects
    const arr: any[] = Array.isArray(data) ? data : ((data as any)?.items ?? []);
    const entry = arr.find(
      (m: any) => String(m?.symbol ?? "").toUpperCase() === key,
    );

    if (!entry) {
      console.error(`[market-metrics] no market-metrics entry for ${key} — ivRank unavailable (cached ${IV_METRICS_CACHE_TTL_MS / 60000} min)`);
      ivMetricsCache.set(key, { cachedAt: now, metrics: null });
      return null;
    }

    const metrics = parseUnderlyingIvMetricsEntry(entry);
    if (metrics == null) {
      console.error(`[market-metrics] implied-volatility-index-rank missing/invalid for ${key} (raw: ${JSON.stringify(entry["implied-volatility-index-rank"])}) — ivRank unavailable (cached ${IV_METRICS_CACHE_TTL_MS / 60000} min)`);
      ivMetricsCache.set(key, { cachedAt: now, metrics: null });
      return null;
    }

    ivMetricsCache.set(key, { cachedAt: now, metrics });
    return metrics;
  } catch (error) {
    // Graceful degradation — no IV gate if API unavailable
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[market-metrics] market-metrics fetch failed for ${key}: ${message} — ivRank unavailable (cached ${IV_METRICS_CACHE_TTL_MS / 60000} min)`);
    ivMetricsCache.set(key, { cachedAt: now, metrics: null });
    return null;
  }
}
