import tastytradeApi from "~/core/tastytrade-client";
import {
  getDefaultAccountNumber,
  getAccountMarginOrCash,
  getCashAccountNumber,
  getMarginAccountNumber,
  isReadOnlyAccount,
} from "~/core/default-account";
import { computeCashPositionGate, countGoodBooleans, getBooleanSurplusPct } from "./cash-position-gate";
import {
  getEffectiveTotalCapital,
  getSpendableFundsForAccountType,
} from "~/core/account-balance";
import { TastytradeAccountBalance } from "~/core/types";
import type { SecretSourcePosition } from "./secret/types";
import { getPositionEvaluations } from "./get-position-evaluations";
import {
  applyPositionSizeWeightCaps,
  averageExecutionTargets,
  getDynamicTakeProfitTarget,
  getTimeOfDayExecutionTargets,
} from "./evaluate-trading-strategy";
import {
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
import { PositionGroupEvaluation } from "./evaluate-position";
import { selectManageEvaluationsByBuyingPower } from "./group-allocation-priority";
import {
  getCachedSecretSourcePositions,
  getSecretPositionSignalsForSymbol,
  getSecretSocketStatus,
  startSecretSocketConnection,
} from "./secret";
import { buildGroupExecutionTargets } from "./group-execution-targets";

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

function computeGroupReturns(
  completedEvaluations: PositionGroupEvaluation[],
): RunGroupReturn[] {
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

    return {
      askReturnPct,
      bidReturnPct,
      currentReturnPct: evaluation.currentReturn,
      buyWeight: evaluation.secretBuyWeight ?? null,
      daytradeScore: secretSignals?.daytradeScore ?? null,
      returnPerc: secretSignals?.returnPerc ?? null,
      superRecScore: secretSignals?.superRecScore ?? null,
      side,
      totalCostBasis,
      totalUnrealizedReturnAsk,
      totalUnrealizedReturnBid,
      underlyingSymbol: evaluation.underlyingSymbol,
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

function normalizeGroupExecutionTargetExposures(
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

  console.log(
    JSON.stringify(
      {
        scope: "account-balances",
        accountNumber: resolvedAccountNumber,
        accountBalances,
      },
      null,
      2,
    ),
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
  const groupReturns = computeGroupReturns(completedEvaluations);
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
  console.log(
    `[secret] cached source positions: ${cachedSecretPositions.length}`,
  );
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

  // For cash accounts: build a lookup of margin account's ask-return fractions per symbol
  // used to determine "margin YES" signals for per-position gating.
  const marginAskReturnBySymbol = new Map<string, number>();
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
            marginAskReturnBySymbol.set(marginEval.underlyingSymbol.toUpperCase(), fraction);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[cash-position-gate] failed to fetch margin evaluations: ${message}`);
    }
  }

  // Calculate per-group execution targets based on position stats
  const evaluationsWithGroupTargets = actionableCompletedEvaluations.map((evaluation) => {
    const weightedAverageFill = evaluation.metrics.weightedAverageFill;
    const askReturnPerc =
      weightedAverageFill > 0
        ? (evaluation.metrics.currentAskPrice - weightedAverageFill) / weightedAverageFill
        : 0;
    const timeSinceLastActionMs =
      currentTime.getTime() - evaluation.metrics.lastActionTime.getTime();

    // Get position group-based targets
    const groupTargetComponents = buildGroupExecutionTargets({
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

    if (accountMarginOrCash !== "cash") {
      return {
        ...evaluation,
        executionTargets: { ...finalTargets, booleanSurplusPct },
      };
    }

    // Cash account: gate per-position allocation based on confirmation signals
    const gate = computeCashPositionGate({
      marginAskReturnFraction: marginAskReturnBySymbol.get(symbol) ?? null,
      secretPosition,
      currentTime,
    });

    const cappedTargetAccountExposure = Math.min(
      finalTargets.targetAccountExposure,
      gate.maxTargetPct,
    );

    console.log(
      JSON.stringify({
        scope: "cash-position-gate",
        symbol,
        marginAskReturnFraction: marginAskReturnBySymbol.get(symbol) ?? null,
        signals: gate.signals,
        strongStockYesPctThreshold: gate.strongStockYesPctThreshold,
        strongStockYesScoreThreshold: gate.strongStockYesScoreThreshold,
        maxTargetPct: gate.maxTargetPct,
        booleanSurplusPct,
        originalTargetPct: finalTargets.targetAccountExposure,
        effectiveTargetPct: cappedTargetAccountExposure,
      }),
    );

    return {
      ...evaluation,
      executionTargets: {
        ...finalTargets,
        targetAccountExposure: cappedTargetAccountExposure,
        maxTargetAccountExposure: gate.maxTargetPct,
        booleanSurplusPct,
      },
    };
  });

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
      { dryRun: true },
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
