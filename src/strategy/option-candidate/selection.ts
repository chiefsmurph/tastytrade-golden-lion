import tastytradeApi from "~/core/tastytrade-client";
import { getUnderlyingIvMetrics } from "~/core/market-metrics";
import {
  chooseOptionCandidates,
  getOptionCandidateVolume,
  OptionCandidateSelectionOptions,
  resolveCandidateExpirations,
} from "~/bot/option-contracts";
import {
  getTimeOfDayExecutionTargets as _getTimeOfDayExecutionTargets,
  evaluateTradingStrategy,
  PositionMetrics,
} from "~/strategy/evaluate-trading-strategy";
import { getOptionMarketSnapshot, OptionChainWithVolume } from "~/core/market-snapshot";
import { TopOptionCandidateForSymbolResult } from "./types";

import { getMarginTargetCallDelta, getMinIvRankPct } from "~/strategy/entry-filters";
import {
  computeOptionLiquidityQuality,
  summarizeChainStructure,
} from "~/strategy/option-liquidity-quality";
import {
  EntryAccountType,
  evaluateLiquidityGate,
  getMaxEntrySpreadPctForAccountType,
  LiquidityGateCheck,
  logLiquidityGateDecision,
} from "~/strategy/liquidity-gate";

export { getMarginTargetCallDelta };

const DEFAULT_TOP_CANDIDATE_DTE_TOLERANCE = 7;
const IVX_TIEBREAK_DTE_WINDOW = 3;

