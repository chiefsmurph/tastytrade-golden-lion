import tastytradeApi from "~/core/tastytrade-client";
import {
  getAccountMarginOrCash,
  getCashAccountNumber,
  getMarginAccountNumber,
} from "~/core/default-account";
import { CurrentPosition } from "~/core/types";
import { getUnderlyingSymbolForPosition } from "./evaluate-position";
import {
  getTopOptionCandidateForSymbol,
  CASH_ACCOUNT_SEED_MIN_DTE,
  CASH_ACCOUNT_SEED_MAX_DTE,
  getCashSeedDteFallbackWindow,
  getSeedSelectionOptionsForAccountType,
  NO_OPTION_CHAIN_SKIP_REASON,
  type TopOptionCandidateForSymbolResult,
} from "~/strategy/option-candidate";
import { normalizeInstrumentType, OrderPayload, roundOrderPrice } from "./actions/order-utils";
import { ProgrammaticAction } from "~/strategy/evaluate-trading-strategy";
import type { TastytradePlacedOrderResponse } from "~/core/types";
import { describeEffectiveBuyingPowerLimit, getEffectiveBuyingPowerSummary } from "./effective-buying-power";
import { BOT_ORDER_SOURCE } from "./order-sources";
import {
  getClosingOnlyRetryAt,
  isClosingOnlyDryRunError,
  recordClosingOnly,
} from "./closing-only-cache";
import { isSprayBuyEnabled, startSprayBuy } from "./actions/spray-buy";


export interface SeedSymbolOptions {
  priceMode?: "ask" | "mid";
  orderSource?: string;
  // Reject the seed if the computed limit price exceeds this value.
  // Used to gate averaging-down seeds to entries cheaper than the cash fill.
  maxLimitPrice?: number;
  // Selection-level cost cap in dollars (ask × 100), passed through to
  // candidate selection so the chain walk skips contracts quoting above it.
  // Set internally by the affordability retry (one retry with the binding cap
  // as the filter); its presence also marks the retry pass, so recursion
  // cannot go more than one level deep.
  maxAskPrice?: number;
  // Skip chain candidate search and seed this exact contract instead.
  // Used by the cash-from-margin held-contract fallback when no candidate
  // fits the cash seed DTE window. Caller is responsible for DTE/spread gating.
  explicitContract?: {
    symbol: string;
    quoteSymbol?: string;
    dte?: number;
  };
  // OPT-IN spray-buy: when >1 and the spray-buy flag is on (cash accounts only),
  // acquire this many contracts via the front-loaded spray primitive instead of
  // a single 1-lot order. Default behavior is unchanged when unset / <= 1 / the
  // flag is off / the account is not cash. Buy paths opt in explicitly.
  sprayContracts?: number;
}

export interface SeedSymbolResult {
  accountNumber: string;
  askPrice?: number;
  bidPrice?: number;
  buyingPowerAvailable?: number;
  candidateSymbol?: string;
  dte?: number;
  dryRunResponse?: TastytradePlacedOrderResponse | unknown;
  estimatedOrderCost?: number;
  limitPrice?: number;
  maxDTE?: number;
  midPrice?: number;
  minDTE?: number;
  priceMode?: "ask" | "mid";
  preferredDTE?: number;
  quoteSymbol?: string;
  orderResponse?: TastytradePlacedOrderResponse;
  placedOrder: boolean;
  side: "call" | "put";
  skippedReason?: string;
  strategy?: ProgrammaticAction | null;
  symbol: string;
  usedAffordabilityFallback?: boolean;
  usedCashDteWindowFallback?: boolean;
  usedDteFallback?: boolean;
  usedHeldContractFallback?: boolean;
  usedItmFallback?: boolean;
}

// Margin ITM seed fallback mirrors manage-allocation's: on low-priced/illiquid
// names the OTM strikes are dead-quoted (wide spreads) while the ATM/ITM strike
// is tradeable. Unlike run-cycle there is no extra eligibility condition —
// margin auto-seeds already passed the full-thesis gate upstream. IV-gate skips
// are an intentional entry filter, so they do not fall back.
export function shouldRetrySeedWithItm(
  accountType: "margin" | "cash" | "unknown",
  candidate: TopOptionCandidateForSymbolResult | null | undefined,
  hasExplicitContract: boolean,
): boolean {
  return (
    !hasExplicitContract &&
    accountType === "margin" &&
    !candidate?.symbol &&
    !candidate?.skippedByIvGate
  );
}

