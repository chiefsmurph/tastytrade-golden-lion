import { promises as fs } from "node:fs";
import path from "node:path";
import { getAccountBalanceNumber } from "~/core/account-balance";
import { getAccountMarginOrCash } from "~/core/default-account";
import { TastytradeAccountBalance } from "~/core/types";
import {
  getLatestDayReport,
  getPstDateString,
  getPstTimeInMinutes,
  DayReportEntry,
  DayReportGroup,
} from "./day-report-store";
import type { RunGroupReturn } from "./run-history";

// Overnight-hold P&L snapshot (IMPROVEMENTS.v6 strategy #12). The cash account
// holds option positions overnight for delta; the day-report machinery records
// an end-of-day CLOSE snapshot, but there was no matching day-OPEN snapshot to
// pair with the prior day's close, so overnight P&L (open value vs prior close
// value) was impossible to verify. This module records that open snapshot once
// per morning and attributes overnight P&L per group by pairing today's open
// against the latest day report. Log-only / additive NDJSON — no trading
// behavior change; the writer is best-effort and never throws into the cycle.

// Market opens 6:30 AM PT (390 min). Gate the open snapshot to the early
// morning so a mid-day restart doesn't mislabel a later cycle as the "open".
export const MARKET_OPEN_MINUTE = 6 * 60 + 30; // 6:30 AM PT
export const OPEN_SNAPSHOT_CUTOFF_MINUTE = 10 * 60; // 10:00 AM PT

export function isOpenSnapshotTime(date?: Date): boolean {
  const minutes = getPstTimeInMinutes(date);
  return minutes >= MARKET_OPEN_MINUTE && minutes < OPEN_SNAPSHOT_CUTOFF_MINUTE;
}

export interface OvernightGroupPnl {
  underlyingSymbol: string;
  side: "call" | "put" | "none";
  // Bid market value of the position ($): cost basis + unrealized bid return.
  openBidValue: number;
  priorCloseBidValue: number | null;
  // Overnight P&L = today's open bid value − prior close bid value.
  overnightPnlDollars: number | null;
  overnightPnlPct: number | null;
  pairedWithPriorClose: boolean;
}

export interface OpenSnapshotEntry {
  id: string;
  accountNumber: string;
  date: string; // "YYYY-MM-DD" PST
  timestamp: string; // ISO 8601 UTC
  netLiquidatingValue: number;
  totalCapital: number;
  derivativeBuyingPower: number;
  cashBalance: number;
  priorCloseDate: string | null;
  pairedWithPriorClose: boolean;
  groups: OvernightGroupPnl[];
  summary: {
    openPositionCount: number;
    pairedGroupCount: number;
    totalOvernightPnlDollars: number | null;
  };
}

// Bid market value of a held group: cost basis plus the unrealized bid return.
// Both day-report groups and run groups expose these two fields.
function bidValueOf(group: {
  totalCostBasis: number;
  totalUnrealizedReturnBid: number;
}): number {
  return (Number(group.totalCostBasis) || 0) + (Number(group.totalUnrealizedReturnBid) || 0);
}

function groupKey(underlyingSymbol: string, side: string): string {
  return `${String(underlyingSymbol).toUpperCase()}::${side}`;
}

// Pure pairing + P&L math. For each currently-held group, pair with the prior
// day report's group by underlyingSymbol + side. Overnight P&L is today's open
// bid value vs the prior-close bid value. When no prior-close match exists (no
// prior report, or that group wasn't held at close), P&L is null.
export function computeOvernightGroupPnl(
  runGroups: RunGroupReturn[],
  priorReport: DayReportEntry | null,
): OvernightGroupPnl[] {
  const priorByKey = new Map<string, DayReportGroup>();
  for (const group of priorReport?.groups ?? []) {
    priorByKey.set(groupKey(group.underlyingSymbol, group.side), group);
  }
  return runGroups.map((group) =>
    pairGroupWithPriorClose(group, priorByKey.get(groupKey(group.underlyingSymbol, group.side))),
  );
}

// Pair one currently-held group against its prior-close counterpart (or none).
// Extracted so the per-group P&L math is directly unit-tested.
export function pairGroupWithPriorClose(
  group: RunGroupReturn,
  priorGroup: DayReportGroup | undefined,
): OvernightGroupPnl {
  const openBidValue = bidValueOf(group);
  const priorCloseBidValue = priorGroup ? bidValueOf(priorGroup) : null;
  const paired = priorCloseBidValue != null;
  const overnightPnlDollars = paired ? openBidValue - priorCloseBidValue : null;
  const overnightPnlPct =
    paired && priorCloseBidValue !== 0
      ? (openBidValue - priorCloseBidValue) / Math.abs(priorCloseBidValue)
      : null;
  return {
    underlyingSymbol: group.underlyingSymbol,
    side: group.side,
    openBidValue,
    priorCloseBidValue,
    overnightPnlDollars,
    overnightPnlPct,
    pairedWithPriorClose: paired,
  };
}

