import tastytradeApi from "~/core/tastytrade-client";
import { getUnderlyingIvMetrics } from "~/core/market-metrics";
import {
  chooseOptionCandidates,
  getOptionCandidateVolume,
  OptionCandidateSelectionOptions,
  resolveCandidateExpirations,
} from "./option-contracts";
import {
  getTimeOfDayExecutionTargets,
  ProgrammaticAction,
  evaluateTradingStrategy,
  PositionMetrics,
} from "./evaluate-trading-strategy";

const DEFAULT_TOP_CANDIDATE_DTE_TOLERANCE = 7;
const DEFAULT_OPTION_HEALTH_DTES = [7, 14, 30] as const;
const DEFAULT_MAX_OPTION_SPREAD_PCT = 0.3;
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

const optionMarketSnapshotCache = new Map<string, CachedOptionMarketSnapshot>();
let optionMarketSnapshotCacheHitCount = 0;
let optionMarketSnapshotCacheMissCount = 0;

export interface OptionMarketSnapshotCacheStats {
  cacheSize: number;
  hitRate: number;
  hits: number;
  misses: number;
  requests: number;
  ttlMs: number;
}

export interface TopOptionCandidateForSymbolResult {
  askPrice?: number;
  bidPrice?: number;
  "call-streamer-symbol"?: string;
  call?: string;
  dte?: number;
  ivRank?: number;   // underlying IV rank 0–100 at time of selection
  ivx?: number;      // per-contract implied volatility of the chosen option (decimal)
  maxAllowedSpreadPct?: number;
  maxDTE?: number;
  meetsSpreadRequirement?: boolean;
  meetsVolumeRequirement?: boolean;
  minDTE?: number;
  preferredDTE?: number;
  "put-streamer-symbol"?: string;
  put?: string;
  quoteSymbol?: string;
  requestedSide?: "call" | "put";
  skippedReason?: string;
  spread?: number;
  spreadPct?: number;
  strategy?: ProgrammaticAction;
  streamerSymbol?: string;
  symbol?: string;
  usedDteFallback?: boolean;
}

export interface OptionHealthCandidateResult {
  candidate?: TopOptionCandidateForSymbolResult;
  targetDTE: number;
}

export interface OptionHealthSummary {
  fallbackTargets: number[];
  healthyTargets: number[];
  missingTargets: number[];
  wideSpreadTargets: number[];
}

export interface OptionHealthForSymbolResult {
  canOpenNewPosition: boolean;
  eligibility: OptionHealthGateDecision;
  requestedSide: "call" | "put";
  symbol: string;
  summary: OptionHealthSummary;
  targetDTE: number;
  targets: Record<string, TopOptionCandidateForSymbolResult | undefined>;
}

export interface OptionHealthGateDecision {
  missingRequiredTargets: number[];
  passed: boolean;
  requiredHealthyTargets: number[];
  targetDTE: number;
}

function getDefaultTopCandidateSelection() {
  const currentTime = new Date();
  // currentTime.setHours(11, 0, 0, 0); // Set to 11:00 AM
  const metrics: PositionMetrics = {
    currentBidPrice: 1,
    currentAskPrice: 1,
    currentTime,
    lastActionTime: currentTime,
    weightedAverageFill: 1,
  };
  const strategy = evaluateTradingStrategy(metrics);
  const preferredDTE = 14;

  return {
    maxDTE: preferredDTE + DEFAULT_TOP_CANDIDATE_DTE_TOLERANCE,
    minDTE: Math.max(0, preferredDTE - DEFAULT_TOP_CANDIDATE_DTE_TOLERANCE),
    preferredDTE,
    strategy,
  };
}

function getResolvedSelectionOptions(
  targetDTE?: number,
  selectionOptions?: OptionCandidateSelectionOptions,
) {
  const hasDtePreference =
    targetDTE != null ||
    selectionOptions?.preferredDTE != null ||
    selectionOptions?.minDTE != null ||
    selectionOptions?.maxDTE != null;
  const defaultSelection = !hasDtePreference ? getDefaultTopCandidateSelection() : undefined;
  const preferredDTE =
    selectionOptions?.preferredDTE ?? targetDTE ?? defaultSelection?.preferredDTE;
  const dteFill =
    preferredDTE != null
      ? {
          minDTE: Math.max(0, preferredDTE - DEFAULT_TOP_CANDIDATE_DTE_TOLERANCE),
          maxDTE: preferredDTE + DEFAULT_TOP_CANDIDATE_DTE_TOLERANCE,
          preferredDTE,
        }
      : undefined;
  const resolvedSelectionOptions: OptionCandidateSelectionOptions | undefined =
    selectionOptions != null
      ? { ...dteFill, ...selectionOptions }
      : dteFill;

  return {
    defaultSelection,
    preferredDTE,
    resolvedSelectionOptions,
  };
}

