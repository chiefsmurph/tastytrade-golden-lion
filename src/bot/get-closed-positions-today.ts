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

  // Collect all placed closes with their realized P&L
  const rawCloses: {
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
    realizedPnlDollars: number | null;
    realizedPnlPct: number | null;
  }[] = [];

  for (const entry of todayEntries) {
    // Pass 1: total fill contracts per underlying in this cycle, for fallback cost basis.
    // Needed for entries written before weightedAverageFill was stored in RunGroupReturn.
    const totalFillQtyBySymbol = new Map<string, number>();
    for (const closeOrder of entry.closeOrders) {
      if (!closeOrder.placedOrder) continue;
      const sym = closeOrder.underlyingSymbol.toUpperCase();
      const qty = closeOrder.fills.reduce((s, f) => s + (Number(f.quantity) || 0), 0);
      totalFillQtyBySymbol.set(sym, (totalFillQtyBySymbol.get(sym) ?? 0) + qty);
    }

    for (const closeOrder of entry.closeOrders) {
      if (!closeOrder.placedOrder) continue;

      const sym = closeOrder.underlyingSymbol.toUpperCase();
      const matchingGroup = entry.groups.find(
        (g) => g.underlyingSymbol.toUpperCase() === sym,
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
        // Prefer stored weightedAverageFill (new entries). Fall back to estimating from
        // totalCostBasis / (all fill contracts for this symbol * 100) for older entries
        // that predate the weightedAverageFill field.
        let fill = matchingGroup.weightedAverageFill ?? 0;
        if (!fill) {
          const totalSymbolFillQty = totalFillQtyBySymbol.get(sym) ?? totalFillQty;
          if (totalSymbolFillQty > 0) {
            fill = matchingGroup.totalCostBasis / (totalSymbolFillQty * 100);
          }
        }
        if (fill > 0) {
          realizedPnlDollars = (avgFillPrice - fill) * totalFillQty * 100;
          realizedPnlPct = (avgFillPrice - fill) / fill;
        }
      }

      const midReturnPct =
        matchingGroup != null
          ? (matchingGroup.bidReturnPct + matchingGroup.askReturnPct) / 2
          : null;

      rawCloses.push({
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
        realizedPnlDollars,
        realizedPnlPct,
      });
    }
  }

  // Group by underlying symbol
  const bySymbol = new Map<string, typeof rawCloses>();
  for (const close of rawCloses) {
    const key = close.underlyingSymbol.toUpperCase();
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key)!.push(close);
  }

  const closes = [...bySymbol.entries()].map(([, symbolCloses]) => {
    const totalRealizedPnlDollars = symbolCloses.reduce(
      (s, c) => s + (c.realizedPnlDollars ?? 0),
      0,
    );
    const totalCostBasis = symbolCloses.reduce((s, c) => s + (c.totalCostBasis ?? 0), 0);
    const realizedPnlPct = totalCostBasis > 0 ? totalRealizedPnlDollars / totalCostBasis : null;
    const first = symbolCloses[0]!;
    return {
      underlyingSymbol: first.underlyingSymbol,
      closeCount: symbolCloses.length,
      totalRealizedPnlDollars,
      realizedPnlPct,
      orders: symbolCloses,
    };
  });

  const totalRealizedPnlDollars = closes.reduce(
    (s, c) => s + c.totalRealizedPnlDollars,
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
