import { getManagedAccountNumbers } from "~/core/default-account";
import { getRecentRunHistory } from "./run-history";
import { getPstDateString } from "./day-report-store";

function getDateInPst(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });
}

async function getClosedPositionsTodayForAccount(accountNumber: string, todayDate: string) {
  // 200 covers a full trading day at default 4-min intervals
  const entries = await getRecentRunHistory(200, accountNumber);
  const todayEntries = entries.filter((e) => getDateInPst(e.timestamp) === todayDate);

  const closes: {
    underlyingSymbol: string;
    symbol: string;
    orderId: string | null;
    closedAt: string | null;
    avgFillPrice: number | null;
    fills: { fillPrice: number | null; quantity: number | null; filledAt: string | null }[];
    cycleTimestamp: string;
    bidReturnPctAtClose: number | null;
    askReturnPctAtClose: number | null;
    midReturnPctAtClose: number | null;
    totalCostBasis: number | null;
    totalUnrealizedReturnBidAtClose: number | null;
    totalUnrealizedReturnAskAtClose: number | null;
    realizedPnlDollars: number | null;
    realizedPnlPct: number | null;
  }[] = [];

  for (const entry of todayEntries) {
    for (const closeOrder of entry.closeOrders) {
      if (!closeOrder.placedOrder) continue;

      const matchingGroup = entry.groups.find(
        (g) => g.underlyingSymbol.toUpperCase() === closeOrder.underlyingSymbol.toUpperCase(),
      );

      const totalFillQty = closeOrder.fills.reduce(
        (s, f) => s + (Number(f.quantity) || 0),
        0,
      );
      const avgFillPrice =
        totalFillQty > 0
          ? closeOrder.fills.reduce(
              (s, f) => s + (Number(f.fillPrice) || 0) * (Number(f.quantity) || 0),
              0,
            ) / totalFillQty
          : null;

      let realizedPnlDollars: number | null = null;
      let realizedPnlPct: number | null = null;

      if (matchingGroup && totalFillQty > 0 && avgFillPrice != null) {
        // totalCostBasis = weightedAverageFill * totalQuantityWeight
        // For a full close, totalQuantityWeight = totalFillQty * 100 (standard option multiplier)
        const totalQuantityWeight = totalFillQty * 100;
        const costBasisPerUnit = matchingGroup.totalCostBasis / totalQuantityWeight;
        if (costBasisPerUnit > 0) {
          realizedPnlDollars = (avgFillPrice - costBasisPerUnit) * totalQuantityWeight;
          realizedPnlPct = (avgFillPrice - costBasisPerUnit) / costBasisPerUnit;
        }
      }

      const midReturnPct =
        matchingGroup != null
          ? (matchingGroup.bidReturnPct + matchingGroup.askReturnPct) / 2
          : null;

      closes.push({
        underlyingSymbol: closeOrder.underlyingSymbol,
        symbol: closeOrder.symbol,
        orderId: closeOrder.orderId,
        closedAt: closeOrder.fills[0]?.filledAt ?? null,
        avgFillPrice,
        fills: closeOrder.fills.map((f) => ({
          fillPrice: Number(f.fillPrice) || null,
          quantity: Number(f.quantity) || null,
          filledAt: f.filledAt,
        })),
        cycleTimestamp: entry.timestamp,
        bidReturnPctAtClose: matchingGroup?.bidReturnPct ?? null,
        askReturnPctAtClose: matchingGroup?.askReturnPct ?? null,
        midReturnPctAtClose: midReturnPct,
        totalCostBasis: matchingGroup?.totalCostBasis ?? null,
        totalUnrealizedReturnBidAtClose: matchingGroup?.totalUnrealizedReturnBid ?? null,
        totalUnrealizedReturnAskAtClose: matchingGroup?.totalUnrealizedReturnAsk ?? null,
        realizedPnlDollars,
        realizedPnlPct,
      });
    }
  }

  const totalRealizedPnlDollars = closes.reduce(
    (s, c) => s + (c.realizedPnlDollars ?? 0),
    0,
  );

  return {
    accountNumber,
    date: todayDate,
    closedPositionCount: closes.length,
    totalRealizedPnlDollars,
    closes,
  };
}

export async function getClosedPositionsToday(args: string[]): Promise<unknown> {
  const [accountNumberArg] = args;
  const accountNumber = accountNumberArg?.trim() || null;
  const today = getPstDateString();

  if (accountNumber) {
    return getClosedPositionsTodayForAccount(accountNumber, today);
  }

  const accountNumbers = await getManagedAccountNumbers();
  if (accountNumbers.length === 1) {
    return getClosedPositionsTodayForAccount(accountNumbers[0], today);
  }

  return Promise.all(accountNumbers.map((acc) => getClosedPositionsTodayForAccount(acc, today)));
}

export default getClosedPositionsToday;
