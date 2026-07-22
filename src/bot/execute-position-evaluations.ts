import {
  getEffectiveTotalCapital,
} from "~/core/account-balance";
import tastytradeApi from "~/core/tastytrade-client";
import { notifyEvent } from "./notify";
import { TastytradeAccountBalance, TastytradeOrder } from "~/core/types";
import {
  getSpendableFundsForAccountType,
} from "~/core/account-balance";
import { getAccountMarginOrCash } from "~/core/default-account";
import { PositionGroupEvaluation } from "./evaluate-position";
import {
  ExecutionTargets,
  getTimeOfDayExecutionTargets,
} from "~/strategy/evaluate-trading-strategy";
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
  isOvernightReductionOrderSource,
  isSecretAutoSeedOrderSource,
  isSprayBuyOrderSource,
} from "./order-sources";
import { isOvernightPosition } from "./position-registry";
import { isInOvernightReductionWindow } from "~/strategy/overnight-reduction";

export interface CancelOrderResult {
  cancelled: boolean;
  orderId: number;
  response?: TastytradeOrder;
  skippedReason?: string;
  // Populated for overnight-reduction orders that were skipped (not cancelled)
  // so callers can build the set of live overnight reduction symbols.
  underlyingSymbol?: string;
}

export interface PositionEvaluationExecutionResult {
  allocationOrders: AllocationExecutionResult[];
  cancelledOrders: CancelOrderResult[];
  closeOrders: ClosePositionResult[];
  evaluations: PositionGroupEvaluation[];
}

// In-memory cache of order IDs confirmed as terminal (filled, cancelled, etc.)
// keyed by account number. Survives the bot session; cleared on restart.
// Prevents repeated cancel attempts and log noise for orders the broker
// continues to surface via getLiveOrders after they have reached a terminal state.
const terminalOrderIdsByAccount = new Map<string, Set<number>>();

function getTerminalOrderIds(accountNumber: string): Set<number> {
  let ids = terminalOrderIdsByAccount.get(accountNumber);
  if (!ids) {
    ids = new Set<number>();
    terminalOrderIdsByAccount.set(accountNumber, ids);
  }
  return ids;
}

function markOrderTerminal(accountNumber: string, orderId: number): void {
  getTerminalOrderIds(accountNumber).add(orderId);
}


function isTerminalOrderStatus(status: string | undefined): boolean {
  return ["Cancelled", "Canceled", "Filled", "Expired", "Rejected", "Removed", "Partially Removed"].includes(
    status ?? "",
  );
}

// fallow-ignore-next-line complexity
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

  const terminalIds = getTerminalOrderIds(resolvedAccountNumber);
  const results: CancelOrderResult[] = [];
  for (const order of liveOrders) {
    const orderId = Number(order.id);
    if (!Number.isFinite(orderId)) {
      continue;
    }

    // Skip orders already confirmed terminal in a prior cycle — no API call,
    // no log entry. We re-learn on restart (one extra failed cancel is fine).
    if (terminalIds.has(orderId)) {
      continue;
    }

    if (!order.cancellable || isTerminalOrderStatus(order.status)) {
      markOrderTerminal(resolvedAccountNumber, orderId);
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

    if (isOvernightReductionOrderSource(order.source)) {
      const underlyingSymbol =
        String(order["underlying-symbol"] ?? "").toUpperCase() || undefined;
      results.push({
        cancelled: false,
        orderId,
        skippedReason: "protected overnight reduction order",
        underlyingSymbol,
      });
      continue;
    }

    // Spray-buy slices rest across cycles by design (a spray spans several
    // cycles); the spray executor — not the cancel sweep — owns their lifecycle.
    if (isSprayBuyOrderSource(order.source)) {
      results.push({
        cancelled: false,
        orderId,
        skippedReason: "protected spray-buy slice order",
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

    try {
      const response = await tastytradeApi.orderService.cancelOrder(
        resolvedAccountNumber,
        orderId,
      );
      results.push({
        cancelled: true,
        orderId,
        response,
      });
    } catch (err) {
      // If the broker rejects the cancel because the order is already terminal,
      // cache the order ID so we don't attempt it again next cycle.
      const message = err instanceof Error ? err.message : String(err);
      const isNotCancellable =
        /not cancell?able/i.test(message) ||
        /already.*(?:filled|cancelled|canceled|expired|rejected)/i.test(message) ||
        /order.*(?:filled|cancelled|canceled|expired|rejected)/i.test(message);
      if (isNotCancellable) {
        markOrderTerminal(resolvedAccountNumber, orderId);
      }
      results.push({
        cancelled: false,
        orderId,
        skippedReason: `cancel failed: ${message}`,
      });
    }
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

  const currentTime = evaluations[0]?.metrics.currentTime ?? new Date();

  const manageEvaluationCandidates = actionableEvaluations.filter(
    (evaluation) => evaluation.strategy.action === "MANAGE_ALLOCATION",
  );

  // During the overnight reduction window (7:30–11:30 AM), skip adding to overnight
  // cash positions unless a strong signal (crossAccountYes or strongStockYes) overrides.
  const gatedManageEvaluations = accountMarginOrCash === "cash" && isInOvernightReductionWindow(currentTime)
    ? (
        await Promise.all(
          manageEvaluationCandidates.map(async (evaluation) => {
            const signals = evaluation.executionTargets?.positionGate?.signals;
            if (signals?.crossAccountYes || signals?.strongStockYes) return evaluation;
            const symbol = String(evaluation.underlyingSymbol ?? "").toUpperCase();
            const overnight = await isOvernightPosition(accountNumber, symbol);
            return overnight ? null : evaluation;
          }),
        )
      ).filter((e) => e !== null)
    : manageEvaluationCandidates;

  const manageEvaluations = normalizeSelectedManageExposureTargets(
    selectManageEvaluationsByBuyingPower(gatedManageEvaluations, spendableFunds),
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
              {
                // EOD liquidation and stop-loss closes chase fast and cross to
                // the bid; take-profit closes keep the slow chase.
                isUrgentClose: evaluation.strategy.isUrgentClose === true,
                accountType: accountMarginOrCash === "unknown" ? undefined : accountMarginOrCash,
              },
            ),
          ),
        )
      ).flat();

  // Alert on any close that actually placed. Urgent closes (stop-loss / EOD
  // liquidation) route to hard-risk-close; normal closes (take-profit, etc.)
  // route to position-closed — both INFO, mutually exclusive so no double-fire.
  for (const evaluation of actionableCloseEvaluations) {
    const placed = closeOrders.some(
      (order) => order.underlyingSymbol === evaluation.underlyingSymbol && order.placedOrder,
    );
    if (!placed) continue;
    notifyEvent(
      evaluation.strategy.isUrgentClose === true ? "hard-risk-close" : "position-closed",
      `${accountNumber} ${evaluation.underlyingSymbol}: ${evaluation.strategy.reason}`,
    );
  }

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
      await recordPositionClosed(
        accountNumber,
        symbol,
        String(orderId),
        evaluation.positions[0]?.["created-at"],
      );
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