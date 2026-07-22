import { getAccountBalanceNumber } from "~/core/account-balance";
import { TastytradeAccountBalance } from "~/core/types";
import { EOD_FORCED_CLOSE_MINUTE } from "~/strategy/spread-thresholds";
import { buildRunCycleContext } from "./run-cycle-context";
import {
  appendDayReport,
  getLatestDayReport,
  getPstDateString,
  getPstTimeInMinutes,
  DayReportEntry,
  DayReportGroup,
} from "./day-report-store";
import { getSeedRejectionScoreboard } from "./seed-rejection-scoreboard";
import type { RunGroupReturn } from "./run-history";

// The day-report snapshot must be recorded on the last *live* cycle of the day.
// The scheduler only calls runBotCycle while the regular equities session is
// open, which ends at 1:00 PM PT — so a gate at 1:00 PM never overlaps a running
// cycle and the report never writes. Anchor to the margin EOD forced-close
// minute (12:55 PM PT) instead: by then the day's liquidation has run, yet the
// market is still open, so the final pre-close cycle captures the settled
// end-of-day state. The once-per-day dedup in maybeRecordDayReport keeps this to
// a single write per account even though several cycles now pass the gate.
const DAY_REPORT_MINUTE = EOD_FORCED_CLOSE_MINUTE; // 12:55 PM PT

export function isDayReportTime(): boolean {
  return getPstTimeInMinutes() >= DAY_REPORT_MINUTE;
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
  const date = getPstDateString();
  return {
    accountNumber,
    date,
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
      seedRejections: getSeedRejectionScoreboard(accountNumber, date),
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

// Force-records a snapshot immediately, bypassing the time gate. Used for manual seeding.
export async function recordDayReportNow(accountNumber?: string): Promise<DayReportEntry[]> {
  const { getManagedAccountNumbers } = await import("~/core/default-account");
  const accountNumbers = accountNumber?.trim()
    ? [accountNumber.trim()]
    : await getManagedAccountNumbers();
  return Promise.all(
    accountNumbers.map(async (acc) => {
      const input = await buildDayReportForAccount(acc);
      return appendDayReport(input);
    }),
  );
}