export function buildOpenSnapshotInput(
  accountNumber: string,
  accountBalances: TastytradeAccountBalance,
  runGroups: RunGroupReturn[],
  totalCapital: number,
  priorReport: DayReportEntry | null,
): Omit<OpenSnapshotEntry, "id" | "timestamp"> {
  const today = getPstDateString();
  // The open snapshot only pairs against a report from a strictly earlier PST
  // date — a same-day report is today's own (unlikely at open, but guarded).
  const priorIsEarlier = !!priorReport && priorReport.date < today;
  const groups = computeOvernightGroupPnl(runGroups, priorIsEarlier ? priorReport : null);

  const pairedGroups = groups.filter((g) => g.pairedWithPriorClose);
  const totalOvernightPnlDollars =
    pairedGroups.length > 0
      ? pairedGroups.reduce((sum, g) => sum + (g.overnightPnlDollars ?? 0), 0)
      : null;

  return {
    accountNumber,
    date: today,
    netLiquidatingValue: getAccountBalanceNumber(accountBalances, "net-liquidating-value"),
    totalCapital,
    derivativeBuyingPower: getAccountBalanceNumber(accountBalances, "derivative-buying-power"),
    cashBalance: getAccountBalanceNumber(accountBalances, "cash-balance"),
    priorCloseDate: priorIsEarlier ? priorReport!.date : null,
    pairedWithPriorClose: pairedGroups.length > 0,
    groups,
    summary: {
      openPositionCount: groups.length,
      pairedGroupCount: pairedGroups.length,
      totalOvernightPnlDollars,
    },
  };
}

function sanitizeAccountNumber(accountNumber: string): string {
  return String(accountNumber ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown-account";
}

function getOpenSnapshotDirectory(): string {
  const dataDir = process.env.BOT_DATA_DIR?.trim() || undefined;
  return path.join(dataDir ?? path.join(process.cwd(), "data"), "overnight");
}

async function getOpenSnapshotPath(accountNumber: string): Promise<string> {
  const safe = sanitizeAccountNumber(accountNumber);
  const accountType = await getAccountMarginOrCash(accountNumber);
  const suffix = accountType === "unknown" ? "" : `-${accountType}`;
  return path.join(getOpenSnapshotDirectory(), `${safe}${suffix}.ndjson`);
}

// Parse newest-first from raw NDJSON. Split out from the file read so the pure
// parsing is unit-testable without a broker or filesystem (keeps CRAP down).
export function parseOpenSnapshotsNewestFirst(raw: string): OpenSnapshotEntry[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reverse()
    .map((line) => tryParseOpenSnapshot(line))
    .filter((entry): entry is OpenSnapshotEntry => entry !== null);
}

function tryParseOpenSnapshot(line: string): OpenSnapshotEntry | null {
  try {
    return JSON.parse(line) as OpenSnapshotEntry;
  } catch {
    return null;
  }
}

async function readOpenSnapshotFile(filePath: string): Promise<OpenSnapshotEntry[]> {
  try {
    return parseOpenSnapshotsNewestFirst(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function appendOpenSnapshot(
  input: Omit<OpenSnapshotEntry, "id" | "timestamp">,
): Promise<OpenSnapshotEntry> {
  const entry: OpenSnapshotEntry = {
    ...input,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date().toISOString(),
  };
  const filePath = await getOpenSnapshotPath(input.accountNumber);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

async function getLatestOpenSnapshot(accountNumber: string): Promise<OpenSnapshotEntry | null> {
  const filePath = await getOpenSnapshotPath(accountNumber);
  const entries = await readOpenSnapshotFile(filePath);
  return entries[0] ?? null;
}

// Called from runBotCycle — reuses data already fetched during the cycle.
// Best-effort: gated to the morning window and deduped once-per-PST-day.
export async function maybeRecordOpenSnapshot(
  accountNumber: string,
  accountBalances: TastytradeAccountBalance,
  runGroups: RunGroupReturn[],
  totalCapital: number,
): Promise<OpenSnapshotEntry | null> {
  if (!isOpenSnapshotTime()) return null;

  const today = getPstDateString();
  const existing = await getLatestOpenSnapshot(accountNumber);
  if (existing?.date === today) return null;

  const priorReport = await getLatestDayReport(accountNumber);
  const input = buildOpenSnapshotInput(
    accountNumber,
    accountBalances,
    runGroups,
    totalCapital,
    priorReport,
  );
  const entry = await appendOpenSnapshot(input);

  console.log(
    JSON.stringify({
      scope: "overnight-snapshot",
      accountNumber,
      date: today,
      priorCloseDate: entry.priorCloseDate,
      pairedWithPriorClose: entry.pairedWithPriorClose,
      openPositionCount: entry.summary.openPositionCount,
      pairedGroupCount: entry.summary.pairedGroupCount,
      totalOvernightPnlDollars: entry.summary.totalOvernightPnlDollars,
      timestamp: entry.timestamp,
    }),
  );

  return entry;
}
