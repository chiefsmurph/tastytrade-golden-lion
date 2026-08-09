import { getAccountMarginOrCash, getCashAccountNumber, getMarginAccountNumber, isReadOnlyAccount } from "~/core/default-account";
import { getAccountBalanceNumber } from "~/core/account-balance";
import tastytradeApi from "~/core/tastytrade-client";
import { getGroupMarketValue } from "./actions/order-utils";
import { getGroupSideForPositions, type PositionGroupEvaluation } from "./evaluate-position";
import { getPositionEvaluations } from "./get-position-evaluations";
import { RunSeedOrder } from "./run-history";
import seedSymbol, { SeedSymbolResult } from "./seed-symbol";
import { MARGIN_SEED_FROM_CASH_ORDER_SOURCE, CASH_SEED_FROM_MARGIN_ORDER_SOURCE } from "./order-sources";
import { isWithinCashAccountSeedFromMarginWindow } from "~/strategy/seeding-windows";
import type { SecretSourcePosition } from "~/strategy/secret/types";
import { countGoodBooleans, getBooleanSurplusPct } from "~/strategy/position-gate";
import { recordPositionOpened, getRegistryEntry } from "./position-registry";
import { getHeldContractFallbackCandidate } from "./actions/manage-allocation";
import { recordSeedAttempt, recordSeedSkip } from "./seed-rejection-scoreboard";
import {
  getMarginSeedConfig,
  getCashSeedFromMarginConfig,
  getTimeOfDaySeedMultiplier,
  getPositionAgeSeedMultiplier,
  getPositionAgeMinutesSeedMultiplier,
  getBooleanSeedMultiplier,
  getPositionFillSeedMultiplier,
  getScaledThresholds,
  getSeedDecision,
} from "~/strategy/seed-decision";
import { getTimeOfDayExecutionTargets } from "~/strategy/evaluate-trading-strategy";

export type MarginSeedResult = RunSeedOrder;

// When no chain candidate fits the cash seed DTE window, cash may fall back to
// buying the exact contract margin holds — but only with this many days left.
const CASH_SEED_HELD_FALLBACK_MIN_DTE = 4;

export function isNoFittingSeedCandidateReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return (
    reason.startsWith("no candidate found in cash seed DTE window") ||
    reason.startsWith("cash seed candidate DTE must be within") ||
    reason === "no option candidate found" ||
    reason === "candidate quote symbol unavailable"
  );
}

// The chain candidate was too expensive for available effective buying power
// (per-action cap / exposure headroom / remaining buying power). The contract
// margin holds is often cheaper than the fresh chain pick, so these skips are
// also worth retrying via the held fallback. (The old dollar-cap "seed order
// cost …" reason was retired 2026-07-21 with BOT_MAX_SEED_ORDER_COST.)
export function isCostBlockedSeedReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return reason.startsWith("insufficient effective buying power for seed order");
}

/**
 * May this group be averaged into from the OTHER account this cycle?
 *
 * `MANAGE_ALLOCATION` alone is not enough. Several strategy paths return
 * `MANAGE_ALLOCATION` with `suppressAdds` precisely because the group must be held
 * and not added to — a scaled runner riding its remainder, a stop the midpoint
 * disputes, and (since 2026-08-08) a stop awaiting its second confirming cycle. A
 * cross-account seed is an add like any other, and before this check the two seed
 * passes only looked at `action`, so a group the local allocator was forbidden to
 * touch could still be averaged into from the far side of the book.
 */
export function isSeedEligibleEvaluation(
  evaluation: PositionGroupEvaluation,
): boolean {
  if (evaluation.strategy.action !== "MANAGE_ALLOCATION") return false;
  return evaluation.strategy.suppressAdds !== true;
}

function getAskReturnPct(evaluation: PositionGroupEvaluation): number | null {
  const fill = evaluation.metrics.weightedAverageFill;
  if (!(fill > 0)) return null;
  return ((evaluation.metrics.currentAskPrice - fill) / fill) * 100;
}

