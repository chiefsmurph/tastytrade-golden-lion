import { getManagedAccountNumbers, getMarginAccountNumber } from "~/core/default-account";
import executePositionEvaluations, { cancelAllLiveOrders } from "./execute-position-evaluations";
import { appendRunHistory, RunCloseOrder, RunHistoryEntry } from "./run-history";
import { setLastBotRunState } from "./last-run-state";
import {
  buildRunCycleContext,
  RunCyclePreview,
  MultiAccountRunCyclePreview,
} from "./run-cycle-context";
import {
  logRunSnapshot,
  logGroupReturns,
  logExecutionTargetsByGroup,
  logRunPlan,
  logStrategyDecisions,
} from "./run-cycle-logging";
import { maybeSeedMarginAccountFromCashAccount } from "./run-cycle-seed";

export type { RunCyclePreview, MultiAccountRunCyclePreview };

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

  await cancelAllLiveOrders(accountNumber);

  const context = await buildRunCycleContext(accountNumber);
  console.log({ accountNumber: context.preview.accountNumber, run: "bot-cycle" });
  logCycle(context);

  const executionResults = await executePositionEvaluations(
    context.preview.accountNumber,
    context.accountBalances,
    context.completedEvaluations,
    context.runExecutionTargets,
  );

  const closedUnderlyingSymbolsThisRun = new Set(
    executionResults.closeOrders
      .filter((order) => order.placedOrder)
      .map((order) => String(order.underlyingSymbol ?? "").toUpperCase())
      .filter((symbol) => symbol.length > 0),
  );
  if (recentlyClosedByAccount) {
    recentlyClosedByAccount.set(
      context.preview.accountNumber,
      closedUnderlyingSymbolsThisRun,
    );
  }

  const marginAccountNumber = await getMarginAccountNumber();
  const excludedSeedSymbols =
    recentlyClosedByAccount?.get(marginAccountNumber) ?? new Set<string>();

  const cashAccountSeedResults = await maybeSeedMarginAccountFromCashAccount(
    context.preview.accountNumber,
    new Date(),
    excludedSeedSymbols,
    context.cachedSecretPositions,
  );

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
    seedEstimatedTotal: cashAccountSeedResults.reduce(
      (sum, order) => sum + (order.estimatedOrderCost ?? 0),
      0,
    ),
    seedPlacedCount: cashAccountSeedResults.filter((order) => order.placedOrder).length,
    seedSkippedCount: cashAccountSeedResults.filter((order) => !order.placedOrder).length,
  };

  const runHistoryEntry = await appendRunHistory({
    accountNumber: context.preview.accountNumber,
    closeOrders: mapCloseOrdersForRunHistory(executionResults.closeOrders),
    executionSummary,
    groups: context.preview.groups,
    plan: context.preview.plan,
    seedOrders: cashAccountSeedResults,
    strategyDecisions: context.strategyDecisions,
    snapshot: context.preview.snapshot,
  });

  setLastBotRunState(
    context.preview.accountNumber,
    context.completedEvaluations,
    executionResults,
  );

  console.log("Execution results:", JSON.stringify(executionResults, null, 2));

  return runHistoryEntry;
}
