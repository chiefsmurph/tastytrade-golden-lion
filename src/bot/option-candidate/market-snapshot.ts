import tastytradeApi from "~/core/tastytrade-client";
import { OptionMarketSnapshotCacheStats } from "./types";

const DEFAULT_OPTION_MARKET_SNAPSHOT_TTL_MS = 30_000;

type OptionChainWithVolume = Awaited<
  ReturnType<typeof tastytradeApi.johnsService.fetchOptionChainWithVolume>
>;

type UnderlyingPriceResult = Awaited<
  ReturnType<typeof tastytradeApi.johnsService.getUnderlyingPrice>
>;

interface CachedOptionMarketSnapshot {
  cachedAt: number;
  optionChain: OptionChainWithVolume;
  underlyingPrice: UnderlyingPriceResult;
}

export type { OptionChainWithVolume };

const optionMarketSnapshotCache = new Map<string, CachedOptionMarketSnapshot>();
let optionMarketSnapshotCacheHitCount = 0;
let optionMarketSnapshotCacheMissCount = 0;

function getOptionMarketSnapshotTtlMs(): number {
  const raw = process.env.BOT_OPTION_MARKET_SNAPSHOT_TTL_MS;
  if (!raw) return DEFAULT_OPTION_MARKET_SNAPSHOT_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_OPTION_MARKET_SNAPSHOT_TTL_MS;
}

export async function getOptionMarketSnapshot(
  symbol: string,
): Promise<{ optionChain: OptionChainWithVolume; underlyingPrice: number }> {
  const normalizedSymbol = symbol.toUpperCase();
  const ttlMs = getOptionMarketSnapshotTtlMs();
  const now = Date.now();
  const cached = optionMarketSnapshotCache.get(normalizedSymbol);

  if (cached && now - cached.cachedAt <= ttlMs) {
    optionMarketSnapshotCacheHitCount += 1;
    return {
      optionChain: cached.optionChain,
      underlyingPrice: cached.underlyingPrice?.underlyingPrice || 0,
    };
  }

  optionMarketSnapshotCacheMissCount += 1;

  const [optionChain, underlyingPrice] = await Promise.all([
    tastytradeApi.johnsService.fetchOptionChainWithVolume(normalizedSymbol),
    tastytradeApi.johnsService.getUnderlyingPrice(normalizedSymbol),
  ]);

  optionMarketSnapshotCache.set(normalizedSymbol, {
    cachedAt: now,
    optionChain,
    underlyingPrice,
  });

  return {
    optionChain,
    underlyingPrice: underlyingPrice?.underlyingPrice || 0,
  };
}

export function getOptionMarketSnapshotCacheStats(): OptionMarketSnapshotCacheStats {
  const requests = optionMarketSnapshotCacheHitCount + optionMarketSnapshotCacheMissCount;
  const hitRate = requests > 0 ? optionMarketSnapshotCacheHitCount / requests : 0;

  return {
    cacheSize: optionMarketSnapshotCache.size,
    hitRate,
    hits: optionMarketSnapshotCacheHitCount,
    misses: optionMarketSnapshotCacheMissCount,
    requests,
    ttlMs: getOptionMarketSnapshotTtlMs(),
  };
}

export function resetOptionMarketSnapshotCacheStats(clearCache = false): OptionMarketSnapshotCacheStats {
  optionMarketSnapshotCacheHitCount = 0;
  optionMarketSnapshotCacheMissCount = 0;

  if (clearCache) {
    optionMarketSnapshotCache.clear();
  }

  return getOptionMarketSnapshotCacheStats();
}