// fallow-ignore-next-line complexity
async function getPositionAgeDays(
  accountNumber: string,
  symbol: string,
  currentTime: Date,
  evaluation: PositionGroupEvaluation,
): Promise<number | null> {
  const entry = await getRegistryEntry(accountNumber, symbol);
  if (entry?.openedAt) {
    return (currentTime.getTime() - new Date(entry.openedAt).getTime()) / 86_400_000;
  }

  const createdAt = evaluation.positions[0]?.["created-at"];
  if (createdAt) {
    return (currentTime.getTime() - new Date(createdAt).getTime()) / 86_400_000;
  }

  return null;
}

// fallow-ignore-next-line complexity
function mapMarginSeedOrderForRunHistory(
  sourceAccountNumber: string,
  askReturnPctSource: number,
  result: SeedSymbolResult,
  goodBooleanScore: number | null,
  booleanSurplusPct: number | null,
  ivRank: number | null,
  decisionReason: string,
): MarginSeedResult {
  return {
    accountNumber: result.accountNumber,
    askReturnPctSource,
    booleanSurplusPct,
    candidateSymbol: result.candidateSymbol ?? null,
    estimatedOrderCost: result.estimatedOrderCost ?? null,
    goodBooleanScore,
    ivRank,
    limitPrice: result.limitPrice ?? null,
    placedOrder: result.placedOrder,
    scope: "run-cycle-margin-from-cash",
    side: result.side,
    skippedReason: result.skippedReason ?? null,
    sourceAccountNumber,
    symbol: result.symbol,
    triggerReason: `cash down ${Math.abs(askReturnPctSource).toFixed(1)}% ask — ${decisionReason}`,
  };
}

