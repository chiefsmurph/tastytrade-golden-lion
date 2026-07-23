import tastytradeApi from "~/core/tastytrade-client";
import { getUnderlyingPrice } from "~/core/market-data";
import {
  getDefaultAccountNumber,
  getAccountMarginOrCash,
  getCashAccountNumber,
  getMarginAccountNumber,
  isReadOnlyAccount,
} from "~/core/default-account";
import { computePositionGate, countGoodBooleans, getBooleanSurplusPct, getMarginTargetMultiplier, getCrossAccountThresholdMultiplier, getRegimePostureMult } from "~/strategy/position-gate";
import { getMarginDipTargetBoostPct } from "~/strategy/risk-limits";
import {
  getEffectiveTotalCapital,
  getSpendableFundsForAccountType,
} from "~/core/account-balance";
import { TastytradeAccountBalance } from "~/core/types";
import type { SecretSourcePosition } from "~/strategy/secret/types";
import { getPositionEvaluations } from "./get-position-evaluations";
import {
  applyPositionSizeWeightCaps,
  averageExecutionTargets,
  getDynamicTakeProfitTarget,
  getTimeOfDayExecutionTargets,
} from "~/strategy/evaluate-trading-strategy";
import {
  getRecentRunHistory,
  RunGroupReturn,
  RunPlanSelectedGroup,
  RunPlanRow,
  RunStrategyDecision,
} from "./run-history";
import {
  buildInitialBudget,
  getUpdatedBudgetAfterAllocation,
  manageAllocationForGroup,
} from "./actions/manage-allocation";
import { getDoNotTouchGroupKeys, isEvaluationDoNotTouch } from "./do-not-touch-groups";
import { computePerLegReturnBreakdown } from "./per-leg-returns";
import { computeUnderlyingStabilization } from "./underlying-stabilization";
import { PositionGroupEvaluation } from "./evaluate-position";
import { selectManageEvaluationsByBuyingPower } from "./group-allocation-priority";
import {
  getCachedSecretRegime,
  getCachedSecretSourcePositions,
  getSecretPositionSignalsForSymbol,
  getSecretSocketStatus,
  startSecretSocketConnection,
} from "~/strategy/secret";
import { buildGroupExecutionTargets } from "~/strategy/group-execution-targets";

export interface RunCyclePreview {
  accountNumber: string;
  groups: RunGroupReturn[];
  plan: {
    diagnostics: {
      currentReturnPct: number;
      groupKey?: string;
      skippedReason: string;
      strategyAction: "MANAGE_ALLOCATION" | "CLOSE_POSITION";
      underlyingSymbol: string;
    }[];
    ignoredGroups: RunPlanSelectedGroup[];
    rows: RunPlanRow[];
    selectedGroups: RunPlanSelectedGroup[];
    unselectedGroups: RunPlanSelectedGroup[];
    totalContracts: number;
    totalEstimatedCost: number;
  };
  snapshot: {
    dynamicTakeProfitTarget: number;
    currentExposurePct: number;
    currentExposureValue: number;
    readOnly: boolean;
    secondsSinceLastPositionsUpdate: number | null;
    routeWeights: {
      ask: number;
      bid: number;
      mid: number;
    };
    targetDTE: number;
    targetExposurePct: number;
    targetExposureValue: number;
    totalCapital: number;
  };
  strategySummary: {
    closePositionCount: number;
    manageAllocationCount: number;
  };
}

export interface MultiAccountRunCyclePreview {
  accounts: RunCyclePreview[];
}

export type RunCycleContext = {
  accountBalances: TastytradeAccountBalance;
  accountMarginOrCash: "margin" | "cash" | "unknown";
  baseExecutionTargets: {
    askWeight: number;
    bidWeight: number;
    midWeight: number;
    targetAccountExposure: number;
    targetDTE: number;
  };
  cachedSecretPositions: SecretSourcePosition[];
  completedEvaluations: PositionGroupEvaluation[];
  evaluationsWithGroupTargets: PositionGroupEvaluation[];
  preview: RunCyclePreview;
  runExecutionTargets: {
    askWeight: number;
    bidWeight: number;
    midWeight: number;
    targetAccountExposure: number;
    targetDTE: number;
  };
  strategyDecisions: RunStrategyDecision[];
};


