import { getManagedAccountNumbers } from "~/core/default-account";
import { buildDayReportForAccount } from "./record-day-report";
import { getLatestDayReport, DayReportGroup } from "./day-report-store";

interface GroupDelta {
  underlyingSymbol: string;
  side: "call" | "put" | "none";
  isNew: boolean;
  current: DayReportGroup;
  delta: {
    bidReturnPctDelta: number;
    askReturnPctDelta: number;
    midReturnPctDelta: number;
    unrealizedBidDelta: number;
    unrealizedAskDelta: number;
    unrealizedMidDelta: number;
  } | null;
}

async function buildTrendForAccount(accountNumber: string) {
  const [baseline, current] = await Promise.all([
    getLatestDayReport(accountNumber),
    buildDayReportForAccount(accountNumber),
  ]);

  if (!baseline) {
    return {
      accountNumber,
      baselineTimestamp: null,
      currentTimestamp: new Date().toISOString(),
      baseline: null,
      current,
      delta: null,
      groupDeltas: current.groups.map((g) => ({
        underlyingSymbol: g.underlyingSymbol,
        side: g.side,
        isNew: true,
        current: g,
        delta: null,
      })) as GroupDelta[],
      closedSinceBaseline: [],
    };
  }

  const netLiqDelta = current.netLiquidatingValue - baseline.netLiquidatingValue;
  const netLiqDeltaPct =
    baseline.netLiquidatingValue > 0 ? netLiqDelta / baseline.netLiquidatingValue : 0;

  const baselineBySymbol = new Map(baseline.groups.map((g) => [g.underlyingSymbol, g]));

  const groupDeltas: GroupDelta[] = current.groups.map((group) => {
    const base = baselineBySymbol.get(group.underlyingSymbol);
    if (!base) {
      return { underlyingSymbol: group.underlyingSymbol, side: group.side, isNew: true, current: group, delta: null };
    }
    return {
      underlyingSymbol: group.underlyingSymbol,
      side: group.side,
      isNew: false,
      current: group,
      delta: {
        bidReturnPctDelta: group.bidReturnPct - base.bidReturnPct,
        askReturnPctDelta: group.askReturnPct - base.askReturnPct,
        midReturnPctDelta: group.midReturnPct - base.midReturnPct,
        unrealizedBidDelta: group.totalUnrealizedReturnBid - base.totalUnrealizedReturnBid,
        unrealizedAskDelta: group.totalUnrealizedReturnAsk - base.totalUnrealizedReturnAsk,
        unrealizedMidDelta: group.totalUnrealizedReturnMid - base.totalUnrealizedReturnMid,
      },
    };
  });

  const currentSymbols = new Set(current.groups.map((g) => g.underlyingSymbol));
  const closedSinceBaseline = baseline.groups
    .filter((g) => !currentSymbols.has(g.underlyingSymbol))
    .map((g) => ({ underlyingSymbol: g.underlyingSymbol, side: g.side, baseline: g }));

  return {
    accountNumber,
    baselineTimestamp: baseline.timestamp,
    baselineDate: baseline.date,
    currentTimestamp: new Date().toISOString(),
    delta: {
      netLiqDelta,
      netLiqDeltaPct,
      totalUnrealizedBidDelta:
        current.summary.totalUnrealizedReturnBid - baseline.summary.totalUnrealizedReturnBid,
      totalUnrealizedAskDelta:
        current.summary.totalUnrealizedReturnAsk - baseline.summary.totalUnrealizedReturnAsk,
      totalUnrealizedMidDelta:
        current.summary.totalUnrealizedReturnMid - baseline.summary.totalUnrealizedReturnMid,
    },
    current: {
      netLiquidatingValue: current.netLiquidatingValue,
      totalCapital: current.totalCapital,
      summary: current.summary,
    },
    baseline: {
      netLiquidatingValue: baseline.netLiquidatingValue,
      totalCapital: baseline.totalCapital,
      summary: baseline.summary,
    },
    groupDeltas,
    closedSinceBaseline,
  };
}

export async function getDayTrend(args: string[]): Promise<unknown> {
  const [accountNumberArg] = args;
  const accountNumber = accountNumberArg?.trim() || null;

  if (accountNumber) {
    return buildTrendForAccount(accountNumber);
  }

  const accountNumbers = await getManagedAccountNumbers();
  if (accountNumbers.length === 1) {
    return buildTrendForAccount(accountNumbers[0]);
  }

  return Promise.all(accountNumbers.map(buildTrendForAccount));
}

export default getDayTrend;