// fallow-ignore-next-line complexity
export async function maybeSeedMarginAccountFromCashAccount(
  accountNumber: string,
  currentTime: Date,
  excludedUnderlyingSymbols: ReadonlySet<string> = new Set(),
  secretPositions: readonly SecretSourcePosition[] = [],
): Promise<MarginSeedResult[]> {
  if (isReadOnlyAccount(accountNumber)) {
    return [];
  }

  const accountMarginOrCash = await getAccountMarginOrCash(accountNumber);
  if (accountMarginOrCash !== "margin") {
    return [];
  }

  if (!isWithinCashAccountSeedFromMarginWindow(currentTime)) {
    return [];
  }

  const config = getMarginSeedConfig();
  if (config === null) {
    return [];
  }

  const cashAccountNumber = await getCashAccountNumber();
  if (cashAccountNumber === accountNumber) {
    return [];
  }

  const timeFactor = getTimeOfDaySeedMultiplier(currentTime);
  const cashEvaluations = await getPositionEvaluations(cashAccountNumber);
  const localExcluded = new Set(
    Array.from(excludedUnderlyingSymbols, (s) => String(s).toUpperCase()),
  );

  const results: MarginSeedResult[] = [];

  for (const evaluation of cashEvaluations) {
    if (!isSeedEligibleEvaluation(evaluation)) continue;

    const side = getGroupSideForPositions(evaluation.positions);
    if (side !== "call" && side !== "put") continue;

    const symbol = String(evaluation.underlyingSymbol ?? "").toUpperCase();
    if (!symbol || localExcluded.has(symbol)) continue;

    const askReturnPct = getAskReturnPct(evaluation);
    if (askReturnPct === null) continue;

    const secretPosition = secretPositions.find(
      (p) => String(p.ticker ?? "").trim().toUpperCase() === symbol,
    );
    const goodBooleanScore = secretPosition != null ? countGoodBooleans(secretPosition) : null;
    const booleanSurplusPct = goodBooleanScore != null ? getBooleanSurplusPct(goodBooleanScore) : null;

    const positionAgeDays = await getPositionAgeDays(cashAccountNumber, symbol, currentTime, evaluation);
    const ageFactor = getPositionAgeSeedMultiplier(positionAgeDays);
    const booleanFactor = getBooleanSeedMultiplier(goodBooleanScore);
    const thresholds = getScaledThresholds(config, timeFactor, ageFactor, booleanFactor);

    const lossDepth = -askReturnPct;
    if (lossDepth < thresholds.minDownPct || lossDepth > thresholds.maxDownPct) continue;

    const decision = await getSeedDecision(
      symbol,
      lossDepth,
      goodBooleanScore,
      secretPosition,
      thresholds,
    );

    if (!decision.shouldSeed) {
      console.log(JSON.stringify({
        scope: "run-cycle-margin-from-cash",
        symbol,
        side,
        accountNumber,
        askReturnPct,
        lossDepth,
        positionAgeDays,
        timeFactor: +timeFactor.toFixed(3),
        ageFactor: +ageFactor.toFixed(3),
        booleanFactor: +booleanFactor.toFixed(3),
        thresholds,
        goodBooleanScore,
        ivRank: decision.ivRank,
        gated: true,
        gateReason: decision.reason,
      }));
      recordSeedSkip(accountNumber, `seed gate: ${decision.reason}`, { symbol });
      continue;
    }

    const cashFill = evaluation.metrics.weightedAverageFill;
    const result = await seedSymbol(evaluation.underlyingSymbol, side, accountNumber, {
      orderSource: MARGIN_SEED_FROM_CASH_ORDER_SOURCE,
      maxLimitPrice: cashFill > 0 ? cashFill : undefined,
    });
    recordSeedAttempt(accountNumber, result, { symbol });

    if (result.placedOrder) {
      await recordPositionOpened(accountNumber, symbol, side);
    }

    const seedOrder = mapMarginSeedOrderForRunHistory(
      cashAccountNumber,
      askReturnPct,
      result,
      goodBooleanScore,
      booleanSurplusPct,
      decision.ivRank,
      decision.reason,
    );

    console.log(JSON.stringify({
      scope: "run-cycle-margin-from-cash",
      symbol,
      side,
      accountNumber,
      askReturnPct,
      lossDepth,
      positionAgeDays,
      timeFactor: +timeFactor.toFixed(3),
      ageFactor: +ageFactor.toFixed(3),
      thresholds,
      goodBooleanScore,
      booleanSurplusPct,
      ivRank: decision.ivRank,
      decisionReason: decision.reason,
      placedOrder: result.placedOrder,
      skippedReason: result.skippedReason ?? null,
      candidateSymbol: result.candidateSymbol ?? null,
      limitPrice: result.limitPrice ?? null,
      estimatedOrderCost: result.estimatedOrderCost ?? null,
    }));

    results.push(seedOrder);
  }

  return results;
}