// fallow-ignore-next-line complexity
function toRunPlanSelectedGroup(
  evaluation: PositionGroupEvaluation,
  rank: number,
  fallbackTargetDTE: number,
): RunPlanSelectedGroup {
  return {
    askWeight: evaluation.executionTargets?.askWeight ?? 0,
    bidWeight: evaluation.executionTargets?.bidWeight ?? 0,
    currentReturnPct: evaluation.currentReturn,
    groupKey: evaluation.groupKey,
    midWeight: evaluation.executionTargets?.midWeight ?? 0,
    rank,
    secretBuyWeight: evaluation.secretBuyWeight ?? null,
    strategyAction: evaluation.strategy.action,
    targetAccountExposure:
      evaluation.executionTargets?.targetAccountExposure ?? 0,
    targetDTE: evaluation.executionTargets?.targetDTE ?? fallbackTargetDTE,
    underlyingSymbol: evaluation.underlyingSymbol,
  };
}

// fallow-ignore-next-line complexity
function computeGroupReturns(
  completedEvaluations: PositionGroupEvaluation[],
  gatedEvaluations: PositionGroupEvaluation[] = [],
  underlyingPrices: Map<string, number | null> = new Map(),
): RunGroupReturn[] {
  const gateBySymbol = new Map(
    gatedEvaluations.map((e) => [
      e.underlyingSymbol.toUpperCase(),
      e.executionTargets?.positionGate ?? null,
    ]),
  );

  // fallow-ignore-next-line complexity
  return completedEvaluations.map((evaluation) => {
    const secretSignals = getSecretPositionSignalsForSymbol(evaluation.underlyingSymbol);
    const firstSymbol = String(evaluation.positions[0]?.symbol ?? "").trim();
    const sideMatch = firstSymbol.match(/([CP])(\d+)$/i);
    const side: "call" | "put" | "none" = sideMatch
      ? sideMatch[1].toUpperCase() === "P"
        ? "put"
        : "call"
      : "none";

    const weightedAverageFill = evaluation.metrics.weightedAverageFill;
    const totalQuantityWeight = evaluation.positionSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.quantityWeight,
      0,
    );
    const totalCostBasis = weightedAverageFill * totalQuantityWeight;
    const bidReturnPct =
      weightedAverageFill > 0
        ? (evaluation.metrics.currentBidPrice - weightedAverageFill) /
          weightedAverageFill
        : 0;
    const askReturnPct =
      weightedAverageFill > 0
        ? (evaluation.metrics.currentAskPrice - weightedAverageFill) /
          weightedAverageFill
        : 0;
    const totalUnrealizedReturnBid =
      (evaluation.metrics.currentBidPrice - weightedAverageFill) *
      totalQuantityWeight;
    const totalUnrealizedReturnAsk =
      (evaluation.metrics.currentAskPrice - weightedAverageFill) *
      totalQuantityWeight;

    // Diagnostic (v7 #2): a UNDERLYING::side group can span multiple
    // expirations, and the blended group return hides a collapsing short-dated
    // leg behind a profitable long-dated one. Log the per-expiration breakdown
    // and flag a return spread >= 20pp — precursor to per-expiration circuit
    // breakers (v5 strategy #5). Log-only.
    const legBreakdown = computePerLegReturnBreakdown(evaluation.positionSnapshots);
    if (legBreakdown.spansMultipleExpirations) {
      console.log(
        JSON.stringify({
          scope: "group-per-leg-returns",
          underlyingSymbol: evaluation.underlyingSymbol,
          side,
          blendedBidReturnPct: Number(bidReturnPct.toFixed(4)),
          returnSpreadPct: Number(legBreakdown.returnSpreadPct.toFixed(4)),
          spreadFlag: legBreakdown.returnSpreadPct >= 0.2,
          legs: legBreakdown.legs.map((leg) => ({
            expiration: leg.expiration,
            returnPct: Number(leg.returnPct.toFixed(4)),
            quantityWeight: leg.quantityWeight,
          })),
        }),
      );
    }

    const legWeightedFills: Record<string, number> = {};
    for (const snapshot of evaluation.positionSnapshots) {
      const sym = String(snapshot.position.symbol ?? "").trim();
      if (sym && snapshot.weightedAverageFill > 0) {
        legWeightedFills[sym] = snapshot.weightedAverageFill;
      }
    }

    return {
      askReturnPct,
      bidReturnPct,
      positionGate: gateBySymbol.get(evaluation.underlyingSymbol.toUpperCase()) ?? null,
      currentReturnPct: evaluation.currentReturn,
      buyWeight: evaluation.secretBuyWeight ?? null,
      daytradeScore: secretSignals?.daytradeScore ?? null,
      returnPerc: secretSignals?.returnPerc ?? null,
      superRecScore: secretSignals?.superRecScore ?? null,
      side,
      totalCostBasis,
      totalUnrealizedReturnAsk,
      totalUnrealizedReturnBid,
      underlyingPriceAtCycleTime: underlyingPrices.get(evaluation.underlyingSymbol.toUpperCase()) ?? null,
      underlyingSymbol: evaluation.underlyingSymbol,
      weightedAverageFill,
      legWeightedFills,
    };
  });
}