const DEFAULT_MIN_IV_RANK_PCT = 20;
const DEFAULT_MARGIN_TARGET_CALL_DELTA = 0.35;

export function getMarginTargetCallDelta(): number {
  const raw = process.env.BOT_MARGIN_TARGET_CALL_DELTA;
  if (!raw) return DEFAULT_MARGIN_TARGET_CALL_DELTA;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1
    ? parsed
    : DEFAULT_MARGIN_TARGET_CALL_DELTA;
}

function getMinIvRankPct(): number {
  const raw = process.env.BOT_MIN_IV_RANK_PCT;
  if (!raw) return DEFAULT_MIN_IV_RANK_PCT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_IV_RANK_PCT;
}

function getMaxOptionSpreadPct(): number {
  const raw = process.env.BOT_MAX_OPTION_SPREAD_PCT;
  if (!raw) {
    return DEFAULT_MAX_OPTION_SPREAD_PCT;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_OPTION_SPREAD_PCT;
  }

  return parsed;
}

function getOptionMarketSnapshotTtlMs(): number {
  const raw = process.env.BOT_OPTION_MARKET_SNAPSHOT_TTL_MS;
  if (!raw) {
    return DEFAULT_OPTION_MARKET_SNAPSHOT_TTL_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_OPTION_MARKET_SNAPSHOT_TTL_MS;
  }

  return parsed;
}

