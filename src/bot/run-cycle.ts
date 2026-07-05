import { getManagedAccountNumbers, getMarginAccountNumber } from "~/core/default-account";
import executePositionEvaluations, { cancelAllLiveOrders } from "./execute-position-evaluations";
import { appendRunHistory, appendRunHistoryError, RunAllocationOrder, RunCloseOrder, RunHistoryEntry } from "./run-history";
import { notifyEvent } from "./notify";
import { setLastBotRunState } from "./last-run-state";
import {
  buildRunCycleContext,
  RunCyclePreview,
  MultiAccountRunCyclePreview,
} from "./run-cycle-context";
import { maybeRecordDayReport } from "./record-day-report";
import {
  logRunSnapshot,
  logGroupReturns,
  logExecutionTargetsByGroup,
  logRunPlan,
  logStrategyDecisions,
} from "./run-cycle-logging";
import { maybeSeedMarginAccountFromCashAccount, maybeSeedCashAccountFromMarginAccount } from "./run-cycle-seed";
import {
  pruneOldEntries,
  isOvernightPosition,
  syncPositionOpens,
  PositionOpenSnapshot,
} from "./position-registry";
import { executeOvernightReductions } from "./overnight-position-reduction";
import { PositionGroupEvaluation } from "./evaluate-position";
import { getEffectiveTotalCapital } from "~/core/account-balance";

export type { RunCyclePreview, MultiAccountRunCyclePreview };

// When an allocation buy brings a group to at least this fraction of its gate
// target exposure, emit a position-built INFO notification — the bot has
// accumulated most of the size it intended for that name. Fires on the crossing
// only; re-arms when the fraction falls back below the lower band, so hovering
// near the line or repeated top-offs don't spam. A genuine target jump that
// reopens headroom and rebuilds past the line does re-fire (once), which is the
// intended awareness. State is in-memory, so a restart re-arms every position
// (at most one extra fire per built-out name after a restart).
const POSITION_BUILT_TARGET_FRACTION = 0.75;
const POSITION_BUILT_REARM_FRACTION = 0.70;
const positionBuiltNotified = new Set<string>();

function toPositionOpenSnapshots(
  evaluations: PositionGroupEvaluation[],
): PositionOpenSnapshot[] {
  const snapshots: PositionOpenSnapshot[] = [];

  for (const evaluation of evaluations) {
    const symbol = String(evaluation.underlyingSymbol ?? "").toUpperCase();
    const side = evaluation.groupKey?.split("::")[1];
    if (!symbol || (side !== "call" && side !== "put")) continue;

    const createdAts = evaluation.positions
      .map((position) => position["created-at"])
      .filter((value): value is string => Boolean(value));
    if (createdAts.length === 0) continue;

    snapshots.push({ symbol, side, openedAt: createdAts.sort()[0] });
  }

  return snapshots;
}

async function withOvernightCloseOverrides(
  accountNumber: string,
  evaluations: PositionGroupEvaluation[],
): Promise<PositionGroupEvaluation[]> {
  return Promise.all(
    evaluations.map(async (evaluation) => {
      if (evaluation.strategy.action !== "MANAGE_ALLOCATION") return evaluation;
      const symbol = String(evaluation.underlyingSymbol ?? "").toUpperCase();
      if (!symbol) return evaluation;
      const overnight = await isOvernightPosition(accountNumber, symbol);
      if (!overnight) return evaluation;
      return {
        ...evaluation,
        strategy: {
          action: "CLOSE_POSITION" as const,
          reason: "overnight margin position — force-close at open",
        },
      };
    }),
  );
}

function parseOptionalNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapCloseOrdersForRunHistory(
  closeOrders: Awaited<ReturnType<typeof executePositionEvaluations>>["closeOrders"],
): RunCloseOrder[] {
  return closeOrders.map((result) => {
    const order = result.orderResponse?.order;
    const legs = Array.isArray(order?.legs) ? order.legs : [];
    const fills = legs.flatMap((leg) =>
      (Array.isArray(leg.fills) ? leg.fills : []).map((fill) => ({
        fillId: String(fill["fill-id"] ?? "").trim() || null,
        fillPrice: parseOptionalNumber(fill["fill-price"]),
        filledAt: String(fill["filled-at"] ?? "").trim() || null,
        quantity: parseOptionalNumber(fill.quantity),
      })),
    );

    return {
      fills,
      orderId: String(order?.id ?? "").trim() || null,
      placedOrder: result.placedOrder,
      price: parseOptionalNumber(order?.price),
      skippedReason: result.skippedReason ?? null,
      status: String(order?.status ?? "").trim() || null,
      symbol: result.symbol,
      underlyingSymbol: result.underlyingSymbol,
    };
  });
}

function logCycle(context: Awaited<ReturnType<typeof buildRunCycleContext>>): void {
  logRunSnapshot(context.preview);
  logGroupReturns(context.preview.groups);
  logExecutionTargetsByGroup(
    context.evaluationsWithGroupTargets,
    context.baseExecutionTargets,
    new Date(),
    context.accountMarginOrCash,
  );
  logRunPlan(context.preview);
  logStrategyDecisions(context.strategyDecisions);
}