// Affordability retry: seed-symbol picks a candidate FIRST, then the
// affordability check skips if its cost blows a cap — so a near-broke account
// skips forever even when cheaper strikes exist in the same chain. Returns the
// binding cap (in order-cost dollars) to re-run selection with as maxAskPrice,
// or null when no retry should happen: already the retry pass, an explicit
// contract (nothing cheaper to hunt for), or a nonsensical cap.
export function getAffordabilityRetryCap(
  estimatedOrderCost: number,
  maxSeedOrderCost: number,
  buyingPowerAvailable: number,
  alreadyRetried: boolean,
  hasExplicitContract: boolean,
): number | null {
  if (alreadyRetried || hasExplicitContract) {
    return null;
  }
  const bindingCap = Math.min(maxSeedOrderCost, buyingPowerAvailable);
  if (!Number.isFinite(bindingCap) || bindingCap <= 0) {
    return null;
  }
  if (bindingCap >= estimatedOrderCost) {
    return null;
  }
  return bindingCap;
}

// Cash DTE-window fallback mirrors the margin ITM fallback above: small caps
// often carry only monthly expirations, so whole calendar stretches have no
// candidate inside the primary cash window (14-30) and the seed skips for
// weeks. Retry once with the wider env-tunable window; the retry only replaces
// the primary candidate when it lands genuinely inside the widened window, so
// the strict (load-bearing) skip strings stay intact otherwise. IV-gate skips
// are an intentional entry filter, so they do not retry.
export function shouldRetryCashSeedWithFallbackDteWindow(
  accountType: "margin" | "cash" | "unknown",
  candidate: TopOptionCandidateForSymbolResult | null | undefined,
  hasExplicitContract: boolean,
): boolean {
  if (hasExplicitContract || accountType !== "cash") {
    return false;
  }
  if (candidate?.skippedByIvGate) {
    return false;
  }
  const dte = candidate?.dte != null ? Number(candidate.dte) : undefined;
  return candidate?.usedDteFallback === true || !isWithinCashAccountSeedDteRange(dte);
}

function getMaxSeedOrderCost(): number {
  const raw = process.env.BOT_MAX_SEED_ORDER_COST;
  if (!raw) {
    return 500;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 500;
  }

  return parsed;
}



export function isWithinCashAccountSeedDteRange(dte: number | null | undefined): boolean {
  return (
    typeof dte === "number" &&
    Number.isFinite(dte) &&
    dte >= CASH_ACCOUNT_SEED_MIN_DTE &&
    dte <= CASH_ACCOUNT_SEED_MAX_DTE
  );
}

function formatPreflightIssue(issue: { code?: string; message?: string }): string {
  const message = (issue.message ?? "").trim();
  const code = (issue.code ?? "").trim();
  return [message, code && `[${code}]`].filter(Boolean).join(" ");
}

export function extractDryRunSkipReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return "seed order dry run failed";
  }

  const maybeResponse = error as Error & {
    response?: {
      data?: {
        error?: {
          message?: string;
          errors?: Array<{ code?: string; message?: string }>;
        };
        message?: string;
      };
    };
  };

  const brokerError = maybeResponse.response?.data?.error;
  const brokerMessage = brokerError?.message ?? maybeResponse.response?.data?.message;

  // The broker wraps specific preflight failures (e.g. "closing_only") in a
  // nested errors[] array while the top-level message stays generic ("One or
  // more preflight checks failed"). Append the specifics so the seed log names
  // the actual cause instead of the useless wrapper.
  const detail = (brokerError?.errors ?? [])
    .map(formatPreflightIssue)
    .filter((entry) => entry.length > 0)
    .join("; ");

  const base = brokerMessage || error.message || "seed order dry run failed";
  return detail ? `${base}: ${detail}` : base;
}

