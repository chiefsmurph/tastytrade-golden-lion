import tastytradeApi from "~/core/tastytrade-client";
import {
  getAccountMarginOrCash,
  getCashAccountNumber,
  getMarginAccountNumber,
} from "~/core/default-account";
import { CurrentPosition } from "~/core/types";
import { getUnderlyingSymbolForPosition } from "./evaluate-position";
import { getTopOptionCandidateForSymbol, getMarginTargetCallDelta } from "./get-option-candidates-for-symbol";
import { normalizeInstrumentType, OrderPayload, roundOrderPrice } from "./actions/order-utils";
import { ProgrammaticAction } from "./evaluate-trading-strategy";
import type { TastytradePlacedOrderResponse } from "~/core/types";
import { getEffectiveBuyingPowerSummary } from "./effective-buying-power";
import { BOT_ORDER_SOURCE } from "./order-sources";

const DEFAULT_CONTRACT_MULTIPLIER = 100;
const DEFAULT_MAX_SEED_ORDER_COST = 500;
const CASH_ACCOUNT_SEED_MIN_DTE = 14;
const CASH_ACCOUNT_SEED_MAX_DTE = 30;

export interface SeedSymbolOptions {
  priceMode?: "ask" | "mid";
  orderSource?: string;
  // Reject the seed if the computed limit price exceeds this value.
  // Used to gate averaging-down seeds to entries cheaper than the cash fill.
  maxLimitPrice?: number;
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
}

