import {
  getConservativeSpendableFunds,
  getAccountBalanceNumber,
  getEffectiveTotalCapital,
} from "~/core/account-balance";
import tastytradeApi from "~/core/tastytrade-client";
import { TastytradeAccountBalance, TastytradeOrder } from "~/core/types";
import {
  getSpendableFundsForAccountType,
} from "~/core/account-balance";
import { getAccountMarginOrCash } from "~/core/default-account";
import { PositionGroupEvaluation } from "./evaluate-position";
import {
  ExecutionTargets,
  getTimeOfDayExecutionTargets,
} from "./evaluate-trading-strategy";
import { closePosition, ClosePositionResult } from "./actions/close-position";
import { recordPositionClosed } from "./position-registry";
import {
  selectManageEvaluationsByBuyingPower,
} from "./group-allocation-priority";
import {
  AllocationExecutionResult,
  buildInitialBudget,
  getUpdatedBudgetAfterAllocation,
  manageAllocationForGroup,
} from "./actions/manage-allocation";
import {
  getDefaultAccountNumber,
  isReadOnlyAccount,
} from "~/core/default-account";
import {
  getDoNotTouchGroupKeys,
  isEvaluationDoNotTouch,
  isOrderDoNotTouch,
} from "./do-not-touch-groups";
import {
  isMarginSeedFromCashOrderSource,
  isSecretAutoSeedOrderSource,
} from "./order-sources";

export interface CancelOrderResult {
  cancelled: boolean;
  orderId: number;
  response?: TastytradeOrder;
  skippedReason?: string;
}

export interface PositionEvaluationExecutionResult {
  allocationOrders: AllocationExecutionResult[];
  cancelledOrders: CancelOrderResult[];
  closeOrders: ClosePositionResult[];
  evaluations: PositionGroupEvaluation[];
}

function isTerminalOrderStatus(status: string | undefined): boolean {
  return ["Cancelled", "Canceled", "Filled", "Expired", "Rejected", "Removed", "Partially Removed"].includes(
    status ?? "",
  );
}

export async function cancelAllLiveOrders(
  accountNumber?: string,
): Promise<CancelOrderResult[]> {

  const doNotTouchGroupKeys = getDoNotTouchGroupKeys();

  const resolvedAccountNumber = accountNumber ?? (await getDefaultAccountNumber());
  if (isReadOnlyAccount(resolvedAccountNumber)) {
    return [];
  }

  const liveOrders = await tastytradeApi.orderService.getLiveOrders(
    resolvedAccountNumber,
  );

  const results: CancelOrderResult[] = [];
  for (const order of liveOrders) {
    const orderId = Number(order.id);
    if (!Number.isFinite(orderId)) {
      continue;
    }

    if (!order.cancellable || isTerminalOrderStatus(order.status)) {
      results.push({
        cancelled: false,
        orderId,
        skippedReason: "order is not cancellable",
      });
      continue;
    }

    if (isSecretAutoSeedOrderSource(order.source)) {
      results.push({
        cancelled: false,
        orderId,
        skippedReason: "protected secret auto-seed order",
      });
      continue;
    }

    if (isMarginSeedFromCashOrderSource(order.source)) {
      results.push({
        cancelled: false,
        orderId,
        skippedReason: "protected cross-account seed order",
      });
      continue;
    }

    if (isOrderDoNotTouch(order, doNotTouchGroupKeys)) {
      results.push({
        cancelled: false,
        orderId,
        skippedReason: "protected do-not-touch group order",
      });
      continue;
    }

    const response = await tastytradeApi.orderService.cancelOrder(
      resolvedAccountNumber,
      orderId,
    );
    results.push({
      cancelled: true,
      orderId,
      response,
    });
  }

  return results;
}