// fallow-ignore-next-line complexity
export async function maybeSeedCashAccountFromMarginAccount(
  accountNumber: string,
  currentTime: Date,
  excludedUnderlyingSymbols: ReadonlySet<string> = new Set(),
  secretPositions: readonly SecretSourcePosition[] = [],
): Promise<MarginSeedResult[]> {
  if (isReadOnlyAccount(accountNumber)) return [];

  const accountMarginOrCash = await getAccountMarginOrCash(accountNumber);
  if (accountMarginOrCash !== "cash") return [];

  if (!isWithinCashAccountSeedFromMarginWindow(currentTime)) return [];

  const config = getCashSeedFromMarginConfig();
  if (config === null) return [];

  const marginAccountNumber = await getMarginAccountNumber();
  if (marginAccountNumber === accountNumber) return [];

  const timeFactor = getTimeOfDaySeedMultiplier(currentTime);

  const [marginEvaluations, marginBalance] = await Promise.all([
    getPositionEvaluations(marginAccountNumber),
    tastytradeApi.balancesAndPositionsService.getAccountBalanceValues(marginAccountNumber),
  ]);
  const marginNetLiq = getAccountBalanceNumber(marginBalance, "net-liquidating-value");

  const localExcluded = new Set(
    Array.from(excludedUnderlyingSymbols, (s) => String(s).toUpperCase()),
  );

  const results: MarginSeedResult[] = [];

  for (const evaluation of marginEvaluations) {
    if (!isSeedEligibleEvaluation(evaluation)) continue;

    const side = getGroupSideForPositions(evaluation.positions);
    if (side !== "call" && side !== "put") continue;

    const symbol = String(evaluation.underlyingSymbol ?? "").toUpperCase();
    if (!symbol || localExcluded.has(symbol)) continue;

    const askReturnPct = getAskReturnPct(evaluation);
    if (askReturnPct === null) continue;

    const secretPosition = secretPositions.find(
      (p) => String(p.ticker ?? "").trim().toUpperCase() === symbol,
    );
    const goodBooleanScore = secretPosition != null ? countGoodBooleans(secretPosition) : null;
    const booleanSurplusPct = goodBooleanScore != null ? getBooleanSurplusPct(goodBooleanScore) : null;

    const positionAgeDays = await getPositionAgeDays(marginAccountNumber, symbol, currentTime, evaluation);
    const positionAgeMinutes = positionAgeDays !== null ? positionAgeDays * 24 * 60 : null;
    const ageFactor = getPositionAgeMinutesSeedMultiplier(positionAgeMinutes);

    const positionMarketValue = getGroupMarketValue(evaluation.positionSnapshots);
    const pctOfNetLiq = marginNetLiq > 0 ? positionMarketValue / marginNetLiq : 0;

    // How full the margin position is vs. its exposure target: cash holds back
    // while margin still has room to average down on its own, and gets more
    // willing as margin approaches full deployment on the name.
    const targetExposurePct =
      evaluation.executionTargets?.targetAccountExposure ??
      getTimeOfDayExecutionTargets(currentTime, "margin").targetAccountExposure;
    const fillRatio = targetExposurePct > 0 ? pctOfNetLiq / targetExposurePct : null;
    const fillFactor = getPositionFillSeedMultiplier(fillRatio);

    const booleanFactor = getBooleanSeedMultiplier(goodBooleanScore);
    const thresholds = getScaledThresholds(config, timeFactor, ageFactor, booleanFactor, fillFactor);

    const lossDepth = -askReturnPct;
    if (lossDepth < thresholds.minDownPct || lossDepth > thresholds.maxDownPct) continue;

    const decision = await getSeedDecision(symbol, lossDepth, goodBooleanScore, secretPosition, thresholds);

    if (!decision.shouldSeed) {
      console.log(JSON.stringify({
        scope: "run-cycle-cash-from-margin",
        symbol,
        side,
        accountNumber,
        askReturnPct,
        lossDepth,
        positionAgeMinutes: positionAgeMinutes !== null ? +positionAgeMinutes.toFixed(1) : null,
        pctOfNetLiq: +pctOfNetLiq.toFixed(4),
        fillRatio: fillRatio !== null ? +fillRatio.toFixed(3) : null,
        timeFactor: +timeFactor.toFixed(3),
        ageFactor: +ageFactor.toFixed(3),
        booleanFactor: +booleanFactor.toFixed(3),
        fillFactor: +fillFactor.toFixed(3),
        thresholds,
        goodBooleanScore,
        ivRank: decision.ivRank,
        gated: true,
        gateReason: decision.reason,
      }));
      recordSeedSkip(accountNumber, `seed gate: ${decision.reason}`, { symbol });
      continue;
    }

    let result = await seedSymbol(evaluation.underlyingSymbol, side, accountNumber, {
      orderSource: CASH_SEED_FROM_MARGIN_ORDER_SOURCE,
    });

    // No chain candidate fits the cash seed DTE window, or the candidate was too
    // expensive — fall back to the exact contract margin holds (often cheaper),
    // as long as it has enough days left and passes the spread gate applied by
    // getHeldContractFallbackCandidate. The fallback seedSymbol call re-applies
    // every cost check, so a too-expensive held contract still gets skipped.
    if (
      !result.placedOrder &&
      (isNoFittingSeedCandidateReason(result.skippedReason) ||
        isCostBlockedSeedReason(result.skippedReason))
    ) {
      const held = getHeldContractFallbackCandidate(evaluation, "cash", currentTime);
      const heldDte = typeof held.dte === "number" ? held.dte : null;

      if (held.symbol && heldDte !== null && heldDte >= CASH_SEED_HELD_FALLBACK_MIN_DTE) {
        console.log(JSON.stringify({
          scope: "run-cycle-cash-from-margin-held-fallback",
          symbol,
          heldContract: held.symbol,
          heldDte,
          minDte: CASH_SEED_HELD_FALLBACK_MIN_DTE,
          originalSkippedReason: result.skippedReason,
        }));
        result = await seedSymbol(evaluation.underlyingSymbol, side, accountNumber, {
          orderSource: CASH_SEED_FROM_MARGIN_ORDER_SOURCE,
          explicitContract: {
            symbol: held.symbol,
            quoteSymbol: held.quoteSymbol,
            dte: heldDte,
          },
        });
      } else {
        console.log(JSON.stringify({
          scope: "run-cycle-cash-from-margin-held-fallback",
          symbol,
          heldContract: held.symbol ?? null,
          heldDte,
          minDte: CASH_SEED_HELD_FALLBACK_MIN_DTE,
          gated: true,
          gateReason:
            held.skippedReason ??
            (heldDte !== null
              ? `held contract has ${heldDte} DTE < ${CASH_SEED_HELD_FALLBACK_MIN_DTE} min`
              : "held contract DTE unavailable"),
        }));
      }
    }

    recordSeedAttempt(accountNumber, result, { symbol });

    if (result.placedOrder) {
      await recordPositionOpened(accountNumber, symbol, side);
    }

    const seedOrder: MarginSeedResult = {
      accountNumber: result.accountNumber,
      askReturnPctSource: askReturnPct,
      booleanSurplusPct,
      candidateSymbol: result.candidateSymbol ?? null,
      estimatedOrderCost: result.estimatedOrderCost ?? null,
      goodBooleanScore,
      ivRank: decision.ivRank,
      limitPrice: result.limitPrice ?? null,
      placedOrder: result.placedOrder,
      scope: "run-cycle-cash-from-margin",
      side: result.side,
      skippedReason: result.skippedReason ?? null,
      sourceAccountNumber: marginAccountNumber,
      symbol: result.symbol,
      triggerReason: `margin down ${Math.abs(askReturnPct).toFixed(1)}% ask (${positionAgeMinutes !== null ? positionAgeMinutes.toFixed(0) + "min old" : "age unknown"}) — ${decision.reason}`,
    };

    console.log(JSON.stringify({
      scope: "run-cycle-cash-from-margin",
      symbol,
      side,
      accountNumber,
      askReturnPct,
      lossDepth,
      positionAgeMinutes: positionAgeMinutes !== null ? +positionAgeMinutes.toFixed(1) : null,
      pctOfNetLiq: +pctOfNetLiq.toFixed(4),
      fillRatio: fillRatio !== null ? +fillRatio.toFixed(3) : null,
      timeFactor: +timeFactor.toFixed(3),
      ageFactor: +ageFactor.toFixed(3),
      fillFactor: +fillFactor.toFixed(3),
      thresholds,
      goodBooleanScore,
      booleanSurplusPct,
      ivRank: decision.ivRank,
      decisionReason: decision.reason,
      placedOrder: result.placedOrder,
      usedHeldContractFallback: result.usedHeldContractFallback ?? false,
      skippedReason: result.skippedReason ?? null,
      candidateSymbol: result.candidateSymbol ?? null,
      limitPrice: result.limitPrice ?? null,
      estimatedOrderCost: result.estimatedOrderCost ?? null,
    }));

    results.push(seedOrder);
  }

  return results;
}