async function hasOpenUnderlyingPosition(
  accountNumber: string,
  symbol: string,
): Promise<boolean> {
  const currentPositions: CurrentPosition[] =
    await tastytradeApi.balancesAndPositionsService.getPositionsList(
      accountNumber,
    );

  return currentPositions.some((position) => {
    const quantity = Number(position.quantity) || 0;
    if (quantity === 0) {
      return false;
    }

    return getUnderlyingSymbolForPosition(position).toUpperCase() === symbol.toUpperCase();
  });
}

async function resolveSeedAccountNumber(options: {
  symbol: string;
}): Promise<{ accountNumber: string; fallbackToMargin: boolean }> {
  const cashAccountNumber = await getCashAccountNumber();
  if (!(await hasOpenUnderlyingPosition(cashAccountNumber, options.symbol))) {
    return {
      accountNumber: cashAccountNumber,
      fallbackToMargin: false,
    };
  }

  const marginAccountNumber = await getMarginAccountNumber();
  if (cashAccountNumber === marginAccountNumber) {
    return {
      accountNumber: cashAccountNumber,
      fallbackToMargin: false,
    };
  }

  return {
    accountNumber: marginAccountNumber,
    fallbackToMargin: true,
  };
}

// Pure: pick the option + quote symbols for the requested side.
export function deriveSeedContractSymbols(
  candidate: TopOptionCandidateForSymbolResult | null | undefined,
  side: "call" | "put",
) {
  const candidateSymbol =
    candidate?.symbol ?? (side === "put" ? candidate?.put : candidate?.call);
  const quoteSymbol =
    candidate?.streamerSymbol ??
    (side === "put"
      ? candidate?.["put-streamer-symbol"]
      : candidate?.["call-streamer-symbol"]) ??
    candidateSymbol;
  return { candidateSymbol, quoteSymbol };
}

// Pure: derive bid/ask/mid and the price the caller's priceMode selects.
export function computeSeedQuotePrices(
  bidAsk: { bid?: number | null; ask?: number | null } | null | undefined,
  priceMode: "ask" | "mid",
): { bidPrice: number; askPrice: number; midPrice: number; selectedPrice: number } {
  const bidPrice = bidAsk?.bid ?? 0;
  const askPrice = bidAsk?.ask ?? bidPrice;
  const midPrice =
    bidPrice > 0 && askPrice > 0 ? (bidPrice + askPrice) / 2 : askPrice || bidPrice;
  const selectedPrice = priceMode === "mid" ? midPrice : askPrice;
  return { bidPrice, askPrice, midPrice, selectedPrice };
}

// Cash seeds must land inside the seed DTE window. Returns a skip result to
// return, or null to continue. skippedReason strings are load-bearing.
export function checkCashSeedDte(
  resolvedAccountType: string,
  explicitContract: SeedSymbolOptions["explicitContract"],
  candidate: TopOptionCandidateForSymbolResult | null | undefined,
  candidateDte: number | undefined,
  baseResult: SeedSymbolResult,
): SeedSymbolResult | null {
  if (!(resolvedAccountType === "cash" && !explicitContract)) {
    return null;
  }
  // The widened-window retry (scope seed-cash-dte-fallback) already validated
  // this candidate against the fallback DTE window — flagged results pass.
  if (baseResult.usedCashDteWindowFallback) {
    return null;
  }
  if (candidate?.usedDteFallback) {
    return {
      ...baseResult,
      skippedReason: `no candidate found in cash seed DTE window ${CASH_ACCOUNT_SEED_MIN_DTE}-${CASH_ACCOUNT_SEED_MAX_DTE}`,
    };
  }
  if (!isWithinCashAccountSeedDteRange(candidateDte)) {
    return {
      ...baseResult,
      skippedReason: `cash seed candidate DTE must be within ${CASH_ACCOUNT_SEED_MIN_DTE}-${CASH_ACCOUNT_SEED_MAX_DTE}`,
    };
  }
  return null;
}