export async function executePositionEvaluations(
  accountNumber: string,
  accountBalance: TastytradeAccountBalance,
  evaluations: PositionGroupEvaluation[],
  runExecutionTargets?: ExecutionTargets,
): Promise<PositionEvaluationExecutionResult> {
  const readOnly = isReadOnlyAccount(accountNumber);
  const cancelledOrders = readOnly ? [] : await cancelAllLiveOrders(accountNumber);
  const doNotTouchGroupKeys = getDoNotTouchGroupKeys();
  const accountMarginOrCash = await getAccountMarginOrCash(accountNumber);
  const spendableFunds = getSpendableFundsForAccountType(
    accountBalance,
    accountMarginOrCash,
  );

  const sharedExecutionTargets =
    runExecutionTargets ??
    getTimeOfDayExecutionTargets(
      evaluations[0]?.metrics.currentTime ?? new Date(),
      accountMarginOrCash,
    );

  const evaluationsWithTargets = evaluations.map((evaluation) => ({
    ...evaluation,
    executionTargets: evaluation.executionTargets ?? sharedExecutionTargets,
  }));
  const actionableEvaluations = evaluationsWithTargets.filter(
    (evaluation) => !isEvaluationDoNotTouch(evaluation, doNotTouchGroupKeys),
  );

  const normalizeSelectedManageExposureTargets = (
    selectedEvaluations: PositionGroupEvaluation[],
  ): PositionGroupEvaluation[] => {
    const totalTargetExposure = sharedExecutionTargets.targetAccountExposure;
    const totalRawExposure = selectedEvaluations.reduce(
      (sum, evaluation) => sum + (evaluation.executionTargets?.targetAccountExposure ?? 0),
      0,
    );

    if (!(totalTargetExposure > 0) || !(totalRawExposure > 0)) {
      return selectedEvaluations;
    }

    let allocatedExposure = 0;

    return selectedEvaluations.map((evaluation, index) => {
      const executionTargets = evaluation.executionTargets;
      if (!executionTargets) {
        return evaluation;
      }

      const normalizedExposure =
        index === selectedEvaluations.length - 1
          ? Math.round((totalTargetExposure - allocatedExposure) * 100) / 100
          : Math.round(
              totalTargetExposure *
                (executionTargets.targetAccountExposure / totalRawExposure) *
                100,
            ) / 100;

      allocatedExposure += normalizedExposure;

      return {
        ...evaluation,
        executionTargets: {
          ...executionTargets,
          targetAccountExposure: normalizedExposure,
        },
      };
    });
  };

  const closeEvaluations = evaluationsWithTargets.filter(
    (evaluation) => evaluation.strategy.action === "CLOSE_POSITION",
  );
  const manageEvaluations = normalizeSelectedManageExposureTargets(
    selectManageEvaluationsByBuyingPower(
      actionableEvaluations.filter(
        (evaluation) => evaluation.strategy.action === "MANAGE_ALLOCATION",
      ),
      spendableFunds,
    ),
  );
  const actionableCloseEvaluations = actionableEvaluations.filter(
    (evaluation) => evaluation.strategy.action === "CLOSE_POSITION",
  );

  const closeOrders = readOnly
    ? actionableCloseEvaluations.flatMap((evaluation) =>
        evaluation.positionSnapshots.map((snapshot) => ({
          accountNumber,
          action: "CLOSE_POSITION" as const,
          placedOrder: false,
          skippedReason: "account is configured read-only",
          symbol: snapshot.position.symbol,
          underlyingSymbol: evaluation.underlyingSymbol,
        })),
      )
    : (
        await Promise.all(
          actionableCloseEvaluations.map((evaluation) =>
            closePosition(
              accountNumber,
              evaluation,
              evaluation.executionTargets ?? sharedExecutionTargets,
            ),
          ),
        )
      ).flat();

  // Record closing orders in the position registry for P&L tracking
  for (const evaluation of actionableCloseEvaluations) {
    const symbol = evaluation.underlyingSymbol;
    const placedResult = closeOrders.find(
      (r) => r.underlyingSymbol === symbol && r.placedOrder,
    );
    const orderId = placedResult && "orderResponse" in placedResult
      ? placedResult.orderResponse?.order?.id
      : undefined;
    if (orderId) {
      await recordPositionClosed(accountNumber, symbol, String(orderId));
    }
  }

  let budget = buildInitialBudget(
    spendableFunds,
    getEffectiveTotalCapital(accountBalance),
    actionableEvaluations,
  );
  const allocationOrders: AllocationExecutionResult[] = [];

  if (readOnly) {
    for (const evaluation of manageEvaluations) {
      allocationOrders.push({
        accountNumber,
        action: "MANAGE_ALLOCATION",
        placedOrder: false,
        routeOrders: [],
        skippedReason: "account is configured read-only",
        underlyingSymbol: evaluation.underlyingSymbol,
      });
    }

    return {
      allocationOrders,
      cancelledOrders,
      closeOrders,
      evaluations: actionableEvaluations,
    };
  }

  for (const [index, evaluation] of manageEvaluations.entries()) {
    const groupsRemainingForAllocation = manageEvaluations.length - index;
    const result = await manageAllocationForGroup(
      accountNumber,
      evaluation,
      budget,
      groupsRemainingForAllocation,
      { accountMarginOrCash: accountMarginOrCash === "unknown" ? undefined : accountMarginOrCash },
    );
    allocationOrders.push(result);
    budget = getUpdatedBudgetAfterAllocation(budget, evaluation, result);
  }

  return {
    allocationOrders,
    cancelledOrders,
    closeOrders,
    evaluations: actionableEvaluations,
  };
}

export default executePositionEvaluations;