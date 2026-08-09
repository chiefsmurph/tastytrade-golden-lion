import { getManagedAccountNumbers } from "~/core/default-account";
import { getContractMultiplier } from "./actions/order-utils";
import { getRecentRunHistory } from "./run-history";
import { getPstDateString } from "./day-report-store";

function getDateInPst(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });
}

export type CloseFill = {
  fillPrice: number | null;
  quantity: number | null;
  filledAt: string | null;
};

/** Fetch one order from the broker. Injected so tests need no network. Internal —
 *  callers pass a plain function, so this name never needs to leave the module. */
type GetOrderForBackfill = (
  accountNumber: string,
  orderId: number,
) => Promise<{ legs?: { fills?: Record<string, unknown>[] }[] } | null | undefined>;

/**
 * Pull the fills off a broker order response.
 *
 * WHY THIS IS NEEDED AT READ TIME
 * run-cycle's mapCloseOrdersForRunHistory reads fills from the order-PLACEMENT
 * response, which by definition has none — the limit order has only just been
 * created. Nothing ever revisits the entry, so a close that fills seconds later is
 * recorded permanently as `fills: []` with null realized P&L. On 2026-08-03 that hid
 * 2 of 3 fills and understated the day's realized P&L.
 *
 * The cycle cannot wait around for a fill, so reconciliation belongs here: this is a
 * reporting query, not a hot path, and asking the broker is the only source of truth.
 */
/**
 * Numeric field -> number | null. Guards the null/"" case explicitly because
 * Number(null) is 0, which would silently turn "the broker told us nothing" into
 * "zero contracts" — a quantity of 0 reads as a real value downstream.
 */
function numericOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** One broker fill row -> our shape. Split out so the mapper below stays trivial. */
function toCloseFill(raw: Record<string, unknown>): CloseFill {
  const at = String(raw["filled-at"] ?? "").trim();
  return {
    fillPrice: numericOrNull(raw["fill-price"]),
    quantity: numericOrNull(raw.quantity),
    filledAt: at || null,
  };
}

/**
 * Realized P&L for one close, in dollars and as a fraction of the entry price.
 *
 * The multiplier is derived from the symbol, NOT hard-coded to 100: both managed
 * accounts also carry manually-traded equity rows, and pricing a share round-trip
 * as if it were a 100-share contract inflated it 100×. Shared with pnl-ledger via
 * getContractMultiplier so the two reporters cannot drift apart again.
 */
export function computeCloseRealizedPnl(
  symbol: string,
  avgClosePrice: number,
  entryPrice: number,
  quantity: number,
): { realizedPnlDollars: number; realizedPnlPct: number } {
  return {
    realizedPnlDollars:
      (avgClosePrice - entryPrice) * quantity * getContractMultiplier(symbol),
    realizedPnlPct: (avgClosePrice - entryPrice) / entryPrice,
  };
}

/**
 * Per-unit cost basis implied by a group's total cost basis. Legacy fallback for
 * run-history entries written before weightedAverageFill existed; multiplier-aware
 * for the same reason as computeCloseRealizedPnl.
 */
export function impliedEntryPrice(
  symbol: string,
  totalCostBasis: number,
  totalUnits: number,
): number {
  if (!(totalUnits > 0)) return 0;
  return totalCostBasis / (totalUnits * getContractMultiplier(symbol));
}

export function extractFillsFromOrder(order: unknown): CloseFill[] {
  const legs = (order as { legs?: unknown })?.legs;
  if (!Array.isArray(legs)) return [];
  return legs.flatMap((leg) => {
    const fills = (leg as { fills?: unknown })?.fills;
    return Array.isArray(fills)
      ? fills.map((f) => toCloseFill(f as Record<string, unknown>))
      : [];
  });
}

