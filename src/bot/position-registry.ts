import * as fs from "fs/promises";
import * as path from "path";

export interface PositionRegistryEntry {
  accountNumber: string;
  symbol: string;
  side: "call" | "put";
  openedAt: string;
  closingOrderId?: string;
  closedAt?: string;
}

// Key format: `${accountNumber}:${SYMBOL}:${openDate}` e.g. "5WT12345:RUM:2026-06-28"
// Including the open date preserves historical entries when a position is reopened later.
type RegistryKey = string;
type RegistryData = Record<RegistryKey, PositionRegistryEntry>;

function getRegistryPath(): string {
  const specific = process.env.TASTYTRADE_BOT_RUN_HISTORY_DIR?.trim();
  if (specific) return path.join(specific, "position-registry.json");
  const dataDir = process.env.TASTYTRADE_BOT_DATA_DIR?.trim() || undefined;
  return path.join(dataDir ?? path.join(process.cwd(), "data"), "runs", "position-registry.json");
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function registryKey(accountNumber: string, symbol: string, openDate: string): RegistryKey {
  return `${accountNumber}:${symbol.trim().toUpperCase()}:${openDate}`;
}

function symbolPrefix(accountNumber: string, symbol: string): string {
  return `${accountNumber}:${symbol.trim().toUpperCase()}:`;
}

function entriesForSymbol(
  data: RegistryData,
  accountNumber: string,
  symbol: string,
): [string, PositionRegistryEntry][] {
  const prefix = symbolPrefix(accountNumber, symbol);
  return Object.entries(data).filter(([key]) => key.startsWith(prefix));
}

function openEntryForSymbol(
  data: RegistryData,
  accountNumber: string,
  symbol: string,
): [string, PositionRegistryEntry] | null {
  const matches = entriesForSymbol(data, accountNumber, symbol).filter(
    ([, entry]) => !entry.closedAt,
  );
  if (matches.length === 0) return null;
  return matches.sort(([, a], [, b]) => b.openedAt.localeCompare(a.openedAt))[0];
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

export async function recordPositionOpened(
  accountNumber: string,
  symbol: string,
  side: "call" | "put",
): Promise<void> {
  const data = await readRegistry();
  if (openEntryForSymbol(data, accountNumber, symbol)) return;
  const key = registryKey(accountNumber, symbol, todayDate());
  data[key] = {
    accountNumber,
    symbol: symbol.trim().toUpperCase(),
    side,
    openedAt: new Date().toISOString(),
  };
  await writeRegistry(data);
}

export async function recordPositionClosed(
  accountNumber: string,
  symbol: string,
  orderId?: string,
): Promise<void> {
  const data = await readRegistry();
  const match = openEntryForSymbol(data, accountNumber, symbol);
  const [key, existing] = match ?? [
    registryKey(accountNumber, symbol, todayDate()),
    {
      accountNumber,
      symbol: symbol.trim().toUpperCase(),
      side: "call" as const,
      openedAt: new Date().toISOString(),
    },
  ];
  data[key] = {
    ...existing,
    closingOrderId: orderId,
    closedAt: new Date().toISOString(),
  };
  await writeRegistry(data);
}

function isSameCalendarDay(isoA: string, isoB: string): boolean {
  return isoA.slice(0, 10) === isoB.slice(0, 10);
}

export async function isOvernightPosition(
  accountNumber: string,
  symbol: string,
): Promise<boolean> {
  const data = await readRegistry();
  const match = openEntryForSymbol(data, accountNumber, symbol);
  if (!match) return false;
  return !isSameCalendarDay(match[1].openedAt, new Date().toISOString());
}

export async function isOpenedToday(
  accountNumber: string,
  symbol: string,
): Promise<boolean> {
  const data = await readRegistry();
  return (registryKey(accountNumber, symbol, todayDate())) in data;
}

export async function isClosedToday(
  accountNumber: string,
  symbol: string,
): Promise<boolean> {
  const data = await readRegistry();
  const today = new Date().toISOString();
  return entriesForSymbol(data, accountNumber, symbol).some(
    ([, entry]) => entry.closedAt != null && isSameCalendarDay(entry.closedAt, today),
  );
}

export async function getRegistryEntry(
  accountNumber: string,
  symbol: string,
): Promise<PositionRegistryEntry | null> {
  const data = await readRegistry();
  const match = openEntryForSymbol(data, accountNumber, symbol);
  if (match) return match[1];
  const all = entriesForSymbol(data, accountNumber, symbol);
  if (all.length === 0) return null;
  return all.sort(([, a], [, b]) => b.openedAt.localeCompare(a.openedAt))[0][1];
}

// Removes entries older than keepDays calendar days that are closed
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
