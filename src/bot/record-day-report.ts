import { getAccountBalanceNumber } from "~/core/account-balance";
import { TastytradeAccountBalance } from "~/core/types";
import { buildRunCycleContext } from "./run-cycle-context";
import {
  appendDayReport,
  getLatestDayReport,
  getPstDateString,
  getPstTimeInMinutes,
  DayReportEntry,
  DayReportGroup,
} from "./day-report-store";
import type { RunGroupReturn } from "./run-history";

const ONE_PM_PST_MINUTES = 13 * 60; // 780

export function isDayReportTime(): boolean {
  return getPstTimeInMinutes() >= ONE_PM_PST_MINUTES;
}

function buildGroupsFromRunGroups(runGroups: RunGroupReturn[]): DayReportGroup[] {
  return runGroups.map((group) => {
    const midReturnPct = (group.bidReturnPct + group.askReturnPct) / 2;
    const totalUnrealizedReturnMid =
      (group.totalUnrealizedReturnBid + group.totalUnrealizedReturnAsk) / 2;
    return {
      underlyingSymbol: group.underlyingSymbol,
      side: group.side,
      bidReturnPct: group.bidReturnPct,
      askReturnPct: group.askReturnPct,
      midReturnPct,
      totalUnrealizedReturnBid: group.totalUnrealizedReturnBid,
      totalUnrealizedReturnAsk: group.totalUnrealizedReturnAsk,
      totalUnrealizedReturnMid,
      totalCostBasis: group.totalCostBasis,
    };
  });
}

export function buildDayReportInput(
  accountNumber: string,
  accountBalances: TastytradeAccountBalance,
  runGroups: RunGroupReturn[],
  totalCapital: number,
): Omit<DayReportEntry, "id" | "timestamp"> {
  const groups = buildGroupsFromRunGroups(runGroups);
  return {
    accountNumber,
    date: getPstDateString(),
    netLiquidatingValue: getAccountBalanceNumber(accountBalances, "net-liquidating-value"),
    totalCapital,
    derivativeBuyingPower: getAccountBalanceNumber(accountBalances, "derivative-buying-power"),
    cashBalance: getAccountBalanceNumber(accountBalances, "cash-balance"),
    groups,
    summary: {
      openPositionCount: groups.length,
      totalUnrealizedReturnBid: groups.reduce((s, g) => s + g.totalUnrealizedReturnBid, 0),
      totalUnrealizedReturnAsk: groups.reduce((s, g) => s + g.totalUnrealizedReturnAsk, 0),
      totalUnrealizedReturnMid: groups.reduce((s, g) => s + g.totalUnrealizedReturnMid, 0),
      totalCostBasis: groups.reduce((s, g) => s + g.totalCostBasis, 0),
    },
  };
}

// Called from runBotCycle — reuses data already fetched during the cycle.
export async function maybeRecordDayReport(
  accountNumber: string,
  accountBalances: TastytradeAccountBalance,
  runGroups: RunGroupReturn[],
  totalCapital: number,
): Promise<DayReportEntry | null> {
  if (!isDayReportTime()) return null;

  const today = getPstDateString();
  const existing = await getLatestDayReport(accountNumber);
  if (existing?.date === today) return null;

  const input = buildDayReportInput(accountNumber, accountBalances, runGroups, totalCapital);
  const entry = await appendDayReport(input);

  console.log(
    JSON.stringify({
      scope: "day-report-recorded",
      accountNumber,
      date: today,
      netLiquidatingValue: entry.netLiquidatingValue,
      openPositionCount: entry.summary.openPositionCount,
      timestamp: entry.timestamp,
    }),
  );

  return entry;
}

// Called from IPC routes — fetches fresh data.
export async function buildDayReportForAccount(
  accountNumber: string,
): Promise<Omit<DayReportEntry, "id" | "timestamp">> {
  const context = await buildRunCycleContext(accountNumber);
  return buildDayReportInput(
    context.preview.accountNumber,
    context.accountBalances,
    context.preview.groups,
    context.preview.snapshot.totalCapital,
  );
}