async function getOptionMarketSnapshot(
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

function getSpreadStats(bid: number, ask: number) {
  const resolvedBid = bid > 0 ? bid : 0;
  const resolvedAsk = ask > 0 ? ask : resolvedBid;
  const midpoint =
    resolvedBid > 0 && resolvedAsk > 0
      ? (resolvedBid + resolvedAsk) / 2
      : resolvedAsk || resolvedBid;
  const spread = Math.max(0, resolvedAsk - resolvedBid);
  const spreadPct = midpoint > 0 ? spread / midpoint : Number.POSITIVE_INFINITY;

  return {
    askPrice: resolvedAsk,
    bidPrice: resolvedBid,
    spread,
    spreadPct,
  };
}

type SideAwareCandidateShape = {
  "call-streamer-symbol"?: string;
  call?: string;
  "put-streamer-symbol"?: string;
  put?: string;
  streamerSymbol?: string;
  symbol?: string;
};

function normalizeCandidateForRequestedSide<T extends SideAwareCandidateShape>(
  candidate: T,
  side: "call" | "put",
): T {
  const resolvedSymbol =
    candidate.symbol ?? (side === "call" ? candidate.call : candidate.put);
  const resolvedStreamerSymbol =
    candidate.streamerSymbol ??
    (side === "call"
      ? candidate["call-streamer-symbol"]
      : candidate["put-streamer-symbol"]);

  return {
    ...candidate,
    symbol: resolvedSymbol,
    streamerSymbol: resolvedStreamerSymbol,
    call: side === "call" ? resolvedSymbol : undefined,
    put: side === "put" ? resolvedSymbol : undefined,
    "call-streamer-symbol":
      side === "call" ? resolvedStreamerSymbol : undefined,
    "put-streamer-symbol":
      side === "put" ? resolvedStreamerSymbol : undefined,
  } as T;
}

function sanitizeTopCandidateResponse(
  candidate: TopOptionCandidateForSymbolResult,
): TopOptionCandidateForSymbolResult {
  const {
    requestedSide: _requestedSide,
    call: _call,
    put: _put,
    "call-streamer-symbol": _callStreamerSymbol,
    "put-streamer-symbol": _putStreamerSymbol,
    "strike-price": _strikePrice,
    ...sanitized
  } = candidate as TopOptionCandidateForSymbolResult & {
    "strike-price"?: string;
  };

  return sanitized;
}

// Within this many DTE days, prefer the expiration with higher per-contract IVX
const IVX_TIEBREAK_DTE_WINDOW = 3;

async function buildTopOptionCandidateResult(
  symbol: string,
  side: "call" | "put",
  optionChain: OptionChainWithVolume,
  underlyingPrice: number,
  targetDTE?: number,
  selectionOptions?: OptionCandidateSelectionOptions,
): Promise<TopOptionCandidateForSymbolResult | undefined> {
  const { defaultSelection, preferredDTE, resolvedSelectionOptions } =
    getResolvedSelectionOptions(targetDTE, selectionOptions);
  const { usedDteFallback } = resolveCandidateExpirations(
    optionChain,
    resolvedSelectionOptions,
  );
  const optionCandidates = chooseOptionCandidates(
    optionChain,
    underlyingPrice,
    resolvedSelectionOptions,
    side,
  ).map((candidate) => ({
    ...candidate,
    meetsVolumeRequirement: getOptionCandidateVolume(candidate, side) > 40,
  }));

  const sortedCandidates = [...optionCandidates].sort((a, b) => {
    const aVolume = getOptionCandidateVolume(a, side);
    const bVolume = getOptionCandidateVolume(b, side);
    const aDteDelta = preferredDTE == null ? 0 : Math.abs(Number(a.dte) - preferredDTE);
    const bDteDelta = preferredDTE == null ? 0 : Math.abs(Number(b.dte) - preferredDTE);

    // Within the IVX tiebreak window, prefer the expiration with richer premium
    if (Math.abs(aDteDelta - bDteDelta) <= IVX_TIEBREAK_DTE_WINDOW) {
      const aIvx = side === "call" ? (a.callIv ?? 0) : (a.putIv ?? 0);
      const bIvx = side === "call" ? (b.callIv ?? 0) : (b.putIv ?? 0);
      if (aIvx !== bIvx) {
        return bIvx - aIvx; // higher IVX preferred
      }
    }

    if (aDteDelta !== bDteDelta) {
      return aDteDelta - bDteDelta;
    }

    return bVolume - aVolume;
  });

  const maxAllowedSpreadPct = getMaxOptionSpreadPct();
  let fallbackWideSpreadCandidate: TopOptionCandidateForSymbolResult | undefined;

  for (const candidate of sortedCandidates) {
    const normalizedCandidate = normalizeCandidateForRequestedSide(candidate, side);
    const quoteLookupSymbol =
      normalizedCandidate.streamerSymbol ?? normalizedCandidate.symbol;
    if (!quoteLookupSymbol) {
      continue;
    }

    const bidAsk = await tastytradeApi.johnsService.getBidAskForSymbol(
      quoteLookupSymbol,
      2000,
    );
    const spreadStats = getSpreadStats(bidAsk?.bid ?? 0, bidAsk?.ask ?? 0);
    const meetsSpreadRequirement = spreadStats.spreadPct <= maxAllowedSpreadPct;

    const candidateIvx =
      side === "call" ? (candidate.callIv ?? undefined) : (candidate.putIv ?? undefined);

    const candidateResult: TopOptionCandidateForSymbolResult = {
      ...normalizedCandidate,
      ...spreadStats,
      ivx: candidateIvx,
      maxAllowedSpreadPct,
      meetsSpreadRequirement,
      quoteSymbol:
        normalizedCandidate.streamerSymbol === quoteLookupSymbol
          ? undefined
          : quoteLookupSymbol,
      strategy: defaultSelection?.strategy?.action,
      usedDteFallback,
    };

    if (meetsSpreadRequirement) {
      const sanitizedResult = sanitizeTopCandidateResponse(candidateResult);
      console.log(`Top option candidate for ${symbol}:`, sanitizedResult);
      return sanitizedResult;
    }

    if (!fallbackWideSpreadCandidate) {
      fallbackWideSpreadCandidate = candidateResult;
    }
  }

  if (fallbackWideSpreadCandidate) {
    return sanitizeTopCandidateResponse({
      ...fallbackWideSpreadCandidate,
      symbol: undefined,
      skippedReason: "all candidate spreads exceeded BOT_MAX_OPTION_SPREAD_PCT",
    });
  }

  const topCandidate = sortedCandidates[0];
  if (!topCandidate) {
    return {
      maxAllowedSpreadPct,
      maxDTE: resolvedSelectionOptions?.maxDTE,
      meetsSpreadRequirement: false,
      minDTE: resolvedSelectionOptions?.minDTE,
      preferredDTE,
      skippedReason: "no candidate found for target",
      strategy: defaultSelection?.strategy?.action,
      usedDteFallback,
    };
  }

  return sanitizeTopCandidateResponse({
    ...normalizeCandidateForRequestedSide(topCandidate, side),
    maxAllowedSpreadPct,
    maxDTE: resolvedSelectionOptions?.maxDTE,
    meetsSpreadRequirement: false,
    minDTE: resolvedSelectionOptions?.minDTE,
    preferredDTE,
    skippedReason: "candidate quote symbol unavailable",
    strategy: defaultSelection?.strategy?.action,
    usedDteFallback,
  });
}

export async function getTopOptionCandidateForSymbol(
  symbol: string,
  side: "call" | "put" = "call",
  targetDTE?: number,
  selectionOptions?: OptionCandidateSelectionOptions,
): Promise<TopOptionCandidateForSymbolResult | undefined> {
  const [marketSnapshot, ivMetrics] = await Promise.all([
    getOptionMarketSnapshot(symbol),
    getUnderlyingIvMetrics(symbol),
  ]);

  const ivRank = ivMetrics?.ivRank ?? undefined;

  if (ivRank != null) {
    const minIvRank = getMinIvRankPct();
    if (ivRank < minIvRank) {
      return {
        ivRank,
        skippedReason: `IV rank ${ivRank.toFixed(1)} below minimum ${minIvRank} — low premium environment`,
      };
    }
  }

  const result = await buildTopOptionCandidateResult(
    symbol,
    side,
    marketSnapshot.optionChain,
    marketSnapshot.underlyingPrice,
    targetDTE,
    selectionOptions,
  );

  return result ? { ...result, ivRank } : result;
}

export async function getOptionHealthForSymbol(
  symbol: string,
  side: "call" | "put" = "call",
  targetDTEs: readonly number[] = DEFAULT_OPTION_HEALTH_DTES,
  targetDTEForEligibility?: number,
): Promise<OptionHealthForSymbolResult> {
  const marketSnapshot = await getOptionMarketSnapshot(symbol);
  const resolvedUnderlyingPrice = marketSnapshot.underlyingPrice;
  const normalizedSymbol = symbol.toUpperCase();

  const targetEntries = await Promise.all(
    targetDTEs.map(async (targetDTE) => [
      String(targetDTE),
      await buildTopOptionCandidateResult(
        normalizedSymbol,
        side,
        marketSnapshot.optionChain,
        resolvedUnderlyingPrice,
        targetDTE,
      ),
    ] as const),
  );

  const targets = Object.fromEntries(targetEntries) as Record<
    string,
    TopOptionCandidateForSymbolResult | undefined
  >;
  const summary = targetDTEs.reduce<OptionHealthSummary>(
    (result, targetDTE) => {
      const candidate = targets[String(targetDTE)];

      if (!candidate?.symbol || candidate.meetsSpreadRequirement === false) {
        result.missingTargets.push(targetDTE);

        if (candidate?.meetsSpreadRequirement === false) {
          result.wideSpreadTargets.push(targetDTE);
        }

        return result;
      }

      if (candidate.usedDteFallback) {
        result.fallbackTargets.push(targetDTE);
        return result;
      }

      result.healthyTargets.push(targetDTE);

      return result;
    },
    {
      fallbackTargets: [],
      healthyTargets: [],
      missingTargets: [],
      wideSpreadTargets: [],
    },
  );
  const resolvedTargetDTE =
    targetDTEForEligibility ?? getTimeOfDayExecutionTargets(new Date()).targetDTE;
  const eligibility = evaluateOptionHealthForTargetDTE(
    summary,
    resolvedTargetDTE,
    targetDTEs,
  );

  console.log(
    JSON.stringify({
      canOpenNewPosition: eligibility.passed,
      eligibility,
      requestedSide: side,
      scope: "option-health",
      summary,
      symbol: normalizedSymbol,
      targetDTE: resolvedTargetDTE,
      targets,
    }),
  );

  return {
    canOpenNewPosition: eligibility.passed,
    eligibility,
    requestedSide: side,
    summary,
    symbol: normalizedSymbol,
    targetDTE: resolvedTargetDTE,
    targets,
  };
}

export function evaluateOptionHealthForTargetDTE(
  summary: OptionHealthSummary,
  targetDTE: number,
  healthCheckDTEs: readonly number[] = DEFAULT_OPTION_HEALTH_DTES,
): OptionHealthGateDecision {
  const normalizedCheckpoints = [...new Set(healthCheckDTEs)]
    .filter((dte) => Number.isFinite(dte) && dte > 0)
    .sort((left, right) => left - right);

  const requiredHealthyTargets = normalizedCheckpoints.filter(
    (checkpointDTE) => checkpointDTE <= targetDTE,
  );

  const effectiveRequiredTargets =
    requiredHealthyTargets.length > 0
      ? requiredHealthyTargets
      : normalizedCheckpoints.slice(0, 1);

  const healthyTargetSet = new Set(summary.healthyTargets);
  const missingRequiredTargets = effectiveRequiredTargets.filter(
    (requiredDTE) => !healthyTargetSet.has(requiredDTE),
  );

  return {
    missingRequiredTargets,
    passed: missingRequiredTargets.length === 0,
    requiredHealthyTargets: effectiveRequiredTargets,
    targetDTE,
  };
}
