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
  getSeedSelectionOptionsForAccountType,
  type TopOptionCandidateForSymbolResult,
} from "~/strategy/option-candidate";
import { normalizeInstrumentType, OrderPayload, roundOrderPrice } from "./actions/order-utils";
import { ProgrammaticAction } from "~/strategy/evaluate-trading-strategy";
import type { TastytradePlacedOrderResponse } from "~/core/types";
import { describeEffectiveBuyingPowerLimit, getEffectiveBuyingPowerSummary } from "./effective-buying-power";
import { BOT_ORDER_SOURCE } from "./order-sources";


export interface SeedSymbolOptions {
  priceMode?: "ask" | "mid";
  orderSource?: string;
  // Reject the seed if the computed limit price exceeds this value.
  // Used to gate averaging-down seeds to entries cheaper than the cash fill.
  maxLimitPrice?: number;
  // Skip chain candidate search and seed this exact contract instead.
  // Used by the cash-from-margin held-contract fallback when no candidate
  // fits the cash seed DTE window. Caller is responsible for DTE/spread gating.
  explicitContract?: {
    symbol: string;
    quoteSymbol?: string;
    dte?: number;
  };
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
  usedDteFallback?: boolean;
  usedHeldContractFallback?: boolean;
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

export function extractDryRunSkipReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return "seed order dry run failed";
  }

  const maybeResponse = error as Error & {
    response?: {
      data?: {
        error?: { message?: string };
        message?: string;
      };
    };
  };

  const brokerMessage =
    maybeResponse.response?.data?.error?.message ??
    maybeResponse.response?.data?.message;

  return brokerMessage || error.message || "seed order dry run failed";
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
  const candidate: TopOptionCandidateForSymbolResult | null | undefined = explicitContract
    ? {
        symbol: explicitContract.symbol,
        streamerSymbol: explicitContract.quoteSymbol ?? explicitContract.symbol,
        dte: explicitContract.dte,
        strategy: "MANAGE_ALLOCATION",
      }
    : await getTopOptionCandidateForSymbol(
        symbol,
        side,
        undefined,
        getSeedSelectionOptionsForAccountType(resolvedAccountType),
      );
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
    usedDteFallback,
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
        usedDteFallback: usedDteFallback ?? false,
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
    return affordabilitySkip;
  }

  let dryRunResponse: TastytradePlacedOrderResponse;
  try {
    dryRunResponse = await tastytradeApi.orderService.postOrderDryRun(
      resolvedAccountNumber,
      order,
    );
  } catch (error) {
    return {
      ...costResult,
      dryRunResponse:
        error instanceof Error
          ? ((error as Error & { response?: { data?: unknown } }).response?.data ?? error.message)
          : error,
      skippedReason: extractDryRunSkipReason(error),
    };
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