function computeStrategyDecisions(
  completedEvaluations: PositionGroupEvaluation[],
): RunStrategyDecision[] {
  return completedEvaluations
    .map((evaluation) => ({
      currentReturnPct: evaluation.currentReturn,
      reason: evaluation.strategy.reason,
      strategyAction: evaluation.strategy.action,
      underlyingSymbol: evaluation.underlyingSymbol,
    }))
    .sort((left, right) => {
      if (left.underlyingSymbol !== right.underlyingSymbol) {
        return left.underlyingSymbol.localeCompare(right.underlyingSymbol);
      }

      return left.strategyAction.localeCompare(right.strategyAction);
    });
}

export function normalizeGroupExecutionTargetExposures(
  evaluations: PositionGroupEvaluation[],
  totalTargetExposure: number,
): PositionGroupEvaluation[] {
  const roundToTwoDecimals = (value: number): number =>
    Math.round(value * 100) / 100;

  const totalRawExposure = evaluations.reduce(
    (sum, evaluation) => sum + (evaluation.executionTargets?.targetAccountExposure ?? 0),
    0,
  );

  if (!(totalRawExposure > 0) || !(totalTargetExposure > 0)) {
    return evaluations;
  }

  let allocatedExposure = 0;

  return evaluations.map((evaluation, index) => {
    const executionTargets = evaluation.executionTargets;
    if (!executionTargets) {
      return evaluation;
    }

    const normalizedExposure =
      index === evaluations.length - 1
        ? roundToTwoDecimals(totalTargetExposure - allocatedExposure)
        : roundToTwoDecimals(
            totalTargetExposure *
              (executionTargets.targetAccountExposure / totalRawExposure),
          );

    allocatedExposure += normalizedExposure;

    return {
      ...evaluation,
      executionTargets: {
        ...executionTargets,
        targetAccountExposure: normalizedExposure,
      },
    };
  });
}