// fallow-ignore-next-line complexity
async function getClosedPositionsTodayForAccount(
  accountNumber: string,
  todayDate: string,
  getOrder?: GetOrderForBackfill,
) {
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
    // set when the row was reconciled from the broker rather than the cycle snapshot
    backfilled?: boolean;
    // The group's weighted-average FILL price, i.e. our per-contract cost basis.
    // Carried so the backfill can price a recovered fill the same way the cycle-time
    // path does. Deriving entry from totalCostBasis / closedQty is WRONG: cost basis
    // covers the whole group, so a partial close divides by too few contracts and
    // inflates the implied entry (a 1-of-2 close doubled it).
    groupWeightedFill?: number;
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
        let fill = matchingGroup.legWeightedFills?.[closeOrder.symbol] ?? matchingGroup.weightedAverageFill ?? 0;
        if (!fill) {
          const totalSymbolFillQty = totalFillQtyBySymbol.get(sym) ?? totalFillQty;
          fill = impliedEntryPrice(closeOrder.symbol, matchingGroup.totalCostBasis, totalSymbolFillQty);
        }
        if (fill > 0) {
          ({ realizedPnlDollars, realizedPnlPct } = computeCloseRealizedPnl(
            closeOrder.symbol,
            avgFillPrice,
            fill,
            totalFillQty,
          ));
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
        backfilled: false,
        groupWeightedFill:
          matchingGroup?.legWeightedFills?.[closeOrder.symbol] ??
          matchingGroup?.weightedAverageFill ??
          undefined,
      });
    }
  }

  // ── Reconcile fills the cycle could not have seen ──────────────────────────
  // Any placed close with an orderId but no fills was recorded before the broker
  // reported one. Ask the broker now and recompute realized P&L from the answer.
  // Best-effort: a failed lookup leaves the row exactly as it was, so this can only
  // add information, never lose it.
  const needsBackfill = rawCloses.filter(
    (c) => c.orderId && c.fills.length === 0 && c.avgFillPrice == null,
  );
  if (needsBackfill.length && getOrder) {
    for (const close of needsBackfill) {
      try {
        const numericId = Number(close.orderId);
        if (!Number.isFinite(numericId)) continue;
        const order = await getOrder(accountNumber, numericId);
        const fills = extractFillsFromOrder(order);
        if (!fills.length) continue;

        const qty = fills.reduce((s, f) => s + (Number(f.quantity) || 0), 0);
        if (qty <= 0) continue;
        const avg =
          fills.reduce((s, f) => s + (Number(f.fillPrice) || 0) * (Number(f.quantity) || 0), 0) /
          qty;

        close.fills = fills;
        close.avgFillPrice = avg;
        close.closedAt = fills[0]?.filledAt ?? null;
        close.backfilled = true;

        // Price it off the group's weighted-average fill — the same basis the
        // cycle-time path uses. If that is unavailable we leave realized P&L NULL
        // rather than guess: deriving entry from totalCostBasis / closedQty is wrong
        // for a partial close (cost basis spans the whole group), and a confidently
        // wrong P&L is worse than an admitted gap.
        const entry = close.groupWeightedFill;
        if (entry != null && entry > 0) {
          const pnl = computeCloseRealizedPnl(close.symbol, avg, entry, qty);
          close.realizedPnlDollars = pnl.realizedPnlDollars;
          close.realizedPnlPct = pnl.realizedPnlPct;
        }
      } catch {
        // Leave the row untouched — an unreachable broker must not corrupt a report.
      }
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

/**
 * Default broker lookup for the fill backfill. Imported lazily so this module stays
 * importable (and testable) without a broker session.
 */
const defaultGetOrder: GetOrderForBackfill = async (accountNumber, orderId) => {
  const { default: tastytradeApi } = await import("~/core/tastytrade-client");
  return tastytradeApi.orderService.getOrder(accountNumber, orderId) as ReturnType<
    GetOrderForBackfill
  >;
};

async function getClosedPositionsToday(
  args: string[],
  getOrder: GetOrderForBackfill = defaultGetOrder,
): Promise<unknown> {
  const [accountNumberArg] = args;
  const accountNumber = accountNumberArg?.trim() || null;
  const today = getPstDateString();

  if (accountNumber) {
    return getClosedPositionsTodayForAccount(accountNumber, today, getOrder);
  }

  const accountNumbers = await getManagedAccountNumbers();
  if (accountNumbers.length === 1) {
    return getClosedPositionsTodayForAccount(accountNumbers[0], today, getOrder);
  }

  return Promise.all(
    accountNumbers.map((acc) => getClosedPositionsTodayForAccount(acc, today, getOrder)),
  );
}

export default getClosedPositionsToday;
