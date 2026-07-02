import tastytradeApi from "~/core/tastytrade-client";
import { getUnderlyingIvMetrics } from "~/core/market-metrics";
import {
  chooseOptionCandidates,
  getOptionCandidateVolume,
  OptionCandidateSelectionOptions,
  resolveCandidateExpirations,
} from "../option-contracts";
import {
  getTimeOfDayExecutionTargets as _getTimeOfDayExecutionTargets,
  evaluateTradingStrategy,
  PositionMetrics,
} from "~/strategy/evaluate-trading-strategy";
import { getOptionMarketSnapshot, OptionChainWithVolume } from "./market-snapshot";
import { TopOptionCandidateForSymbolResult } from "./types";

import { getMarginTargetCallDelta, getMinIvRankPct, getMaxOptionSpreadPct } from "~/strategy/entry-filters";

export { getMarginTargetCallDelta };

const DEFAULT_TOP_CANDIDATE_DTE_TOLERANCE = 7;
const IVX_TIEBREAK_DTE_WINDOW = 3;

function getDefaultTopCandidateSelection() {
  const currentTime = new Date();
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
  const defaultSelection = getDefaultTopCandidateSelection();
  const preferredDTE =
    selectionOptions?.preferredDTE ?? targetDTE ?? (!hasDtePreference ? defaultSelection.preferredDTE : undefined);
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

export async function buildTopOptionCandidateResult(
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

    if (Math.abs(aDteDelta - bDteDelta) <= IVX_TIEBREAK_DTE_WINDOW) {
      const aIvx = side === "call" ? (a.callIv ?? 0) : (a.putIv ?? 0);
      const bIvx = side === "call" ? (b.callIv ?? 0) : (b.putIv ?? 0);
      if (aIvx !== bIvx) {
        return bIvx - aIvx;
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