// fallow-ignore-next-line complexity
export async function buildRunCycleContext(
  accountNumber?: string,
): Promise<RunCycleContext> {
  const resolvedAccountNumber =
    accountNumber ?? (await getDefaultAccountNumber());
  const readOnly = isReadOnlyAccount(resolvedAccountNumber);

  const accountBalances: TastytradeAccountBalance =
    await tastytradeApi.balancesAndPositionsService.getAccountBalanceValues(
      resolvedAccountNumber,
    );
  const accountMarginOrCash = await getAccountMarginOrCash(resolvedAccountNumber);

  // Summary only — the full accountBalances blob is 65 lines with 36 fields
  // permanently "0.0" (crypto/futures/bonds/etc). ~13.4K lines/day saved.
  console.log(
    JSON.stringify({
      scope: "account-balances",
      accountNumber: resolvedAccountNumber,
      nlv: accountBalances["net-liquidating-value"],
      derivBP: accountBalances["derivative-buying-power"],
      usedDerivBP: accountBalances["used-derivative-buying-power"],
      maintenanceReq: accountBalances["maintenance-requirement"],
      updatedAt: accountBalances["updated-at"],
    }),
  );

  const buyingPower = getSpendableFundsForAccountType(
    accountBalances,
    accountMarginOrCash,
  );
  const doNotTouchGroupKeys = getDoNotTouchGroupKeys();

  const completedEvaluations = await getPositionEvaluations(resolvedAccountNumber);
  const ignoredEvaluations = completedEvaluations.filter((evaluation) =>
    isEvaluationDoNotTouch(evaluation, doNotTouchGroupKeys),
  );
  const actionableCompletedEvaluations = completedEvaluations.filter(
    (evaluation) => !isEvaluationDoNotTouch(evaluation, doNotTouchGroupKeys),
  );
  const strategyDecisions = computeStrategyDecisions(completedEvaluations).map(
    (decision) => {
      const matchedEvaluation = completedEvaluations.find(
        (evaluation) => evaluation.underlyingSymbol === decision.underlyingSymbol,
      );

      if (
        matchedEvaluation &&
        isEvaluationDoNotTouch(matchedEvaluation, doNotTouchGroupKeys)
      ) {
        return {
          ...decision,
          reason: `DO_NOT_TOUCH group configured - ${decision.reason}`,
        };
      }

      return decision;
    },
  );
  const currentTime = new Date();

  startSecretSocketConnection();
  const timeOfDayExecutionTargets = getTimeOfDayExecutionTargets(
    currentTime,
    accountMarginOrCash,
  );
  const cachedSecretPositions = getCachedSecretSourcePositions();
  // (log removed: duplicate of "Secret Socket: ... positions=N" in RUN SNAPSHOT)
  const secretSocketStatus = getSecretSocketStatus();
  const baseExecutionTargets = timeOfDayExecutionTargets;
  const dynamicTakeProfitTarget = getDynamicTakeProfitTarget(currentTime);

  const startingBudget = buildInitialBudget(
    buyingPower,
    getEffectiveTotalCapital(accountBalances),
    actionableCompletedEvaluations,
  );

  const currentExposurePct =
    startingBudget.totalCapital > 0
      ? startingBudget.portfolioExposure / startingBudget.totalCapital
      : 0;
  const runExecutionTargets = applyPositionSizeWeightCaps(
    baseExecutionTargets,
    currentExposurePct,
  );

  // Build cross-account ask-return fraction lookup for per-position gating.
  // Cash accounts confirm against the margin position; margin accounts confirm against cash.
  const crossAccountAskReturnBySymbol = new Map<string, number>();
  if (accountMarginOrCash === "cash") {
    try {
      const [cashAccountNumber, marginAccountNumber] = await Promise.all([
        getCashAccountNumber(),
        getMarginAccountNumber(),
      ]);
      if (marginAccountNumber !== cashAccountNumber && marginAccountNumber !== resolvedAccountNumber) {
        const marginEvaluations = await getPositionEvaluations(marginAccountNumber);
        for (const marginEval of marginEvaluations) {
          const fill = marginEval.metrics.weightedAverageFill;
          if (fill > 0) {
            const fraction = (marginEval.metrics.currentAskPrice - fill) / fill;
            crossAccountAskReturnBySymbol.set(marginEval.underlyingSymbol.toUpperCase(), fraction);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[position-gate] failed to fetch margin evaluations: ${message}`);
    }
  } else if (accountMarginOrCash === "margin") {
    try {
      const cashAccountNumber = await getCashAccountNumber();
      if (cashAccountNumber !== resolvedAccountNumber) {
        const cashEvaluations = await getPositionEvaluations(cashAccountNumber);
        for (const cashEval of cashEvaluations) {
          const fill = cashEval.metrics.weightedAverageFill;
          if (fill > 0) {
            const fraction = (cashEval.metrics.currentAskPrice - fill) / fill;
            crossAccountAskReturnBySymbol.set(cashEval.underlyingSymbol.toUpperCase(), fraction);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[position-gate] failed to fetch cash evaluations: ${message}`);
    }
  }

  // Calculate per-group execution targets based on position stats
  // fallow-ignore-next-line complexity
  const evaluationsWithGroupTargets = actionableCompletedEvaluations.map((evaluation) => {
    const weightedAverageFill = evaluation.metrics.weightedAverageFill;
    const currentBidPrice = evaluation.metrics.currentBidPrice;
    const currentAskPrice = evaluation.metrics.currentAskPrice;
    const currentMidPrice = (currentBidPrice + currentAskPrice) / 2;
    const askReturnPerc =
      weightedAverageFill > 0
        ? (currentAskPrice - weightedAverageFill) / weightedAverageFill
        : 0;
    // Dip is measured on MID return, not ask — the ask is blind to bid-side
    // spread pain (see IMPROVEMENTS.v8 #3). Mid is the fair-value proxy.
    const midReturnPerc =
      weightedAverageFill > 0
        ? (currentMidPrice - weightedAverageFill) / weightedAverageFill
        : 0;
    // Bid return drives the bid-safety gate inside getMarginDipTargetBoostPct:
    // suppresses the dip boost when the bid is already near the stop-loss floor.
    const bidReturnPerc =
      weightedAverageFill > 0
        ? (currentBidPrice - weightedAverageFill) / weightedAverageFill
        : 0;
    // Current bid/ask spread as a fraction of mid, for wide-spread suppression
    // of the dip boost. Null when the mid is non-positive so an absent/degenerate
    // quote degrades gracefully (does not suppress) rather than reading as 0.
    const dipSpreadFraction =
      currentMidPrice > 0 ? (currentAskPrice - currentBidPrice) / currentMidPrice : null;
    const timeSinceLastActionMs =
      currentTime.getTime() - evaluation.metrics.lastActionTime.getTime();

    // Get position group-based targets
    const groupTargetComponents = buildGroupExecutionTargets({
      accountType: accountMarginOrCash,
      askReturnPerc,
      baseExecutionTargets,
      currentExposurePct,
      currentTime,
      symbol: evaluation.underlyingSymbol,
      timeSinceLastActionMs,
    });
    const finalTargets = groupTargetComponents.finalPostCapsTargets;

    // Boolean surplus applies to both accounts
    const symbol = evaluation.underlyingSymbol.toUpperCase();
    const secretPosition = cachedSecretPositions.find(
      (p) => String(p.ticker ?? "").trim().toUpperCase() === symbol,
    );
    const goodBooleanScore = countGoodBooleans(secretPosition);
    const booleanSurplusPct = getBooleanSurplusPct(goodBooleanScore);

    if (accountMarginOrCash === "margin") {
      // Margin gate: same signal system as cash but scaled up by 1.33x.
      // crossAccountAskReturnFraction uses the cash position's return as confirmation,
      // with a 2x threshold multiplier so the bar is higher than the cash-side check.
      const crossAccountAskReturnFraction = crossAccountAskReturnBySymbol.get(symbol) ?? null;
      const gate = computePositionGate({
        crossAccountAskReturnFraction,
        secretPosition,
        currentTime,
        crossAccountThresholdMultiplier: getCrossAccountThresholdMultiplier(),
      });
      // Hard gate: margin requires willBuy. Applied only when the feed has a
      // position for this ticker (absent feed → fall through to existing tiers).
      const willBuy = secretPosition?.willBuy;
      const willBuyBlocked = secretPosition !== undefined && willBuy !== true;
      const multiplier = getMarginTargetMultiplier();
      // Signal quality: buyMult (pre-crush rec strength) × gateMult (gate favorability, full = 2.0).
      // Product normalized onto 0–4 → 0–1, floored at 0.5 so cleared-gate positions aren't crushed.
      // Falls through at 1.0 when either field is absent (field not yet on payload).
      const marginBuyMult = typeof secretPosition?.buyMult === "number" ? secretPosition.buyMult : null;
      const marginGateMult = typeof secretPosition?.gateMult === "number" ? secretPosition.gateMult : null;
      const marginQualityFactor = marginBuyMult !== null && marginGateMult !== null
        ? Math.max(0.5, Math.min(1.0, (marginBuyMult * marginGateMult) / 4.0))
        : 1.0;
      // Market-posture factor (wired 2026-07-19): the feed's envelope-level
      // regimeMarginMult (down-only throttle) × dipBuyDeployMult (capped dip
      // lean-in). Margin only — cash has its own hold-side regime gates.
      const regimePostureMult = getRegimePostureMult(getCachedSecretRegime());
      const marginMaxTargetPct = willBuyBlocked
        ? 0
        : gate.maxTargetPct * multiplier * marginQualityFactor * regimePostureMult;
      // ITM fallback eligibility: on low-priced/illiquid names the OTM strikes are
      // dead-quoted (100% spreads) while the ATM/ITM strike is tradeable. Permit
      // margin to fall back to ITM only on high conviction (buyWeight > 280) —
      // momentum flips keep skipping rather than tying up capital in an ITM
      // contract. The daytradeScore < -40 "HOLD" leg was removed 2026-07-19:
      // the forward-return backtest showed dip pain grants nothing (dt -70..-150
      // is the death valley). marginDaytradeScore stays as log-only telemetry.
      const marginDaytradeScore = typeof secretPosition?.daytradeScore === "number" ? secretPosition.daytradeScore : null;
      const marginBuyWeight = typeof secretPosition?.buyWeight === "number" ? secretPosition.buyWeight : null;
      const marginItmFallbackEligible = marginBuyWeight !== null && marginBuyWeight > 280;
      // Dip boost triggers on MID return (not ask) so it can see bid-side spread
      // pain, with optional wide-spread suppression (off by default). See v8 #3.
      const dipTargetBoostPct = getMarginDipTargetBoostPct(
        midReturnPerc,
        goodBooleanScore,
        dipSpreadFraction,
        bidReturnPerc,
      );
      const scaledTargetAccountExposure =
        finalTargets.targetAccountExposure * marginMaxTargetPct;

      console.log(
        JSON.stringify({
          scope: "margin-position-gate",
          symbol,
          willBuy,
          willBuyBlocked,
          marginBuyMult,
          marginGateMult,
          marginQualityFactor,
          marginDaytradeScore,
          marginBuyWeight,
          marginItmFallbackEligible,
          crossAccountAskReturnFraction,
          signals: gate.signals,
          cashMaxTargetPct: gate.maxTargetPct,
          multiplier,
          regimePostureMult,
          marginMaxTargetPct,
          booleanSurplusPct,
          dipTargetBoostPct,
          askReturnPerc,
          midReturnPerc,
          bidReturnPerc,
          dipSpreadFraction,
          originalTargetPct: finalTargets.targetAccountExposure,
          effectiveTargetPct: scaledTargetAccountExposure,
        }),
      );

      return {
        ...evaluation,
        executionTargets: {
          ...finalTargets,
          targetAccountExposure: scaledTargetAccountExposure,
          maxTargetAccountExposure: marginMaxTargetPct,
          booleanSurplusPct,
          dipTargetBoostPct,
          positionGate: gate,
          marginItmFallbackEligible,
        },
      };
    }

    if (accountMarginOrCash !== "cash") {
      return {
        ...evaluation,
        executionTargets: { ...finalTargets, booleanSurplusPct },
      };
    }

    // Cash account: gate per-position allocation based on confirmation signals.
    // targetAccountExposure is scaled by gate max so the position ramps toward
    // the gate ceiling by end of day rather than hitting it immediately.
    const crossAccountAskReturnFraction = crossAccountAskReturnBySymbol.get(symbol) ?? null;
    const gate = computePositionGate({
      crossAccountAskReturnFraction,
      secretPosition,
      currentTime,
    });

    // Hard gates: cash requires holdScore ≥ 0.45, isOvernightEligible, and
    // no crashRegime. Applied only when the feed has emitted the field for this
    // ticker (undefined = field not yet on payload → gate not applied).
    const cashHoldScore = typeof secretPosition?.holdScore === "number" ? secretPosition.holdScore : null;
    const cashHoldBlocked = cashHoldScore !== null && cashHoldScore < 0.45;
    const cashEligibleBlocked = secretPosition !== undefined && secretPosition.isOvernightEligible === false;
    const cashRegimeBlocked = getCachedSecretRegime()?.crashRegime === true;
    const cashHardGateBlocked = cashHoldBlocked || cashEligibleBlocked || cashRegimeBlocked;
    // Signal quality factor: same formula as margin — buyMult × gateMult is still
    // meaningful for ITM entry timing even when the hold signal drives the hard gate.
    const cashBuyMult = typeof secretPosition?.buyMult === "number" ? secretPosition.buyMult : null;
    const cashGateMult = typeof secretPosition?.gateMult === "number" ? secretPosition.gateMult : null;
    const cashQualityFactor = cashBuyMult !== null && cashGateMult !== null
      ? Math.max(0.5, Math.min(1.0, (cashBuyMult * cashGateMult) / 4.0))
      : 1.0;
    const cashGateMaxTargetPct = cashHardGateBlocked ? 0 : gate.maxTargetPct * cashQualityFactor;

    const scaledTargetAccountExposure =
      finalTargets.targetAccountExposure * cashGateMaxTargetPct;

    console.log(
      JSON.stringify({
        scope: "cash-position-gate",
        symbol,
        cashHoldScore,
        cashHoldBlocked,
        cashEligibleBlocked,
        cashRegimeBlocked,
        cashBuyMult,
        cashGateMult,
        cashQualityFactor,
        crossAccountAskReturnFraction,
        signals: gate.signals,
        strongStockYesPctThreshold: gate.strongStockYesPctThreshold,
        maxTargetPct: cashGateMaxTargetPct,
        booleanSurplusPct,
        originalTargetPct: finalTargets.targetAccountExposure,
        effectiveTargetPct: scaledTargetAccountExposure,
      }),
    );

    return {
      ...evaluation,
      executionTargets: {
        ...finalTargets,
        targetAccountExposure: scaledTargetAccountExposure,
        maxTargetAccountExposure: cashGateMaxTargetPct,
        booleanSurplusPct,
        positionGate: gate,
      },
    };
  });

  const uniqueSymbols = [...new Set(completedEvaluations.map((e) => e.underlyingSymbol.toUpperCase()))];
  const underlyingPriceEntries = await Promise.all(
    uniqueSymbols.map(async (sym) => {
      const result = await getUnderlyingPrice(sym).catch(() => null);
      return [sym, result?.underlyingPrice ?? null] as const;
    }),
  );
  const underlyingPrices = new Map<string, number | null>(underlyingPriceEntries);

  const groupReturns = computeGroupReturns(completedEvaluations, evaluationsWithGroupTargets, underlyingPrices);

  // Diagnostic (v5 #6): before averaging down, look at the underlying's recent
  // tape. Run history already records underlyingPriceAtCycleTime per group, so
  // read the last N cycles, build each underwater group's price series
  // (oldest → newest + this cycle), and log a stabilization signal. Log-only —
  // gates nothing yet; the point is to see whether adds land into free-falls.
  const stabilizationHistory = (await getRecentRunHistory(12, resolvedAccountNumber)).filter(
    (entry) => entry.entryType !== "error",
  );
  for (const evaluation of completedEvaluations) {
    if (evaluation.currentReturn >= 0) {
      continue;
    }
    const symbolKey = evaluation.underlyingSymbol.toUpperCase();
    const historicalPrices = [...stabilizationHistory]
      .reverse()
      .map(
        (run) =>
          run.groups.find((group) => group.underlyingSymbol.toUpperCase() === symbolKey)
            ?.underlyingPriceAtCycleTime,
      )
      .filter((price): price is number => typeof price === "number");
    const currentPrice = underlyingPrices.get(symbolKey);
    const series =
      typeof currentPrice === "number"
        ? [...historicalPrices, currentPrice]
        : historicalPrices;
    const stabilization = computeUnderlyingStabilization(series);
    console.log(
      JSON.stringify({
        scope: "underlying-stabilization",
        underlyingSymbol: evaluation.underlyingSymbol,
        currentReturnPct: Number(evaluation.currentReturn.toFixed(4)),
        sampleCount: stabilization.sampleCount,
        isStabilizing: stabilization.isStabilizing,
        rangePct: Number(stabilization.rangePct.toFixed(4)),
        netChangePct: Number(stabilization.netChangePct.toFixed(4)),
        latestVsRecentLowPct: Number(stabilization.latestVsRecentLowPct.toFixed(4)),
      }),
    );
  }

  const plannedManageEvaluations = selectManageEvaluationsByBuyingPower(
    evaluationsWithGroupTargets.filter(
      (evaluation) => evaluation.strategy.action === "MANAGE_ALLOCATION",
    ),
    buyingPower,
  ).sort((a, b) => a.currentReturn - b.currentReturn);

  const selectedUnderlyingSymbols = new Set(
    plannedManageEvaluations.map((evaluation) => evaluation.underlyingSymbol),
  );

  const unselectedManageEvaluations = evaluationsWithGroupTargets
    .filter((evaluation) => evaluation.strategy.action === "MANAGE_ALLOCATION")
    .filter(
      (evaluation) => !selectedUnderlyingSymbols.has(evaluation.underlyingSymbol),
    )
    // fallow-ignore-next-line complexity
    .sort((a, b) => {
      const aExposure = a.executionTargets?.targetAccountExposure ?? Number.NEGATIVE_INFINITY;
      const bExposure = b.executionTargets?.targetAccountExposure ?? Number.NEGATIVE_INFINITY;

      if (bExposure !== aExposure) {
        return bExposure - aExposure;
      }

      if (a.currentReturn !== b.currentReturn) {
        return a.currentReturn - b.currentReturn;
      }

      const aBuyWeight = a.secretBuyWeight ?? Number.NEGATIVE_INFINITY;
      const bBuyWeight = b.secretBuyWeight ?? Number.NEGATIVE_INFINITY;
      return bBuyWeight - aBuyWeight;
    });

  const normalizedPlannedManageEvaluations = normalizeGroupExecutionTargetExposures(
    plannedManageEvaluations,
    runExecutionTargets.targetAccountExposure,
  );

  // For snapshot, use average of all planned group targets
  const plannedGroupTargets = normalizedPlannedManageEvaluations
    .map((e) => e.executionTargets)
    .filter((t): t is typeof runExecutionTargets => Boolean(t));

  const snapshotExecutionTargets =
    plannedGroupTargets.length > 0
      ? {
          ...averageExecutionTargets(plannedGroupTargets),
          targetAccountExposure: runExecutionTargets.targetAccountExposure,
        }
      : runExecutionTargets;

  const targetExposureValue =
    startingBudget.totalCapital * snapshotExecutionTargets.targetAccountExposure;

  const plannedRows: RunPlanRow[] = [];
  const planDiagnostics: RunCyclePreview["plan"]["diagnostics"] = [];
  const ignoredGroups: RunPlanSelectedGroup[] = ignoredEvaluations.map(
    (evaluation, index) =>
      toRunPlanSelectedGroup(evaluation, index + 1, runExecutionTargets.targetDTE),
  );
  const selectedGroups: RunPlanSelectedGroup[] = normalizedPlannedManageEvaluations.map(
    (evaluation, index) =>
      toRunPlanSelectedGroup(evaluation, index + 1, runExecutionTargets.targetDTE),
  );
  const unselectedGroups: RunPlanSelectedGroup[] = unselectedManageEvaluations.map(
    (evaluation, index) =>
      toRunPlanSelectedGroup(evaluation, index + 1, runExecutionTargets.targetDTE),
  );

  let planningBudget = startingBudget;
  for (const [index, evaluation] of normalizedPlannedManageEvaluations.entries()) {
    const groupsRemainingForAllocation =
      normalizedPlannedManageEvaluations.length - index;
    const planResult = await manageAllocationForGroup(
      resolvedAccountNumber,
      evaluation,
      planningBudget,
      groupsRemainingForAllocation,
      {
        dryRun: true,
        // Without this the plan sizes margin buys with the cash per-action cap
        // (5% vs 12%) — real execution passes it, so plan and reality diverged.
        accountMarginOrCash:
          accountMarginOrCash === "unknown" ? undefined : accountMarginOrCash,
      },
    );

    for (const routeOrder of planResult.routeOrders) {
      if (routeOrder.quantity <= 0) {
        continue;
      }

      plannedRows.push({
        estimatedCost: routeOrder.estimatedOrderValue,
        limitPrice: routeOrder.limitPrice,
        quantity: routeOrder.quantity,
        route: routeOrder.route,
        symbol: planResult.candidateSymbol ?? evaluation.underlyingSymbol,
        underlyingSymbol: evaluation.underlyingSymbol,
      });
    }

    const plannedQuantity = planResult.routeOrders.reduce(
      (sum, routeOrder) => sum + routeOrder.quantity,
      0,
    );

    if (plannedQuantity < 1) {
      planDiagnostics.push({
        currentReturnPct: evaluation.currentReturn,
        groupKey: evaluation.groupKey,
        skippedReason:
          planResult.skippedReason ??
          "allocated quantity rounded to zero for all routes",
        strategyAction: evaluation.strategy.action,
        underlyingSymbol: evaluation.underlyingSymbol,
      });
    }

    planningBudget = getUpdatedBudgetAfterAllocation(
      planningBudget,
      evaluation,
      {
        ...planResult,
        placedOrder: (planResult.quantity ?? 0) > 0,
      },
    );
  }

  return {
    accountBalances,
    accountMarginOrCash,
    baseExecutionTargets,
    cachedSecretPositions,
    completedEvaluations,
    evaluationsWithGroupTargets,
    preview: {
      accountNumber: resolvedAccountNumber,
      groups: groupReturns,
      plan: {
        diagnostics: planDiagnostics,
        ignoredGroups,
        rows: plannedRows,
        selectedGroups,
        unselectedGroups,
        totalContracts: plannedRows.reduce((sum, row) => sum + row.quantity, 0),
        totalEstimatedCost: plannedRows.reduce(
          (sum, row) => sum + row.estimatedCost,
          0,
        ),
      },
      snapshot: {
        dynamicTakeProfitTarget,
        currentExposurePct,
        currentExposureValue: startingBudget.portfolioExposure,
        readOnly,
        secondsSinceLastPositionsUpdate:
          secretSocketStatus.secondsSinceLastPositionsUpdate,
        routeWeights: {
          ask: snapshotExecutionTargets.askWeight,
          bid: snapshotExecutionTargets.bidWeight,
          mid: snapshotExecutionTargets.midWeight,
        },
        targetDTE: snapshotExecutionTargets.targetDTE,
        targetExposurePct: snapshotExecutionTargets.targetAccountExposure,
        targetExposureValue,
        totalCapital: startingBudget.totalCapital,
      },
      strategySummary: {
        closePositionCount: actionableCompletedEvaluations.filter(
          (evaluation) => evaluation.strategy.action === "CLOSE_POSITION",
        ).length,
        manageAllocationCount: actionableCompletedEvaluations.filter(
          (evaluation) => evaluation.strategy.action === "MANAGE_ALLOCATION",
        ).length,
      },
    },
    runExecutionTargets: snapshotExecutionTargets,
    strategyDecisions,
  };
}