// Guards the order against the max-seed-cost cap and available buying power.
// Returns a skip result to return, or null to continue.
export function checkSeedAffordability(
  estimatedOrderCost: number,
  maxSeedOrderCost: number,
  buyingPowerAvailable: number,
  buyingPowerSummary: Awaited<ReturnType<typeof getEffectiveBuyingPowerSummary>>,
  costResult: SeedSymbolResult,
): SeedSymbolResult | null {
  if (estimatedOrderCost > maxSeedOrderCost) {
    return {
      ...costResult,
      skippedReason: `seed order cost ${estimatedOrderCost.toFixed(2)} exceeds BOT_MAX_SEED_ORDER_COST ${maxSeedOrderCost.toFixed(2)}`,
    };
  }
  if (estimatedOrderCost > buyingPowerAvailable) {
    return {
      ...costResult,
      skippedReason: `insufficient effective buying power for seed order — ${describeEffectiveBuyingPowerLimit(buyingPowerSummary)}, order cost ${estimatedOrderCost.toFixed(2)}`,
    };
  }
  return null;
}

export async function seedSymbol(
  symbol: string,
  side: "call" | "put" = "call",
  accountNumber?: string,
  options: SeedSymbolOptions = {},
): Promise<SeedSymbolResult> {
  const requestedAccountNumber = accountNumber?.trim();
  const normalizedSymbol = symbol.toUpperCase();
  const priceMode = options.priceMode === "mid" ? "mid" : "ask";
  const orderSource = options.orderSource?.trim() || BOT_ORDER_SOURCE;
  const resolvedSeedAccount = requestedAccountNumber
    ? { accountNumber: requestedAccountNumber, fallbackToMargin: false }
    : await resolveSeedAccountNumber({ symbol: normalizedSymbol });
  const resolvedAccountNumber = resolvedSeedAccount.accountNumber;
  const resolvedAccountType = await getAccountMarginOrCash(resolvedAccountNumber);

  // If the broker recently rejected this underlying as closing-only, skip the
  // whole selection + pricing + dry-run round trip until the retry window
  // elapses. The window is short enough that an intraday un-block is retried.
  const closingOnlyRetryAt = getClosingOnlyRetryAt(normalizedSymbol);
  if (closingOnlyRetryAt != null) {
    return {
      accountNumber: resolvedAccountNumber,
      placedOrder: false,
      side,
      skippedReason: `underlying set to closing-only by broker; retrying after ${new Date(closingOnlyRetryAt).toISOString()}`,
      symbol: normalizedSymbol,
    };
  }

  if (await hasOpenUnderlyingPosition(resolvedAccountNumber, normalizedSymbol)) {
    return {
      accountNumber: resolvedAccountNumber,
      placedOrder: false,
      side,
      skippedReason: "underlying already has an open position",
      symbol: normalizedSymbol,
    };
  }

  const explicitContract = options.explicitContract;
  let candidate: TopOptionCandidateForSymbolResult | null | undefined = explicitContract
    ? {
        symbol: explicitContract.symbol,
        streamerSymbol: explicitContract.quoteSymbol ?? explicitContract.symbol,
        dte: explicitContract.dte,
        strategy: "MANAGE_ALLOCATION",
      }
    : await getTopOptionCandidateForSymbol(symbol, side, undefined, {
        ...getSeedSelectionOptionsForAccountType(resolvedAccountType),
        maxAskPrice: options.maxAskPrice,
      });

  let usedItmFallback = false;
  if (shouldRetrySeedWithItm(resolvedAccountType, candidate, Boolean(explicitContract))) {
    const itmCandidate = await getTopOptionCandidateForSymbol(symbol, side, undefined, {
      accountType: "margin",
      maxAskPrice: options.maxAskPrice,
      strikeTarget: "itm",
    });
    console.log(
      JSON.stringify({
        scope: "seed-margin-itm-fallback",
        symbol: normalizedSymbol,
        otmSkippedReason: candidate?.skippedReason ?? "no candidate",
        itmSymbol: itmCandidate?.symbol ?? null,
        itmSpreadPct: itmCandidate?.spreadPct ?? null,
        itmSkippedReason: itmCandidate?.skippedReason ?? null,
      }),
    );
    if (itmCandidate?.symbol) {
      candidate = itmCandidate;
      usedItmFallback = true;
    }
  }

  let usedCashDteWindowFallback = false;
  if (
    shouldRetryCashSeedWithFallbackDteWindow(
      resolvedAccountType,
      candidate,
      Boolean(explicitContract),
    )
  ) {
    const fallbackWindow = getCashSeedDteFallbackWindow();
    const primarySkipReason = candidate?.usedDteFallback
      ? `no candidate found in cash seed DTE window ${CASH_ACCOUNT_SEED_MIN_DTE}-${CASH_ACCOUNT_SEED_MAX_DTE}`
      : `cash seed candidate DTE must be within ${CASH_ACCOUNT_SEED_MIN_DTE}-${CASH_ACCOUNT_SEED_MAX_DTE}`;
    const fallbackCandidate = await getTopOptionCandidateForSymbol(symbol, side, undefined, {
      ...getSeedSelectionOptionsForAccountType(resolvedAccountType),
      maxAskPrice: options.maxAskPrice,
      minDTE: fallbackWindow.minDTE,
      maxDTE: fallbackWindow.maxDTE,
    });
    const fallbackDte =
      fallbackCandidate?.dte != null ? Number(fallbackCandidate.dte) : undefined;
    // Only a candidate genuinely inside the widened window counts — a
    // nearest-expiration fallback (usedDteFallback) or an out-of-window DTE
    // keeps the primary candidate so the strict skip reason is emitted.
    const fallbackUsable =
      Boolean(fallbackCandidate?.symbol) &&
      fallbackCandidate?.usedDteFallback !== true &&
      typeof fallbackDte === "number" &&
      Number.isFinite(fallbackDte) &&
      fallbackDte >= fallbackWindow.minDTE &&
      fallbackDte <= fallbackWindow.maxDTE;
    console.log(
      JSON.stringify({
        scope: "seed-cash-dte-fallback",
        symbol: normalizedSymbol,
        side,
        primarySkipReason,
        fallbackMinDte: fallbackWindow.minDTE,
        fallbackMaxDte: fallbackWindow.maxDTE,
        fallbackDte: fallbackDte ?? null,
        fallbackCandidateSymbol: fallbackCandidate?.symbol ?? null,
        fallbackSkippedReason: fallbackCandidate?.skippedReason ?? null,
        accepted: fallbackUsable,
      }),
    );
    if (fallbackUsable) {
      candidate = fallbackCandidate;
      usedCashDteWindowFallback = true;
    }
  }

  const strategy = candidate?.strategy;
  const candidateDte = candidate?.dte != null ? Number(candidate.dte) : undefined;
  const minDTE = candidate?.minDTE;
  const maxDTE = candidate?.maxDTE;
  const preferredDTE = candidate?.preferredDTE;
  const usedDteFallback = candidate?.usedDteFallback;

  // Fields shared by every post-candidate result. Later stages extend this with
  // prices, then cost/limit, as they are computed. Consumers read fields
  // defensively (?? null / ?? false), so carrying extra fields is harmless; the
  // skippedReason strings are load-bearing (the held-contract fallback in
  // run-cycle-seed matches on them) and are preserved verbatim below.
  const baseResult: SeedSymbolResult = {
    accountNumber: resolvedAccountNumber,
    dte: candidateDte,
    maxDTE,
    minDTE,
    placedOrder: false,
    preferredDTE,
    side,
    strategy,
    symbol: normalizedSymbol,
    usedCashDteWindowFallback,
    usedDteFallback,
    usedItmFallback,
  };

  const cashDteSkip = checkCashSeedDte(
    resolvedAccountType,
    explicitContract,
    candidate,
    candidateDte,
    baseResult,
  );
  if (cashDteSkip) {
    return cashDteSkip;
  }

  console.log(
    JSON.stringify(
      {
        scope: "seed-symbol-candidate",
        symbol: normalizedSymbol,
        side,
        requestedAccountNumber: requestedAccountNumber ?? null,
        resolvedAccountNumber,
        resolvedAccountType,
        fallbackToMargin: resolvedSeedAccount.fallbackToMargin,
        explicitContract: explicitContract?.symbol ?? null,
        strategy,
        candidateDTE: candidateDte,
        minDTE,
        maxDTE,
        preferredDTE,
        usedCashDteWindowFallback,
        usedDteFallback: usedDteFallback ?? false,
        usedItmFallback,
        candidateSymbol: candidate?.symbol ?? candidate?.call ?? candidate?.put ?? null,
      },
      null,
      2,
    ),
  );
  if (
    !strategy ||
    strategy !== "MANAGE_ALLOCATION"
  ) {
    return {
      ...baseResult,
      skippedReason: "time-of-day strategy is not allowing new accumulation",
    };
  }

  // The underlying is not optionable at all (zero expirations anywhere).
  // Preserve the dedicated no-chain reason verbatim so the seed cooldown benches
  // it long-term instead of collapsing it into the generic "no option candidate
  // found" (which would earn only the moderate no-candidate cooldown and keep
  // re-fetching the empty chain). Only reached in-window (strategy check above),
  // so an off-hours probe still returns the transient time-of-day reason.
  if (candidate?.skippedReason === NO_OPTION_CHAIN_SKIP_REASON) {
    return {
      ...baseResult,
      skippedReason: NO_OPTION_CHAIN_SKIP_REASON,
    };
  }

  const { candidateSymbol, quoteSymbol } = deriveSeedContractSymbols(candidate, side);

  if (!candidateSymbol) {
    return {
      ...baseResult,
      skippedReason: "no option candidate found",
    };
  }

  if (!quoteSymbol) {
    return {
      ...baseResult,
      candidateSymbol,
      skippedReason: "candidate quote symbol unavailable",
    };
  }

  const bidAsk = await tastytradeApi.johnsService.getBidAskForSymbol(
    quoteSymbol,
    3000,
  );
  const { bidPrice, askPrice, midPrice, selectedPrice } = computeSeedQuotePrices(
    bidAsk,
    priceMode,
  );

  // Base extended with quote data; used by every result from here on.
  const pricedResult: SeedSymbolResult = {
    ...baseResult,
    askPrice,
    bidPrice,
    candidateSymbol,
    midPrice,
    priceMode,
    quoteSymbol,
  };

  if (!(selectedPrice && selectedPrice > 0)) {
    console.warn(
      `No valid ${priceMode} or fallback quote for ${quoteSymbol}, skipping seed order. BidAsk:`,
      bidAsk,
    );
    return {
      ...pricedResult,
      skippedReason: `candidate ${priceMode} quote unavailable`,
    };
  }

  const limitPrice = roundOrderPrice(selectedPrice);
  const numericLimitPrice = Number(limitPrice);

  if (options.maxLimitPrice !== undefined && numericLimitPrice > options.maxLimitPrice) {
    return {
      ...pricedResult,
      limitPrice: numericLimitPrice,
      skippedReason: `unfavorable entry: limit price ${numericLimitPrice.toFixed(2)} > cash fill ${options.maxLimitPrice.toFixed(2)}`,
    };
  }

  const order: OrderPayload = {
    source: orderSource,
    "time-in-force": "Day",
    "order-type": "Limit",
    price: limitPrice,
    "price-effect": "Debit",
    legs: [
      {
        action: "Buy to Open",
        symbol: candidateSymbol,
        quantity: 1,
        "instrument-type": normalizeInstrumentType("Equity Option"),
      },
    ],
  };

  const buyingPowerSummary = await getEffectiveBuyingPowerSummary(
    resolvedAccountNumber,
    new Date(),
    { bypassCashAccountCap: true },
  );
  const buyingPowerAvailable = buyingPowerSummary.effectiveBuyingPower;
  const estimatedOrderCost = numericLimitPrice * 100;
  const maxSeedOrderCost = getMaxSeedOrderCost();

  // Base extended with cost/limit data; used by the remaining returns.
  const costResult: SeedSymbolResult = {
    ...pricedResult,
    buyingPowerAvailable,
    estimatedOrderCost,
    limitPrice: numericLimitPrice,
  };

  const affordabilitySkip = checkSeedAffordability(
    estimatedOrderCost,
    maxSeedOrderCost,
    buyingPowerAvailable,
    buyingPowerSummary,
    costResult,
  );
  if (affordabilitySkip) {
    // The primary pick blew a cost cap, but a cheaper strike may exist in the
    // same chain. Re-run the whole seed once with the binding cap as a
    // selection-level ask filter. If the retry cannot place, return the
    // ORIGINAL skip — its reason string is load-bearing (run-cycle-seed's
    // held-contract fallback matches it verbatim).
    const retryCap = getAffordabilityRetryCap(
      estimatedOrderCost,
      maxSeedOrderCost,
      buyingPowerAvailable,
      options.maxAskPrice !== undefined,
      Boolean(explicitContract),
    );
    if (retryCap === null) {
      return affordabilitySkip;
    }
    console.log(
      JSON.stringify({
        scope: "seed-affordability-fallback",
        symbol: normalizedSymbol,
        side,
        primarySkipReason: affordabilitySkip.skippedReason,
        primaryCandidateSymbol: candidateSymbol,
        primaryEstimatedOrderCost: estimatedOrderCost,
        maxAskPrice: retryCap,
      }),
    );
    const retryResult = await seedSymbol(symbol, side, resolvedAccountNumber, {
      ...options,
      maxAskPrice: retryCap,
    });
    if (retryResult.placedOrder) {
      return { ...retryResult, usedAffordabilityFallback: true };
    }
    return affordabilitySkip;
  }

  let dryRunResponse: TastytradePlacedOrderResponse;
  try {
    dryRunResponse = await tastytradeApi.orderService.postOrderDryRun(
      resolvedAccountNumber,
      order,
    );
  } catch (error) {
    // Cache closing-only rejections so subsequent seeds short-circuit before
    // re-doing selection + pricing + a doomed dry-run until the retry window.
    if (isClosingOnlyDryRunError(error)) {
      recordClosingOnly(normalizedSymbol);
    }
    return {
      ...costResult,
      dryRunResponse:
        error instanceof Error
          ? ((error as Error & { response?: { data?: unknown } }).response?.data ?? error.message)
          : error,
      skippedReason: extractDryRunSkipReason(error),
    };
  }

  // OPT-IN spray-buy (cash accounts only, flag-gated): when the caller asked for
  // more than one contract, hand the acquisition to the front-loaded spray
  // primitive instead of placing a single 1-lot order. startSprayBuy fires the
  // first (largest) slice now and persists the rest for later cycles to release;
  // it self-guards on the flag / target, so a disabled flag or <=1 target falls
  // through to the normal single-order path below.
  const sprayContracts = Math.floor(options.sprayContracts ?? 0);
  if (
    sprayContracts > 1 &&
    resolvedAccountType === "cash" &&
    isSprayBuyEnabled()
  ) {
    const sprayResult = await startSprayBuy({
      accountNumber: resolvedAccountNumber,
      symbol: normalizedSymbol,
      contractSymbol: candidateSymbol,
      side,
      totalContracts: sprayContracts,
      limitPrice: numericLimitPrice,
      orderSource,
    });
    if (sprayResult.started) {
      console.log(
        JSON.stringify({
          scope: "seed-symbol-spray-buy",
          symbol: normalizedSymbol,
          side,
          contractSymbol: candidateSymbol,
          totalContracts: sprayContracts,
          scheduledSlices: sprayResult.scheduledSlices ?? null,
          firstSliceOrderId: sprayResult.firstSliceOrderId ?? null,
          sprayId: sprayResult.sprayId ?? null,
        }),
      );
      return {
        ...costResult,
        dryRunResponse,
        placedOrder: true,
        usedHeldContractFallback: explicitContract ? true : undefined,
      };
    }
    // Spray declined (flag flipped off mid-flight, invalid target) — fall
    // through to the normal single-order path so the seed still lands.
  }

  const orderResponse = await tastytradeApi.orderService.createOrder(
    resolvedAccountNumber,
    order,
  );

  return {
    ...costResult,
    dryRunResponse,
    orderResponse,
    placedOrder: true,
    usedHeldContractFallback: explicitContract ? true : undefined,
  };
}

export default seedSymbol;