export async function getRunCyclePreview(): Promise<MultiAccountRunCyclePreview>;
export async function getRunCyclePreview(accountNumber: string): Promise<RunCyclePreview>;
export async function getRunCyclePreview(
  accountNumber?: string,
): Promise<RunCyclePreview | MultiAccountRunCyclePreview> {
  if (!accountNumber) {
    const accountNumbers = await getManagedAccountNumbers();
    const accounts = await Promise.all(
      accountNumbers.map(async (managedAccountNumber) => {
        const context = await buildRunCycleContext(managedAccountNumber);
        return context.preview;
      }),
    );

    return { accounts };
  }

  const context = await buildRunCycleContext(accountNumber);
  return context.preview;
}

export async function runBotCycleLogOnly(): Promise<MultiAccountRunCyclePreview>;
export async function runBotCycleLogOnly(accountNumber: string): Promise<RunCyclePreview>;
export async function runBotCycleLogOnly(
  accountNumber?: string,
): Promise<RunCyclePreview | MultiAccountRunCyclePreview> {
  if (!accountNumber) {
    const accountNumbers = await getManagedAccountNumbers();
    const accounts: RunCyclePreview[] = [];

    for (const managedAccountNumber of accountNumbers) {
      const context = await buildRunCycleContext(managedAccountNumber);
      console.log({ accountNumber: context.preview.accountNumber, run: "bot-cycle-log-only" });
      logCycle(context);
      accounts.push(context.preview);
    }

    return { accounts };
  }

  const context = await buildRunCycleContext(accountNumber);
  console.log({ accountNumber: context.preview.accountNumber, run: "bot-cycle-log-only" });
  logCycle(context);
  return context.preview;
}

