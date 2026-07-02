import tastytradeApi from "./tastytrade-client";

export interface UnderlyingIvMetrics {
  ivRank: number;              // 0–100 scale (matches UI "IV Rank")
  impliedVolatility: number | null; // raw IV index level (decimal, e.g. 1.187 = 118.7%)
}

const ivMetricsCache = new Map<string, { cachedAt: number; metrics: UnderlyingIvMetrics | null }>();
const IV_METRICS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
    const data = await tastytradeApi.marketMetricsService.getMarketMetrics({
      symbols: [key],
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

    const ivRank = toNumber(entry["implied-volatility-index-rank"]);
    if (ivRank == null) {
      console.error(`[market-metrics] implied-volatility-index-rank missing/invalid for ${key} (raw: ${JSON.stringify(entry["implied-volatility-index-rank"])}) — ivRank unavailable (cached ${IV_METRICS_CACHE_TTL_MS / 60000} min)`);
      ivMetricsCache.set(key, { cachedAt: now, metrics: null });
      return null;
    }

    const metrics: UnderlyingIvMetrics = {
      ivRank,
      impliedVolatility: toNumber(entry["implied-volatility-index"]),
    };

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
