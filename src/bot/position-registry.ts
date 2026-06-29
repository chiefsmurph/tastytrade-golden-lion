import * as fs from "fs/promises";
import * as path from "path";
import tastytradeApi from "~/core/tastytrade-client";

export interface PositionRegistryEntry {
  accountNumber: string;
  symbol: string;
  side: "call" | "put";
  openedAt: string;

  // Populated when CLOSE_POSITION order is placed
  closingOrderId?: string;
  closingInitiatedAt?: string;
  openPriceAtClose?: number;    // WAF at time of close (may differ from original if averaged in)
  totalQuantityWeight?: number;

  // Populated after reconcile confirms the fill
  closedAt?: string;
  closePrice?: number;
  returnPct?: number;
  returnAbs?: number;
}

type RegistryKey = string; // `${accountNumber}:${symbol.toUpperCase()}`
type RegistryData = Record<RegistryKey, PositionRegistryEntry>;

function getRegistryPath(): string {
  const dir = process.env.TASTYTRADE_BOT_RUN_HISTORY_DIR?.trim()
    ?? path.join(process.cwd(), "data", "runs");
  return path.join(dir, "position-registry.json");
}

function registryKey(accountNumber: string, symbol: string): RegistryKey {
  return `${accountNumber}:${symbol.trim().toUpperCase()}`;
}

async function readRegistry(): Promise<RegistryData> {
  try {
    const raw = await fs.readFile(getRegistryPath(), "utf8");
    return JSON.parse(raw) as RegistryData;
  } catch {
    return {};
  }
}

async function writeRegistry(data: RegistryData): Promise<void> {
  const filePath = getRegistryPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

// Called when a seed order fires for a symbol
export async function recordPositionOpened(
  accountNumber: string,
  symbol: string,
  side: "call" | "put",
): Promise<void> {
  const data = await readRegistry();
  const key = registryKey(accountNumber, symbol);
  if (data[key] && !data[key].closedAt) {
    return; // already have an open entry, don't overwrite openedAt
  }
  data[key] = {
    accountNumber,
    symbol: symbol.trim().toUpperCase(),
    side,
    openedAt: new Date().toISOString(),
  };
  await writeRegistry(data);
}

// Called when a CLOSE_POSITION order is placed
export async function recordPositionClosing(
  accountNumber: string,
  symbol: string,
  orderId: string,
  openPriceAtClose: number,
  totalQuantityWeight: number,
): Promise<void> {
  const data = await readRegistry();
  const key = registryKey(accountNumber, symbol);
  const existing = data[key] ?? {
    accountNumber,
    symbol: symbol.trim().toUpperCase(),
    side: "call",
    openedAt: new Date().toISOString(),
  };
  data[key] = {
    ...existing,
    closingOrderId: orderId,
    closingInitiatedAt: new Date().toISOString(),
    openPriceAtClose,
    totalQuantityWeight,
  };
  await writeRegistry(data);
}

// Call at the start of each run cycle. Fetches fills for any pending close orders
// and writes realized P&L once confirmed.
export async function reconcilePendingCloses(accountNumber: string): Promise<void> {
  const data = await readRegistry();
  let changed = false;

  for (const [key, entry] of Object.entries(data)) {
    if (
      entry.accountNumber !== accountNumber ||
      !entry.closingOrderId ||
      entry.closedAt
    ) {
      continue;
    }

    try {
      const orderId = Number(entry.closingOrderId);
      if (!Number.isFinite(orderId)) continue;

      const order = await tastytradeApi.orderService.getOrder(accountNumber, orderId);
      const status = String(order.status ?? "").toLowerCase();

      if (status !== "filled") continue;

      // Weighted average fill across all leg fills
      const allFills = (order.legs ?? []).flatMap((leg) => leg.fills ?? []);
      const totalFillQty = allFills.reduce(
        (sum, f) => sum + (Number(f.quantity) || 0),
        0,
      );
      const weightedFillPrice =
        totalFillQty > 0
          ? allFills.reduce(
              (sum, f) =>
                sum + (Number(f["fill-price"]) || 0) * (Number(f.quantity) || 0),
              0,
            ) / totalFillQty
          : null;

      const closePrice = weightedFillPrice;
      const openPrice = entry.openPriceAtClose ?? null;
      const qty = entry.totalQuantityWeight ?? null;

      const returnPct =
        closePrice != null && openPrice != null && openPrice > 0
          ? (closePrice - openPrice) / openPrice
          : null;
      const returnAbs =
        closePrice != null && openPrice != null && qty != null
          ? (closePrice - openPrice) * qty
          : null;

      const filledAt =
        allFills
          .map((f) => f["filled-at"])
          .filter(Boolean)
          .sort()
          .at(-1) ?? new Date().toISOString();

      data[key] = {
        ...entry,
        closedAt: filledAt,
        closePrice: closePrice ?? undefined,
        returnPct: returnPct ?? undefined,
        returnAbs: returnAbs ?? undefined,
      };

      console.log(
        JSON.stringify({
          scope: "position-registry-reconcile",
          accountNumber,
          symbol: entry.symbol,
          closePrice,
          openPrice,
          returnPct,
          returnAbs,
          filledAt,
        }),
      );

      changed = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[position-registry] failed to reconcile order ${entry.closingOrderId} for ${entry.symbol}: ${message}`,
      );
    }
  }

  if (changed) {
    await writeRegistry(data);
  }
}

function isSameCalendarDay(isoA: string, isoB: string): boolean {
  return isoA.slice(0, 10) === isoB.slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString();
}

export async function isOpenedToday(
  accountNumber: string,
  symbol: string,
): Promise<boolean> {
  const data = await readRegistry();
  const entry = data[registryKey(accountNumber, symbol)];
  return entry != null && isSameCalendarDay(entry.openedAt, todayIso());
}

export async function isClosedToday(
  accountNumber: string,
  symbol: string,
): Promise<boolean> {
  const data = await readRegistry();
  const entry = data[registryKey(accountNumber, symbol)];
  return (
    entry != null &&
    entry.closedAt != null &&
    isSameCalendarDay(entry.closedAt, todayIso())
  );
}

export async function getRegistryEntry(
  accountNumber: string,
  symbol: string,
): Promise<PositionRegistryEntry | null> {
  const data = await readRegistry();
  return data[registryKey(accountNumber, symbol)] ?? null;
}

// Removes entries older than keepDays calendar days that are fully closed
export async function pruneOldEntries(keepDays = 2): Promise<void> {
  const data = await readRegistry();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);
  const cutoffIso = cutoff.toISOString();

  let changed = false;
  for (const [key, entry] of Object.entries(data)) {
    if (entry.closedAt && entry.closedAt < cutoffIso) {
      delete data[key];
      changed = true;
    }
  }

  if (changed) {
    await writeRegistry(data);
  }
}