// Emitted when the underlying carries ZERO expirations anywhere (not optionable
// at all) — a permanent property, distinct from a chain that exists but has no
// candidate in the DTE window or whose candidates fail spread/quote gates.
// Consumed verbatim by the seed cooldown to bench such names long-term. The
// substring "no option chain" maps it to the seed-rejection `no-chain` bucket.
export const NO_OPTION_CHAIN_SKIP_REASON = "no option chain for underlying";

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
  currentTime?: Date,
): Promise<TopOptionCandidateForSymbolResult | undefined> {
  const { defaultSelection, preferredDTE, resolvedSelectionOptions } =
    getResolvedSelectionOptions(targetDTE, selectionOptions);
  const accountType: EntryAccountType = selectionOptions?.accountType ?? "unknown";
  const now = currentTime ?? new Date();
  const { usedDteFallback } = resolveCandidateExpirations(
    optionChain,
    resolvedSelectionOptions,
  );

  // No-chain vs no-candidate: an underlying with ZERO expirations anywhere is
  // not optionable at all (fetchOptionChainWithVolume returns an empty
  // `expirations: []` on the "No option chain found" path), which is a
  // permanent property of the underlying — distinct from a chain that exists
  // but has no candidate inside the DTE window (usedDteFallback) or whose
  // candidates fail spread/quote gates (both transient/intraday). Surface a
  // dedicated skip reason so the seed cooldown can bench it long-term instead
  // of re-fetching the empty chain every cycle. The message contains "no
  // option chain" so it maps cleanly to the seed-rejection `no-chain` bucket.
  // Conservative by construction: a chain that merely quotes badly this instant
  // still carries expirations, so it never lands here.
  if (optionChain.expirations.length === 0) {
    return {
      maxAllowedSpreadPct: getMaxEntrySpreadPctForAccountType(accountType, now),
      maxDTE: resolvedSelectionOptions?.maxDTE,
      meetsSpreadRequirement: false,
      minDTE: resolvedSelectionOptions?.minDTE,
      preferredDTE,
      skippedReason: NO_OPTION_CHAIN_SKIP_REASON,
      strategy: defaultSelection?.strategy?.action,
      usedDteFallback,
    };
  }

  // Chain-structure classification for the liquidity-quality score: computed
  // once here (SG-like weeklies-in-window vs XXI-like monthly-only) and reused
  // for every candidate quote below — it is a property of the underlying, not
  // the strike.
  const chainStructure = summarizeChainStructure(optionChain.expirations);

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

  // Account-aware entry ceiling: margin may run tighter than the shared gate
  // because it must exit by EOD (see ~/strategy/liquidity-gate). Defaults keep
  // margin == shared, so this is behavior-neutral until opted in.
  const maxAllowedSpreadPct = getMaxEntrySpreadPctForAccountType(accountType, now);

  // The loop below early-returns on the first spread-passing candidate, so the
  // alternatives never surface anywhere. Their volume/OI/greeks are already in
  // the sampled chain (no extra fetches), so log the considered set for the
  // liquidity-distribution collection (IMPROVEMENTS.v4 strategy #4 step 1).
  // Spread/sizes are deliberately absent here — those need per-candidate quote
  // fetches the cycle can't afford; the chosen candidate's own log carries them.
  console.log(
    JSON.stringify({
      scope: "top-candidate-considered",
      symbol,
      side,
      preferredDTE,
      maxAllowedSpreadPct,
      candidates: sortedCandidates.slice(0, 6).map((candidate) => ({
        sym: side === "call" ? candidate.call : candidate.put,
        dte: candidate.dte,
        strike: candidate.strike,
        vol: getOptionCandidateVolume(candidate, side),
        oi: side === "call" ? (candidate.callOpenInterest ?? null) : (candidate.putOpenInterest ?? null),
        ivx: (side === "call" ? candidate.callIv : candidate.putIv) ?? null,
        delta: (side === "call" ? candidate.callDelta : candidate.putDelta) ?? null,
      })),
    }),
  );

  let fallbackBlockedCandidate: TopOptionCandidateForSymbolResult | undefined;
  const blockedCheckKinds = new Set<LiquidityGateCheck>();
  const maxAskPrice = selectionOptions?.maxAskPrice;
  let pricedOutCount = 0;

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

    // Cost filter for the affordability retry: a contract quoting above the
    // caller's cap can never place, so keep walking toward cheaper strikes.
    if (maxAskPrice != null && spreadStats.askPrice * 100 > maxAskPrice) {
      pricedOutCount += 1;
      continue;
    }

    const candidateIvx =
      side === "call" ? (candidate.callIv ?? undefined) : (candidate.putIv ?? undefined);
    const candidateOpenInterest =
      side === "call"
        ? (candidate.callOpenInterest ?? undefined)
        : (candidate.putOpenInterest ?? undefined);
    const candidateDayVolume = getOptionCandidateVolume(candidate, side);

    // Entry liquidity gate (step 2): spread vs the account-aware ceiling, the
    // open-interest floor, and the phantom-quote guard. Unknown fields pass
    // with a note — never treated as zero-liquidity.
    const liquidityGate = evaluateLiquidityGate({
      accountType,
      askSize: bidAsk?.askSize,
      bidSize: bidAsk?.bidSize,
      currentTime: now,
      dayVolume: candidateDayVolume,
      maxAllowedSpreadPct,
      openInterest: candidateOpenInterest,
      spreadPct: spreadStats.spreadPct,
    });
    logLiquidityGateDecision(
      {
        candidateSymbol: normalizedCandidate.symbol ?? quoteLookupSymbol,
        side,
        source: "chain-candidate",
        underlyingSymbol: symbol,
      },
      liquidityGate,
    );

    // optionLiquidityQuality (0..1): SG-like liquid weekly (high) vs thin
    // monthly-only (low). Exported for the sizing model + the concentration
    // caps. Uses this candidate's own spread/OI so it reflects the strike we'd
    // actually trade, not just the chain structure.
    const liquidityQuality = computeOptionLiquidityQuality({
      chainStructure,
      spreadPct: spreadStats.spreadPct,
      openInterest: candidateOpenInterest,
    });

    const candidateResult: TopOptionCandidateForSymbolResult = {
      ...normalizedCandidate,
      ...spreadStats,
      askSize: bidAsk?.askSize,
      bidSize: bidAsk?.bidSize,
      openInterest: candidateOpenInterest,
      dayVolume: candidateDayVolume,
      ivx: candidateIvx,
      optionLiquidityQuality: liquidityQuality.score,
      maxAllowedSpreadPct,
      meetsSpreadRequirement: liquidityGate.meetsSpreadRequirement,
      quoteSymbol:
        normalizedCandidate.streamerSymbol === quoteLookupSymbol
          ? undefined
          : quoteLookupSymbol,
      strategy: defaultSelection?.strategy?.action,
      usedDteFallback,
    };

    if (liquidityGate.passed) {
      // (log removed: this was a pure duplicate of the ipc-response block that
      // logs the same sanitized object immediately after — ~20.5K lines/day)
      return sanitizeTopCandidateResponse(candidateResult);
    }

    for (const failedCheck of liquidityGate.failedChecks) {
      blockedCheckKinds.add(failedCheck);
    }
    if (!fallbackBlockedCandidate) {
      fallbackBlockedCandidate = candidateResult;
    }
  }

  if (fallbackBlockedCandidate) {
    const blockedKinds = [...blockedCheckKinds];
    const spreadOnly = blockedKinds.length === 1 && blockedKinds[0] === "spread";
    return sanitizeTopCandidateResponse({
      ...fallbackBlockedCandidate,
      symbol: undefined,
      skippedReason: spreadOnly
        ? `all candidate spreads exceeded max allowed spread (${(maxAllowedSpreadPct * 100).toFixed(2)}%)`
        : `all candidates blocked by the entry liquidity gate (${blockedKinds.join(", ")})`,
    });
  }

  // Every quoted candidate exceeded the caller's cost cap (affordability
  // retry). This reason never reaches run-cycle string matching: the seed
  // retry that sets maxAskPrice returns the ORIGINAL affordability skip when
  // the retry comes up empty.
  if (pricedOutCount > 0) {
    return {
      maxAllowedSpreadPct,
      maxDTE: resolvedSelectionOptions?.maxDTE,
      meetsSpreadRequirement: false,
      minDTE: resolvedSelectionOptions?.minDTE,
      preferredDTE,
      skippedReason: `all candidates exceeded max ask price cap ${(maxAskPrice ?? 0).toFixed(2)}`,
      strategy: defaultSelection?.strategy?.action,
      usedDteFallback,
    };
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
        skippedByIvGate: true,
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