function getMaxSeedOrderCost(): number {
  const raw = process.env.BOT_MAX_SEED_ORDER_COST;
  if (!raw) {
    return DEFAULT_MAX_SEED_ORDER_COST;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_SEED_ORDER_COST;
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

function extractDryRunSkipReason(error: unknown): string {
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

  const candidate = await getTopOptionCandidateForSymbol(
    symbol,
    side,
    undefined,
    resolvedAccountType === "cash"
      ? {
          minDTE: CASH_ACCOUNT_SEED_MIN_DTE,
          maxDTE: CASH_ACCOUNT_SEED_MAX_DTE,
        }
      : {
          strikeTarget: "otm",
          targetDelta: getMarginTargetCallDelta(),
        },
  );
  const strategy = candidate?.strategy;
  const candidateDte = candidate?.dte != null ? Number(candidate.dte) : undefined;

  if (resolvedAccountType === "cash") {
    if (candidate?.usedDteFallback) {
      return {
        accountNumber: resolvedAccountNumber,
        dte: candidateDte,
        maxDTE: candidate?.maxDTE,
        minDTE: candidate?.minDTE,
        placedOrder: false,
        preferredDTE: candidate?.preferredDTE,
        side,
        skippedReason: `no candidate found in cash seed DTE window ${CASH_ACCOUNT_SEED_MIN_DTE}-${CASH_ACCOUNT_SEED_MAX_DTE}`,
        strategy,
        symbol: normalizedSymbol,
        usedDteFallback: candidate?.usedDteFallback,
      };
    }

    if (!isWithinCashAccountSeedDteRange(candidateDte)) {
      return {
        accountNumber: resolvedAccountNumber,
        dte: candidateDte,
        maxDTE: candidate?.maxDTE,
        minDTE: candidate?.minDTE,
        placedOrder: false,
        preferredDTE: candidate?.preferredDTE,
        side,
        skippedReason: `cash seed candidate DTE must be within ${CASH_ACCOUNT_SEED_MIN_DTE}-${CASH_ACCOUNT_SEED_MAX_DTE}`,
        strategy,
        symbol: normalizedSymbol,
        usedDteFallback: candidate?.usedDteFallback,
      };
    }
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
        strategy,
        candidateDTE: candidateDte,
        minDTE: candidate?.minDTE,
        maxDTE: candidate?.maxDTE,
        preferredDTE: candidate?.preferredDTE,
        usedDteFallback: candidate?.usedDteFallback ?? false,
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
      accountNumber: resolvedAccountNumber,
      maxDTE: candidate?.maxDTE,
      minDTE: candidate?.minDTE,
      placedOrder: false,
      preferredDTE: candidate?.preferredDTE,
      side,
      skippedReason: "time-of-day strategy is not allowing new accumulation",
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback: candidate?.usedDteFallback,
    };
  }

  const minDTE = candidate?.minDTE;
  const maxDTE = candidate?.maxDTE;
  const preferredDTE = candidate?.preferredDTE;
  const usedDteFallback = candidate?.usedDteFallback;

  const candidateSymbol =
    candidate?.symbol ?? (side === "put" ? candidate?.put : candidate?.call);
  const quoteSymbol =
    candidate?.streamerSymbol ??
    (side === "put"
      ? candidate?.["put-streamer-symbol"]
      : candidate?.["call-streamer-symbol"]) ??
    candidateSymbol;

  if (!candidateSymbol) {
    return {
      accountNumber: resolvedAccountNumber,
      dte: candidateDte,
      maxDTE,
      minDTE,
      placedOrder: false,
      preferredDTE,
      side,
      skippedReason: "no option candidate found",
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback,
    };
  }

  if (!quoteSymbol) {
    return {
      accountNumber: resolvedAccountNumber,
      candidateSymbol,
      dte: candidateDte,
      maxDTE,
      minDTE,
      placedOrder: false,
      preferredDTE,
      side,
      skippedReason: "candidate quote symbol unavailable",
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback,
    };
  }

  const bidAsk = await tastytradeApi.johnsService.getBidAskForSymbol(
    quoteSymbol,
    3000,
  );
  const bidPrice = bidAsk?.bid ?? 0;
  const askPrice = bidAsk?.ask ?? bidPrice;
  const midPrice =
    bidPrice > 0 && askPrice > 0 ? (bidPrice + askPrice) / 2 : askPrice || bidPrice;
  const selectedPrice = priceMode === "mid" ? midPrice : askPrice;

  if (!(selectedPrice && selectedPrice > 0)) {
    console.warn(
      `No valid ${priceMode} or fallback quote for ${quoteSymbol}, skipping seed order. BidAsk:`,
      bidAsk,
    );
    return {
      accountNumber: resolvedAccountNumber,
      askPrice,
      bidPrice,
      candidateSymbol,
      dte: candidateDte,
      midPrice,
      maxDTE,
      minDTE,
      preferredDTE,
      priceMode,
      quoteSymbol,
      placedOrder: false,
      side,
      skippedReason: `candidate ${priceMode} quote unavailable`,
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback,
    };
  }

  const limitPrice = roundOrderPrice(selectedPrice);
  const numericLimitPrice = Number(limitPrice);

  if (options.maxLimitPrice !== undefined && numericLimitPrice > options.maxLimitPrice) {
    return {
      accountNumber: resolvedAccountNumber,
      askPrice,
      bidPrice,
      candidateSymbol,
      dte: candidateDte,
      limitPrice: numericLimitPrice,
      maxDTE,
      midPrice,
      minDTE,
      placedOrder: false,
      priceMode,
      preferredDTE,
      quoteSymbol,
      side,
      skippedReason: `unfavorable entry: limit price ${numericLimitPrice.toFixed(2)} > cash fill ${options.maxLimitPrice.toFixed(2)}`,
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback,
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
  const estimatedOrderCost = numericLimitPrice * DEFAULT_CONTRACT_MULTIPLIER;
  const maxSeedOrderCost = getMaxSeedOrderCost();

  if (estimatedOrderCost > maxSeedOrderCost) {
    return {
      accountNumber: resolvedAccountNumber,
      askPrice,
      bidPrice,
      buyingPowerAvailable,
      candidateSymbol,
      dte: candidateDte,
      estimatedOrderCost,
      limitPrice: numericLimitPrice,
      maxDTE,
      midPrice,
      minDTE,
      placedOrder: false,
      priceMode,
      preferredDTE,
      quoteSymbol,
      side,
      skippedReason: `seed order cost ${estimatedOrderCost.toFixed(2)} exceeds BOT_MAX_SEED_ORDER_COST ${maxSeedOrderCost.toFixed(2)}`,
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback,
    };
  }

  if (estimatedOrderCost > buyingPowerAvailable) {
    return {
      accountNumber: resolvedAccountNumber,
      askPrice,
      bidPrice,
      buyingPowerAvailable,
      candidateSymbol,
      dte: candidateDte,
      estimatedOrderCost,
      limitPrice: numericLimitPrice,
      maxDTE,
      midPrice,
      minDTE,
      placedOrder: false,
      priceMode,
      preferredDTE,
      quoteSymbol,
      side,
      skippedReason:
        "insufficient effective buying power for seed order at current time-of-day exposure target",
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback,
    };
  }

  let dryRunResponse: TastytradePlacedOrderResponse;
  try {
    dryRunResponse = await tastytradeApi.orderService.postOrderDryRun(
      resolvedAccountNumber,
      order,
    );
  } catch (error) {
    return {
      accountNumber: resolvedAccountNumber,
      askPrice,
      bidPrice,
      buyingPowerAvailable,
      candidateSymbol,
      dte: candidate?.dte != null ? Number(candidate.dte) : undefined,
      dryRunResponse:
        error instanceof Error
          ? ((error as Error & { response?: { data?: unknown } }).response?.data ?? error.message)
          : error,
      estimatedOrderCost,
      limitPrice: numericLimitPrice,
      maxDTE,
      midPrice,
      minDTE,
      placedOrder: false,
      priceMode,
      preferredDTE,
      quoteSymbol,
      side,
      skippedReason: extractDryRunSkipReason(error),
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback,
    };
  }

  const orderResponse = await tastytradeApi.orderService.createOrder(
    resolvedAccountNumber,
    order,
  );

  return {
    accountNumber: resolvedAccountNumber,
    askPrice,
    bidPrice,
    buyingPowerAvailable,
    candidateSymbol,
    dte: candidateDte,
    dryRunResponse,
    estimatedOrderCost,
    limitPrice: numericLimitPrice,
    maxDTE,
    midPrice,
    minDTE,
    priceMode,
    preferredDTE,
    quoteSymbol,
    orderResponse,
    placedOrder: true,
    side,
    strategy,
    symbol: normalizedSymbol,
    usedDteFallback,
  };
}

export default seedSymbol;