export default async function runBotCycle(): Promise<RunHistoryEntry[]>;
export default async function runBotCycle(accountNumber: string): Promise<RunHistoryEntry>;
export default async function runBotCycle(
  accountNumber: string,
  recentlyClosedByAccount: Map<string, Set<string>>,
): Promise<RunHistoryEntry>;
export default async function runBotCycle(
  accountNumber?: string,
  recentlyClosedByAccount?: Map<string, Set<string>>,
): Promise<RunHistoryEntry | RunHistoryEntry[]> {
  if (!accountNumber) {
    const accountNumbers = await getManagedAccountNumbers();
    const results: RunHistoryEntry[] = [];
    const closedSymbolsByAccount = new Map<string, Set<string>>();

    for (const managedAccountNumber of accountNumbers) {
      const result = await runBotCycle(managedAccountNumber, closedSymbolsByAccount);
      results.push(result as RunHistoryEntry);
    }

    return results;
  }

  try {
  await cancelAllLiveOrders(accountNumber);
  await pruneOldEntries();

  const context = await buildRunCycleContext(accountNumber);
  console.log({ accountNumber: context.preview.accountNumber, run: "bot-cycle" });
  logCycle(context);

  // Backfill registry opens from broker created-at before anything reads
  // isOvernightPosition/getPositionAgeDays this cycle.
  await syncPositionOpens(
    context.preview.accountNumber,
    toPositionOpenSnapshots(context.evaluationsWithGroupTargets),
  );

  const evaluationsForExecution =
    context.accountMarginOrCash === "margin"
      ? await withOvernightCloseOverrides(
          context.preview.accountNumber,
          context.evaluationsWithGroupTargets,
        )
      : context.evaluationsWithGroupTargets;

  const executionResults = await executePositionEvaluations(
    context.preview.accountNumber,
    context.accountBalances,
    evaluationsForExecution,
    context.runExecutionTargets,
  );

  const closedUnderlyingSymbolsThisRun = new Set(
    executionResults.closeOrders
      .filter((order) => order.placedOrder)
      .map((order) => String(order.underlyingSymbol ?? "").toUpperCase())
      .filter((symbol) => symbol.length > 0),
  );

  const overnightReductionOrders =
    context.accountMarginOrCash === "cash"
      ? await executeOvernightReductions(
          context.preview.accountNumber,
          context.completedEvaluations,
          context.runExecutionTargets,
          getEffectiveTotalCapital(context.accountBalances),
          closedUnderlyingSymbolsThisRun,
          new Date(),
        )
      : [];

  if (recentlyClosedByAccount) {
    recentlyClosedByAccount.set(
      context.preview.accountNumber,
      closedUnderlyingSymbolsThisRun,
    );
  }

  const marginAccountNumber = await getMarginAccountNumber();
  const excludedSeedSymbols =
    recentlyClosedByAccount?.get(marginAccountNumber) ?? new Set<string>();

  const [marginSeedResults, cashSeedFromMarginResults] = await Promise.all([
    maybeSeedMarginAccountFromCashAccount(
      context.preview.accountNumber,
      new Date(),
      excludedSeedSymbols,
      context.cachedSecretPositions,
    ),
    maybeSeedCashAccountFromMarginAccount(
      context.preview.accountNumber,
      new Date(),
      closedUnderlyingSymbolsThisRun,
      context.cachedSecretPositions,
    ),
  ]);
  const allSeedResults = [...marginSeedResults, ...cashSeedFromMarginResults];

  const executionSummary = {
    allocationEstimatedTotal: executionResults.allocationOrders.reduce(
      (sum, order) => sum + (order.estimatedOrderValue ?? 0),
      0,
    ),
    allocationPlacedCount: executionResults.allocationOrders.filter(
      (order) => order.placedOrder,
    ).length,
    allocationSkippedCount: executionResults.allocationOrders.filter(
      (order) => !order.placedOrder,
    ).length,
    cancelledOrderCount: executionResults.cancelledOrders.filter(
      (order) => order.cancelled,
    ).length,
    closeOrderCount: executionResults.closeOrders.length,
    overnightReductionOrderCount: overnightReductionOrders.length,
    overnightReductionPlacedCount: overnightReductionOrders.filter((o) => o.placedOrder).length,
    seedEstimatedTotal: allSeedResults.reduce(
      (sum, order) => sum + (order.estimatedOrderCost ?? 0),
      0,
    ),
    seedPlacedCount: allSeedResults.filter((order) => order.placedOrder).length,
    seedSkippedCount: allSeedResults.filter((order) => !order.placedOrder).length,
  };

  const allocationOrders: RunAllocationOrder[] = executionResults.allocationOrders.flatMap(
    (result) =>
      result.routeOrders.map((routeOrder) => ({
        estimatedOrderValue: routeOrder.estimatedOrderValue,
        limitPrice: routeOrder.limitPrice,
        orderId: routeOrder.orderResponse?.order?.id ?? null,
        placedOrder: routeOrder.placedOrder,
        quantity: routeOrder.quantity,
        route: routeOrder.route,
        skippedReason: routeOrder.skippedReason ?? null,
        symbol: result.candidateSymbol ?? null,
        underlyingSymbol: result.underlyingSymbol,
      })),
  );

  // Awareness: an allocation buy has built a group out to most of the size the
  // strategy intended for it (its gate target exposure). Fires on the crossing
  // up (not every cycle it sits above the line), re-arms only when it falls
  // back below the lower band. Placement-based (confirmed-fill tracking isn't
  // plumbed).
  const totalCapital = context.preview.snapshot.totalCapital;
  if (totalCapital > 0) {
    // symbol -> estimated $ bought this cycle (placed orders only)
    const boughtThisCycle = new Map<string, number>();
    for (const result of executionResults.allocationOrders) {
      if (!result.placedOrder) continue;
      boughtThisCycle.set(
        result.underlyingSymbol,
        (boughtThisCycle.get(result.underlyingSymbol) ?? 0) + (result.estimatedOrderValue ?? 0),
      );
    }

    for (const group of context.preview.groups) {
      const maxTargetPct = group.positionGate?.maxTargetPct ?? null;
      if (maxTargetPct == null || !(maxTargetPct > 0)) continue;

      const key = `${context.preview.accountNumber}:${group.underlyingSymbol}`;
      const targetValue = maxTargetPct * totalCapital;
      const boughtValue = boughtThisCycle.get(group.underlyingSymbol) ?? 0;
      const postBuyValue = group.totalCostBasis + boughtValue;
      const fractionOfTarget = postBuyValue / targetValue;

      // Re-arm once it drops below the lower band (target rose, or decay).
      if (fractionOfTarget < POSITION_BUILT_REARM_FRACTION) {
        positionBuiltNotified.delete(key);
        continue;
      }

      // Fire only when a buy this cycle carried it across the line the first time.
      if (
        boughtValue > 0 &&
        fractionOfTarget >= POSITION_BUILT_TARGET_FRACTION &&
        !positionBuiltNotified.has(key)
      ) {
        positionBuiltNotified.add(key);
        notifyEvent(
          "position-built",
          `${context.preview.accountNumber} ${group.underlyingSymbol}: built to ${(fractionOfTarget * 100).toFixed(0)}% of target (~$${postBuyValue.toFixed(0)} of $${targetValue.toFixed(0)})`,
        );
      }
    }
  }

  const runHistoryEntry = await appendRunHistory({
    accountNumber: context.preview.accountNumber,
    allocationOrders,
    closeOrders: mapCloseOrdersForRunHistory([
      ...executionResults.closeOrders,
      ...overnightReductionOrders,
    ]),
    executionSummary,
    groups: context.preview.groups,
    plan: context.preview.plan,
    seedOrders: allSeedResults,
    strategyDecisions: context.strategyDecisions,
    snapshot: context.preview.snapshot,
  });

  setLastBotRunState(
    context.preview.accountNumber,
    context.completedEvaluations,
    executionResults,
  );

  console.log("Execution results:", JSON.stringify(executionResults, null, 2));

  try {
    await maybeRecordDayReport(
      context.preview.accountNumber,
      context.accountBalances,
      context.preview.groups,
      context.preview.snapshot.totalCapital,
    );
  } catch (error) {
    console.error("Failed to record day report:", error);
  }

  return runHistoryEntry;
  } catch (error) {
    await appendRunHistoryError(accountNumber, error);
    notifyEvent(
      "cycle-exception",
      `${accountNumber}: cycle threw — ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}
