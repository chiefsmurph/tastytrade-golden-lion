import * as fs from "fs/promises";
import * as path from "path";

export interface PositionRegistryEntry {
  accountNumber: string;
  symbol: string;
  side: "call" | "put";
  openedAt: string;
  closingOrderId?: string;
  closedAt?: string;
  // Set when the close was written by broker reconciliation rather than a
  // close-order placement (which sets closingOrderId instead).
  closedVia?: "broker-reconcile";
}

// Key format: `${accountNumber}:${SYMBOL}:${openDate}` e.g. "5WT12345:RUM:2026-06-28"
// Including the open date preserves historical entries when a position is reopened later.
type RegistryKey = string;
type RegistryData = Record<RegistryKey, PositionRegistryEntry>;

function getRegistryPath(): string {
  const dataDir = process.env.BOT_DATA_DIR?.trim() || undefined;
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

export interface PositionOpenSnapshot {
  symbol: string;
  side: "call" | "put";
  openedAt: string;
}

// Shape of an evaluated position group that the snapshot helpers below
// accept. Structural (rather than importing PositionGroupEvaluation) so this
// module — and its tests — stay free of the run-cycle/broker-client import
// graph.
export interface RegistryGroupSource {
  underlyingSymbol?: string | null;
  groupKey?: string;
  positions: {
    quantity?: number | string | null;
    "created-at"?: string;
  }[];
}

function hasOpenQuantity(group: RegistryGroupSource): boolean {
  return group.positions.some(
    (position) => Math.abs(Number(position.quantity) || 0) > 0,
  );
}

// Maps evaluated position groups to open snapshots for syncPositionOpens.
// Groups with no non-zero-quantity leg are skipped: Tastytrade keeps same-day
// closed positions in the positions list with quantity 0 until end-of-day
// processing, and backfilling one would overwrite the just-written closedAt
// on the same-day registry entry (same account:symbol:date key), resurrecting
// it as a phantom OPEN entry that then never closes.
export function toPositionOpenSnapshots(
  groups: RegistryGroupSource[],
): PositionOpenSnapshot[] {
  const snapshots: PositionOpenSnapshot[] = [];

  for (const group of groups) {
    const symbol = String(group.underlyingSymbol ?? "").trim().toUpperCase();
    const side = group.groupKey?.split("::")[1];
    if (!symbol || (side !== "call" && side !== "put")) continue;
    if (!hasOpenQuantity(group)) continue;

    const createdAts = group.positions
      .map((position) => position["created-at"])
      .filter((value): value is string => Boolean(value));
    if (createdAts.length === 0) continue;

    snapshots.push({ symbol, side, openedAt: createdAts.sort()[0] });
  }

  return snapshots;
}

// Underlying symbols the broker currently reports as actually held (any
// non-zero-quantity leg) — the ground truth that
// reconcileWithBrokerPositions compares registry entries against.
export function toHeldUnderlyingSymbols(
  groups: RegistryGroupSource[],
): Set<string> {
  const held = new Set<string>();

  for (const group of groups) {
    const symbol = String(group.underlyingSymbol ?? "").trim().toUpperCase();
    if (!symbol || !hasOpenQuantity(group)) continue;
    held.add(symbol);
  }

  return held;
}

// Backfills open entries from broker position data (`created-at`). Positions
// opened outside the seed paths — regular allocation buys, manual trades,
// positions predating the registry — would otherwise never register, making
// isOvernightPosition/getPositionAgeDays silently wrong for them.
export async function syncPositionOpens(
  accountNumber: string,
  snapshots: PositionOpenSnapshot[],
): Promise<void> {
  const data = await readRegistry();
  let changed = false;

  for (const snapshot of snapshots) {
    if (openEntryForSymbol(data, accountNumber, snapshot.symbol)) continue;
    const key = registryKey(accountNumber, snapshot.symbol, snapshot.openedAt.slice(0, 10));
    data[key] = {
      accountNumber,
      symbol: snapshot.symbol.trim().toUpperCase(),
      side: snapshot.side,
      openedAt: snapshot.openedAt,
    };
    changed = true;
  }

  if (changed) {
    await writeRegistry(data);
  }
}

export async function recordPositionClosed(
  accountNumber: string,
  symbol: string,
  orderId?: string,
  openedAtFallback?: string,
): Promise<void> {
  const data = await readRegistry();
  const match = openEntryForSymbol(data, accountNumber, symbol);
  const fallbackOpenedAt = openedAtFallback ?? new Date().toISOString();
  const [key, existing] = match ?? [
    registryKey(accountNumber, symbol, fallbackOpenedAt.slice(0, 10)),
    {
      accountNumber,
      symbol: symbol.trim().toUpperCase(),
      side: "call" as const,
      openedAt: fallbackOpenedAt,
    },
  ];
  data[key] = {
    ...existing,
    closingOrderId: orderId,
    closedAt: new Date().toISOString(),
  };
  await writeRegistry(data);
}

// Opens are recorded when a seed order is *placed*, not filled, so a fresh
// entry can legitimately precede its broker position while the fill lands.
// Within this window a tracked-but-not-held entry is left alone; the next
// cycle catches it if the order was cancelled instead.
const RECONCILE_GRACE_MS = 30 * 60 * 1000;

// Marks OPEN entries closed when the broker no longer reports their symbol as
// held for the account. This is the janitor for every close-write leak path:
// a close-back that never got recorded (crash between placement and write),
// a seed order that was placed (and registered) but cancelled before filling,
// manual closes, and expirations. Entries for other accounts and for symbols
// the broker still holds are untouched — legitimately-open overnight holds
// survive because the broker keeps reporting them.
//
// Fail-safe contract: heldUnderlyingSymbols must come from a *successful*
// broker position fetch, and callers must skip this call entirely when the
// fetch fails — an empty set means "the account is genuinely flat", not
// "positions unavailable".
export async function reconcileWithBrokerPositions(
  accountNumber: string,
  heldUnderlyingSymbols: Iterable<string>,
  now: Date = new Date(),
): Promise<PositionRegistryEntry[]> {
  const held = new Set(
    Array.from(heldUnderlyingSymbols, (symbol) =>
      String(symbol).trim().toUpperCase(),
    ),
  );

  const data = await readRegistry();
  const reconciled: PositionRegistryEntry[] = [];

  for (const [key, entry] of Object.entries(data)) {
    if (entry.accountNumber !== accountNumber || entry.closedAt) continue;
    if (held.has(entry.symbol.trim().toUpperCase())) continue;

    // An unparseable openedAt is treated as old — leaving it would leak it
    // forever, and nothing legitimate writes a non-ISO openedAt.
    const openedMs = Date.parse(entry.openedAt);
    if (Number.isFinite(openedMs) && now.getTime() - openedMs < RECONCILE_GRACE_MS) {
      continue;
    }

    const updated: PositionRegistryEntry = {
      ...entry,
      closedAt: now.toISOString(),
      closedVia: "broker-reconcile",
    };
    data[key] = updated;
    reconciled.push(updated);
  }

  if (reconciled.length > 0) {
    await writeRegistry(data);
  }

  return reconciled;
}

function isSameCalendarDay(isoA: string, isoB: string): boolean {
  return isoA.slice(0, 10) === isoB.slice(0, 10);
}

export async function getPositionAgeDays(
  accountNumber: string,
  symbol: string,
): Promise<number | null> {
  const data = await readRegistry();
  const match = openEntryForSymbol(data, accountNumber, symbol);
  if (!match) return null;
  const openedAt = new Date(match[1].openedAt);
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const openDay = new Date(openedAt.toISOString().slice(0, 10));
  const today = new Date(now.toISOString().slice(0, 10));
  return Math.round((today.getTime() - openDay.getTime()) / msPerDay);
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
