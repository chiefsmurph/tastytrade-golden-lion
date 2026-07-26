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
import {
  getSeedSizingFloorPct,
  getSeedSizingCeilingPct,
} from "~/strategy/seed-sizing-model";
import {
  getMarginMaxTotalUtilization,
  resolveSeedQuantity,
} from "~/strategy/seed-sizing-live";
import { governorFactorForEnabled } from "~/strategy/position-gate";


export interface SeedSymbolOptions {
  priceMode?: "ask" | "mid";
  orderSource?: string;
  // Add-governor knife mult (0.35–1.0) from the feed position. Cash seeds fade
  // toward the floor by it; margin is hard-blocked upstream so it's inert here.
  governorMult?: number;
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
// affordability check skips if its cost exceeds available buying power — so a
// near-broke account skips forever even when cheaper strikes exist in the same
// chain. Returns the binding cap (effective buying power, in order-cost dollars)
// to re-run selection with as maxAskPrice, or null when no retry should happen:
// already the retry pass, an explicit contract (nothing cheaper to hunt for), or
// a nonsensical cap. NB: the only remaining dollar bound is the broker's real
// buying power — there is no tunable dollar knob (BOT_MAX_SEED_ORDER_COST was
// retired; size is governed entirely by the %-of-NLV band + %-caps).
export function getAffordabilityRetryCap(
  estimatedOrderCost: number,
  buyingPowerAvailable: number,
  alreadyRetried: boolean,
  hasExplicitContract: boolean,
): number | null {
  if (alreadyRetried || hasExplicitContract) {
    return null;
  }
  if (!Number.isFinite(buyingPowerAvailable) || buyingPowerAvailable <= 0) {
    return null;
  }
  if (buyingPowerAvailable >= estimatedOrderCost) {
    return null;
  }
  return buyingPowerAvailable;
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

// Current market value of a single position (dollars). mark-price is the
// broker's per-unit mark; multiplier is shares/contract (100 for options).
// Falls back to close-price then average-open-price when mark is absent, so a
// stale feed can't read as $0 exposure. Always non-negative (we only ever
// LONG-open seeds; short legs would sign-flip but the bot doesn't open them).
export function getPositionMarketValue(position: CurrentPosition): number {
  const quantity = Math.abs(Number(position.quantity) || 0);
  if (quantity === 0) return 0;
  const multiplier = Math.abs(Number(position.multiplier) || 1);
  const markPrice = Number(position["mark-price"]);
  const closePrice = Number(position["close-price"]);
  const averageOpen = Number(position["average-open-price"]);
  const perUnit = Number.isFinite(markPrice) && markPrice > 0
    ? markPrice
    : Number.isFinite(closePrice) && closePrice > 0
      ? closePrice
      : Number.isFinite(averageOpen) && averageOpen > 0
        ? averageOpen
        : 0;
  return quantity * multiplier * perUnit;
}

// Sum the market value of every non-zero position in a list that matches the
// underlying (undefined `symbol` sums ALL positions → total account option
// exposure, used by the margin-utilization rail).
export function sumPositionExposure(
  positions: CurrentPosition[],
  symbol?: string,
): number {
  const wanted = symbol?.toUpperCase();
  const matches = (position: CurrentPosition): boolean => {
    if ((Number(position.quantity) || 0) === 0) return false;
    if (!wanted) return true;
    return getUnderlyingSymbolForPosition(position).toUpperCase() === wanted;
  };
  return positions
    .filter(matches)
    .reduce((sum, position) => sum + getPositionMarketValue(position), 0);
}

interface SeedExposureSnapshot {
  // Market value of `symbol` already held in the seeding account.
  existingAccountExposure: number;
  // Market value of `symbol` held across BOTH cash + margin accounts.
  existingCombinedExposure: number;
  // Summed market value of ALL open margin option positions (leverage rail).
  marginTotalOptionExposure: number;
}

// Pure: compute the three exposures the live sizing rails need from already-
// fetched position lists. `sameAccount` = cash and margin resolve to the same
// account (single-account configs) → the combined figure must not double-count.
export function computeSeedExposures(params: {
  symbol: string;
  seedingPositions: CurrentPosition[];
  cashPositions: CurrentPosition[];
  marginPositions: CurrentPosition[];
  sameAccount: boolean;
}): SeedExposureSnapshot {
  const cashExposure = sumPositionExposure(params.cashPositions, params.symbol);
  const marginExposure = sumPositionExposure(params.marginPositions, params.symbol);
  return {
    existingAccountExposure: sumPositionExposure(params.seedingPositions, params.symbol),
    existingCombinedExposure: params.sameAccount ? cashExposure : cashExposure + marginExposure,
    marginTotalOptionExposure: sumPositionExposure(params.marginPositions),
  };
}

// Gather the exposures the live sizing rails need. One positions-list fetch per
// distinct account (cash + margin + seeding), reused for the per-underlying,
// combined, and margin-total figures.
async function getSeedExposureSnapshot(
  seedingAccountNumber: string,
  symbol: string,
): Promise<SeedExposureSnapshot> {
  const cashAccountNumber = await getCashAccountNumber();
  const marginAccountNumber = await getMarginAccountNumber();

  const uniqueAccounts = Array.from(
    new Set([cashAccountNumber, marginAccountNumber, seedingAccountNumber]),
  );
  const fetched = await Promise.all(
    uniqueAccounts.map((accountNumber) => fetchPositions(accountNumber)),
  );
  const positionsByAccount = new Map(fetched);

  return computeSeedExposures({
    symbol,
    seedingPositions: positionsByAccount.get(seedingAccountNumber) ?? [],
    cashPositions: positionsByAccount.get(cashAccountNumber) ?? [],
    marginPositions: positionsByAccount.get(marginAccountNumber) ?? [],
    sameAccount: cashAccountNumber === marginAccountNumber,
  });
}

async function fetchPositions(
  accountNumber: string,
): Promise<[string, CurrentPosition[]]> {
  const positions =
    await tastytradeApi.balancesAndPositionsService.getPositionsList(accountNumber);
  return [accountNumber, positions ?? []];
}

// Fetch exposures, run the live %-of-account sizing model + rails, and emit the
// `seed-sizing-live` telemetry line. Extracted from seedSymbol to keep that
// function lean; returns the resolved sizing (quantity + diagnostics).
async function computeLiveSeedSizing(params: {
  symbol: string;
  side: "call" | "put";
  accountNumber: string;
  accountType: "margin" | "cash" | "unknown";
  accountNLV: number;
  optionPrice: number;
  optionLiquidityQuality?: number;
  governorMult?: number;
}): Promise<ReturnType<typeof resolveSeedQuantity>> {
  const exposure = await getSeedExposureSnapshot(params.accountNumber, params.symbol);
  // Cash-soft governor: fade the seed toward the floor on a knife (margin is
  // hard-blocked upstream, so it never fades here — factor stays 1). A missing mult
  // (NaN) clamps to neutral downstream. Dark until STRATEGY_GOVERNOR_ENABLED.
  const governorFactor =
    params.accountType === "cash"
      ? governorFactorForEnabled(Number(params.governorMult), "cash")
      : 1;
  const sizing = resolveSeedQuantity({
    accountNLV: params.accountNLV,
    optionPrice: params.optionPrice,
    optionLiquidityQuality: params.optionLiquidityQuality,
    governorFactor,
    accountType: params.accountType === "cash" ? "cash" : "margin",
    concentrationBasis: params.accountNLV,
    existingAccountExposure: exposure.existingAccountExposure,
    existingCombinedExposure: exposure.existingCombinedExposure,
    marginTotalOptionExposure: exposure.marginTotalOptionExposure,
  });

  console.log(
    JSON.stringify({
      scope: "seed-sizing-live",
      symbol: params.symbol,
      side: params.side,
      accountNumber: params.accountNumber,
      accountType: params.accountType,
      accountNLV: params.accountNLV,
      optionPrice: params.optionPrice,
      optionLiquidityQuality: sizing.optionLiquidityQuality,
      governorMult: params.governorMult,
      governorFactor,
      modelTargetPct: sizing.modelTargetPct,
      modelContracts: sizing.modelContracts,
      quantity: sizing.quantity,
      flooredToOne: sizing.flooredToOne,
      bindingRail: sizing.bindingRail,
      estimatedOrderCost: sizing.orderCost,
      floorPct: getSeedSizingFloorPct(),
      ceilingPct: getSeedSizingCeilingPct(),
      marginMaxTotalUtilization: getMarginMaxTotalUtilization(),
      existingAccountExposure: exposure.existingAccountExposure,
      existingCombinedExposure: exposure.existingCombinedExposure,
      marginTotalOptionExposure: exposure.marginTotalOptionExposure,
      perUnderlyingCapContracts: sizing.perUnderlyingCapContracts,
      combinedCapContracts: sizing.combinedCapContracts,
      marginUtilizationContracts: sizing.marginUtilizationContracts,
      blockedReason: sizing.blockedReason ?? null,
    }),
  );

  return sizing;
}

// Attempt to spray a multi-contract seed via the front-loaded spray primitive.
// Cash-only + flag-gated (self-guarded by startSprayBuy). An explicit
// sprayContracts option can request MORE than the model sized (legacy callers),
// so the target is the larger of the two. Returns true when the spray fired (the
// seed is placed); false to fall through to the caller's single-order path.
// Pure: the spray target for a seed. An explicit sprayContracts option can
// request MORE than the model sized (legacy callers), so take the larger.
export function resolveSprayTarget(
  seedQuantity: number,
  sprayContractsOption: number | undefined,
): number {
  return Math.max(seedQuantity, Math.floor(sprayContractsOption ?? 0));
}

// Pure: whether a seed of this size should route through the spray primitive
// (multi-contract, cash account, flag on).
export function shouldSpraySeed(
  sprayTarget: number,
  accountType: "margin" | "cash" | "unknown",
): boolean {
  return sprayTarget > 1 && accountType === "cash" && isSprayBuyEnabled();
}

async function trySpraySeed(params: {
  seedQuantity: number;
  sprayContractsOption: number | undefined;
  accountType: "margin" | "cash" | "unknown";
  accountNumber: string;
  symbol: string;
  contractSymbol: string;
  // dxLink streamer symbol for the chase's live bid/ask read. MUST be forwarded:
  // the streamer can't resolve an OCC contract symbol, so without this the chase
  // never gets a quote and the spray aborts as "no-quote" (see spray-buy.ts).
  quoteSymbol?: string;
  side: "call" | "put";
  limitPrice: number;
  orderSource: string;
}): Promise<boolean> {
  const sprayContracts = resolveSprayTarget(params.seedQuantity, params.sprayContractsOption);
  if (!shouldSpraySeed(sprayContracts, params.accountType)) {
    return false;
  }
  const sprayResult = await startSprayBuy({
    accountNumber: params.accountNumber,
    symbol: params.symbol,
    contractSymbol: params.contractSymbol,
    quoteSymbol: params.quoteSymbol,
    side: params.side,
    totalContracts: sprayContracts,
    limitPrice: params.limitPrice,
    orderSource: params.orderSource,
  });
  if (!sprayResult.started) {
    // Spray declined (flag flipped off mid-flight, invalid target) — caller
    // falls through to the normal single-order path so the seed still lands.
    return false;
  }
  console.log(
    JSON.stringify({
      scope: "seed-symbol-spray-buy",
      symbol: params.symbol,
      side: params.side,
      contractSymbol: params.contractSymbol,
      totalContracts: sprayContracts,
      scheduledSlices: sprayResult.scheduledSlices,
      firstSliceOrderId: sprayResult.firstSliceOrderId,
      sprayId: sprayResult.sprayId,
    }),
  );
  return true;
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

// Guards the order against the broker's real effective buying power (the only
// remaining dollar bound — the size itself is governed by the %-of-NLV band +
// %-caps upstream). Returns a skip result to return, or null to continue.
export function checkSeedAffordability(
  estimatedOrderCost: number,
  buyingPowerAvailable: number,
  buyingPowerSummary: Awaited<ReturnType<typeof getEffectiveBuyingPowerSummary>>,
  costResult: SeedSymbolResult,
): SeedSymbolResult | null {
  if (estimatedOrderCost > buyingPowerAvailable) {
    return {
      ...costResult,
      skippedReason: `insufficient effective buying power for seed order — ${describeEffectiveBuyingPowerLimit(buyingPowerSummary)}, order cost ${estimatedOrderCost.toFixed(2)}`,
    };
  }
  return null;
}

// Exported via the default export below; consumers all use the default import,
// so the function itself is not a named export (keeps fallow's dead-export
// analysis honest).
// fallow-ignore-next-line complexity
async function seedSymbol(
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

  const buyingPowerSummary = await getEffectiveBuyingPowerSummary(
    resolvedAccountNumber,
    new Date(),
    { bypassCashAccountCap: true },
  );
  const buyingPowerAvailable = buyingPowerSummary.effectiveBuyingPower;
  const accountNLV = buyingPowerSummary.totalCapital;

  // LIVE %-of-account sizing (2026-07-21). Drives the REAL order quantity: the
  // floor..ceiling NLV band × the candidate's optionLiquidityQuality (regime
  // left neutral — regime is Stage 2's growth lever, not the seed), then clamped
  // by the concentration caps + the total-margin-utilization leverage rail, then
  // floored to at least 1 contract (never sizes DOWN vs the old quantity: 1
  // unless a hard rail demands 0). Every limit is a %-of-NLV — no dollar knob.
  const sizing = await computeLiveSeedSizing({
    symbol: normalizedSymbol,
    side,
    accountNumber: resolvedAccountNumber,
    accountType: resolvedAccountType,
    accountNLV,
    optionPrice: numericLimitPrice,
    optionLiquidityQuality: candidate?.optionLiquidityQuality,
    governorMult: options.governorMult,
  });
  const seedQuantity = sizing.quantity;
  const estimatedOrderCost = seedQuantity * numericLimitPrice * 100;

  // Base extended with cost/limit data; used by the remaining returns.
  const costResult: SeedSymbolResult = {
    ...pricedResult,
    buyingPowerAvailable,
    estimatedOrderCost,
    limitPrice: numericLimitPrice,
  };

  // A hard rail (concentration cap / margin-leverage ceiling already breached)
  // sized the seed to 0. Skip — a genuine "do not add", not an affordability
  // retry candidate.
  if (seedQuantity < 1) {
    return {
      ...costResult,
      skippedReason: sizing.blockedReason ?? "seed sizing resolved to zero contracts",
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
        quantity: seedQuantity,
        "instrument-type": normalizeInstrumentType("Equity Option"),
      },
    ],
  };

  const affordabilitySkip = checkSeedAffordability(
    estimatedOrderCost,
    buyingPowerAvailable,
    buyingPowerSummary,
    costResult,
  );
  if (affordabilitySkip) {
    // The primary pick exceeded buying power, but a cheaper strike may exist in
    // the same chain. Re-run the whole seed once with the binding cap as a
    // selection-level ask filter. If the retry cannot place, return the
    // ORIGINAL skip — its reason string is load-bearing (run-cycle-seed's
    // held-contract fallback matches it verbatim).
    const retryCap = getAffordabilityRetryCap(
      estimatedOrderCost,
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

  // Spray-buy (cash accounts only, flag-gated): when the MODEL-SIZED quantity is
  // more than one contract, hand the acquisition to the front-loaded spray
  // primitive instead of placing one big clip. Returns true when it fired (the
  // seed has landed), false to fall through to the normal single-order path.
  const sprayed = await trySpraySeed({
    seedQuantity,
    sprayContractsOption: options.sprayContracts,
    accountType: resolvedAccountType,
    accountNumber: resolvedAccountNumber,
    symbol: normalizedSymbol,
    contractSymbol: candidateSymbol,
    quoteSymbol,
    side,
    limitPrice: numericLimitPrice,
    orderSource,
  });
  if (sprayed) {
    return {
      ...costResult,
      dryRunResponse,
      placedOrder: true,
      usedHeldContractFallback: explicitContract ? true : undefined,
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