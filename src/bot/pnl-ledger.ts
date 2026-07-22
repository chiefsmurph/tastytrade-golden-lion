import * as fs from "fs/promises";
import * as path from "path";

import { getManagedAccountNumbers } from "~/core/default-account";
import { getOccExpirationDate, inferOptionSide } from "./actions/order-utils";
import type { RunCloseOrder, RunGroupReturn, RunStrategyDecision } from "./run-history";

// Realized-P&L attribution ledger (IMPROVEMENTS.v5 strategy #9). One NDJSON
// row per close order with observed fills — the atoms that after-Monday tuning
// distributions aggregate. Written best-effort at the end of each cycle; a
// ledger failure never touches trading. Known gap (shared with
// get-closed-positions-today): a close that fills after the chase loop's final
// getOrder re-fetch never shows fills in run history, so it is missed here too
// — reconcilable from broker statements until confirmed-fill tracking lands
// (v5 code #3).

export type PnlDecisionType =
  | "take-profit"
  | "stop-loss"
  | "eod-liquidation"
  | "eod-stop"
  | "overnight-reduction"
  | "other";

export interface PnlLedgerEntry {
  id: string;
  recordedAt: string;
  accountNumber: string;
  accountType: "margin" | "cash" | "unknown";
  underlyingSymbol: string;
  symbol: string; // OCC contract
  side: "call" | "put" | null;
  orderId: string | null;
  decisionType: PnlDecisionType;
  decisionReason: string;
  // Derived from decisionType: the strategy sets isUrgentClose on exactly the
  // stop-loss / EOD paths, so re-deriving here avoids threading evaluations in.
  isUrgentClose: boolean;
  quantityClosed: number;
  avgCloseFillPrice: number;
  weightedAverageOpenFill: number | null;
  realizedPnlDollars: number | null;
  realizedPnlPct: number | null;
  closedAt: string | null; // first fill timestamp
  closeHourPst: number | null;
  dteAtClose: number | null;
  dteAtEntry: number | null;
  positionAgeDays: number | null;
  bidReturnPctAtCycle: number | null;
  askReturnPctAtCycle: number | null;
  spreadPctAtCycle: number | null;
  gateScoreAtClose: number | null;
  gateMaxTargetPctAtClose: number | null;
  // Entry-side context carried from the position registry at open (v8 #13):
  // the spread and gate score observed when the position was first tracked
  // open. Null when the registry never captured it (pre-v8 / seed-only opens
  // that no later cycle backfilled).
  entrySpreadPct: number | null;
  gateScoreAtEntry: number | null;
}

// Reason prefixes match the literal strings in evaluate-trading-strategy.ts.
export function classifyCloseDecision(reason: string): PnlDecisionType {
  if (reason.startsWith("Profit target reached")) return "take-profit";
  if (reason.startsWith("Hit absolute loss limit")) return "stop-loss";
  if (reason.startsWith("Market closed or closing")) return "eod-liquidation";
  if (reason.startsWith("End-of-day risk management")) return "eod-stop";
  return "other";
}

const URGENT_DECISION_TYPES: ReadonlySet<PnlDecisionType> = new Set([
  "stop-loss",
  "eod-liquidation",
  "eod-stop",
]);

function getPstDateString(iso: string): string | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function getPstHour(iso: string): number | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const hour = Number(
    parsed.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      hour12: false,
    }),
  );
  return Number.isFinite(hour) ? hour : null;
}

function toDateOnlyString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Calendar-day difference between two YYYY-MM-DD strings.
function diffDays(laterDateOnly: string, earlierDateOnly: string): number {
  const later = Date.parse(`${laterDateOnly}T00:00:00Z`);
  const earlier = Date.parse(`${earlierDateOnly}T00:00:00Z`);
  return Math.round((later - earlier) / 86_400_000);
}

// Entry-side context carried from the position registry (which spans
// open→close) onto the close-side ledger row (v8 #13). openedAt drives the
// entry/age DTE math; entrySpreadPct/gateScoreAtEntry unlock entry-quality
// attribution ("did we enter at a bad spread / low gate score?").
export interface LedgerEntryContext {
  openedAt: string;
  entrySpreadPct?: number | null;
  gateScoreAtEntry?: number | null;
}

export interface BuildPnlLedgerEntriesInput {
  accountNumber: string;
  accountType: "margin" | "cash" | "unknown";
  // Cycle closes and overnight-reduction closes arrive separately so the
  // overnight ones can be attributed without relying on reason strings.
  cycleCloseOrders: RunCloseOrder[];
  overnightCloseOrders: RunCloseOrder[];
  groups: RunGroupReturn[];
  strategyDecisions: RunStrategyDecision[];
  // UNDERLYING (uppercased) -> registry-carried entry context
  entryContextByUnderlying: Map<string, LedgerEntryContext>;
  now?: Date;
}

// fallow-ignore-next-line complexity
export function buildPnlLedgerEntries(input: BuildPnlLedgerEntriesInput): PnlLedgerEntry[] {
  const now = input.now ?? new Date();
  const recordedAt = now.toISOString();

  const groupBySymbol = new Map(
    input.groups.map((group) => [group.underlyingSymbol.toUpperCase(), group]),
  );
  const reasonByUnderlying = new Map(
    input.strategyDecisions
      .filter((decision) => decision.strategyAction === "CLOSE_POSITION")
      .map((decision) => [decision.underlyingSymbol.toUpperCase(), decision.reason]),
  );

  const sources: { orders: RunCloseOrder[]; isOvernight: boolean }[] = [
    { orders: input.cycleCloseOrders, isOvernight: false },
    { orders: input.overnightCloseOrders, isOvernight: true },
  ];

  const entries: PnlLedgerEntry[] = [];

  for (const { orders, isOvernight } of sources) {
    for (const closeOrder of orders) {
      if (!closeOrder.placedOrder) continue;

      const quantityClosed = closeOrder.fills.reduce(
        (sum, fill) => sum + (Number(fill.quantity) || 0),
        0,
      );
      // Realized trips only: a placed-but-unfilled close is not a round trip.
      if (!(quantityClosed > 0)) continue;

      const avgCloseFillPrice =
        closeOrder.fills.reduce(
          (sum, fill) => sum + (Number(fill.fillPrice) || 0) * (Number(fill.quantity) || 0),
          0,
        ) / quantityClosed;

      const underlyingKey = closeOrder.underlyingSymbol.toUpperCase();
      const group = groupBySymbol.get(underlyingKey);
      const perLegFill = group?.legWeightedFills?.[closeOrder.symbol];
      const weightedAverageOpenFill =
        perLegFill != null && perLegFill > 0
          ? perLegFill
          : group && group.weightedAverageFill > 0 ? group.weightedAverageFill : null;

      const realizedPnlDollars =
        weightedAverageOpenFill != null
          ? (avgCloseFillPrice - weightedAverageOpenFill) * quantityClosed * 100
          : null;
      const realizedPnlPct =
        weightedAverageOpenFill != null
          ? (avgCloseFillPrice - weightedAverageOpenFill) / weightedAverageOpenFill
          : null;

      const decisionReason = isOvernight
        ? "Overnight position reduction"
        : reasonByUnderlying.get(underlyingKey) ?? "";
      const decisionType: PnlDecisionType = isOvernight
        ? "overnight-reduction"
        : classifyCloseDecision(decisionReason);

      const closedAt = closeOrder.fills[0]?.filledAt ?? null;
      const closeIso = closedAt ?? recordedAt;
      const closeDateOnly = getPstDateString(closeIso);

      const expiration = getOccExpirationDate(closeOrder.symbol);
      const expirationDateOnly = expiration ? toDateOnlyString(expiration) : null;
      const dteAtClose =
        expirationDateOnly && closeDateOnly ? diffDays(expirationDateOnly, closeDateOnly) : null;

      const entryContext = input.entryContextByUnderlying.get(underlyingKey) ?? null;
      const openedAt = entryContext?.openedAt ?? null;
      const openedDateOnly = openedAt ? getPstDateString(openedAt) : null;
      const dteAtEntry =
        expirationDateOnly && openedDateOnly ? diffDays(expirationDateOnly, openedDateOnly) : null;
      const positionAgeDays =
        closeDateOnly && openedDateOnly ? diffDays(closeDateOnly, openedDateOnly) : null;

      // Reconstruct the cycle-time spread from the group's bid/ask returns.
      let spreadPctAtCycle: number | null = null;
      if (group && weightedAverageOpenFill != null) {
        const bid = weightedAverageOpenFill * (1 + group.bidReturnPct);
        const ask = weightedAverageOpenFill * (1 + group.askReturnPct);
        const mid = (bid + ask) / 2;
        if (bid > 0 && ask >= bid && mid > 0) {
          spreadPctAtCycle = (ask - bid) / mid;
        }
      }

      entries.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        recordedAt,
        accountNumber: input.accountNumber,
        accountType: input.accountType,
        underlyingSymbol: closeOrder.underlyingSymbol,
        symbol: closeOrder.symbol,
        side: group?.side === "call" || group?.side === "put"
          ? group.side
          : inferOptionSide(closeOrder.symbol),
        orderId: closeOrder.orderId,
        decisionType,
        decisionReason,
        isUrgentClose: URGENT_DECISION_TYPES.has(decisionType),
        quantityClosed,
        avgCloseFillPrice,
        weightedAverageOpenFill,
        realizedPnlDollars,
        realizedPnlPct,
        closedAt,
        closeHourPst: getPstHour(closeIso),
        dteAtClose,
        dteAtEntry,
        positionAgeDays,
        bidReturnPctAtCycle: group?.bidReturnPct ?? null,
        askReturnPctAtCycle: group?.askReturnPct ?? null,
        spreadPctAtCycle,
        gateScoreAtClose: group?.positionGate?.signals.goodBooleanScore ?? null,
        gateMaxTargetPctAtClose: group?.positionGate?.maxTargetPct ?? null,
        entrySpreadPct: entryContext?.entrySpreadPct ?? null,
        gateScoreAtEntry: entryContext?.gateScoreAtEntry ?? null,
      });
    }
  }

  return entries;
}

function sanitizeAccountNumberForPath(accountNumber: string): string {
  const normalized = String(accountNumber ?? "").trim();
  if (!normalized) {
    return "unknown-account";
  }
  return normalized.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getLedgerDirectory(): string {
  const dataDir = process.env.BOT_DATA_DIR?.trim() || undefined;
  return path.join(dataDir ?? path.join(process.cwd(), "data"), "ledger");
}

function getLedgerPath(
  accountNumber: string,
  accountType: "margin" | "cash" | "unknown",
): string {
  const safeAccountNumber = sanitizeAccountNumberForPath(accountNumber);
  const fileName =
    accountType === "unknown"
      ? `${safeAccountNumber}.ndjson`
      : `${safeAccountNumber}-${accountType}.ndjson`;
  return path.join(getLedgerDirectory(), fileName);
}

export async function appendPnlLedgerEntries(
  accountNumber: string,
  accountType: "margin" | "cash" | "unknown",
  entries: PnlLedgerEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const filePath = getLedgerPath(accountNumber, accountType);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lines = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  await fs.appendFile(filePath, lines, "utf8");
}

// fallow-ignore-next-line complexity
async function readLedgerEntriesForAccount(accountNumber: string): Promise<PnlLedgerEntry[]> {
  const safeAccountNumber = sanitizeAccountNumberForPath(accountNumber);
  const directory = getLedgerDirectory();

  let fileNames: string[] = [];
  try {
    fileNames = (await fs.readdir(directory)).filter(
      (name) => name.startsWith(safeAccountNumber) && name.endsWith(".ndjson"),
    );
  } catch {
    return [];
  }

  const entries: PnlLedgerEntry[] = [];
  for (const fileName of fileNames) {
    try {
      const raw = await fs.readFile(path.join(directory, fileName), "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed) as PnlLedgerEntry);
        } catch {
          // skip corrupt line
        }
      }
    } catch {
      // skip unreadable file
    }
  }

  return entries.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

// fallow-ignore-next-line complexity
async function getPnlLedgerForAccount(accountNumber: string, date: string | null) {
  const allEntries = await readLedgerEntriesForAccount(accountNumber);
  const entries = date
    ? allEntries.filter((entry) => getPstDateString(entry.closedAt ?? entry.recordedAt) === date)
    : allEntries;

  const totalRealizedPnlDollars = entries.reduce(
    (sum, entry) => sum + (entry.realizedPnlDollars ?? 0),
    0,
  );

  const byDecisionType: Record<string, { count: number; realizedPnlDollars: number }> = {};
  for (const entry of entries) {
    const bucket = (byDecisionType[entry.decisionType] ??= { count: 0, realizedPnlDollars: 0 });
    bucket.count += 1;
    bucket.realizedPnlDollars += entry.realizedPnlDollars ?? 0;
  }

  return {
    accountNumber,
    date,
    entryCount: entries.length,
    totalRealizedPnlDollars,
    byDecisionType,
    entries,
  };
}

// IPC: bot:getPnlLedger [accountNumber] [date YYYY-MM-DD]
// fallow-ignore-next-line complexity
export async function getPnlLedger(args: string[]): Promise<unknown> {
  const [accountNumberArg, dateArg] = args;
  const accountNumber = accountNumberArg?.trim() || null;
  const date = dateArg?.trim() || null;

  if (accountNumber) {
    return getPnlLedgerForAccount(accountNumber, date);
  }

  const accountNumbers = await getManagedAccountNumbers();
  if (accountNumbers.length === 1) {
    return getPnlLedgerForAccount(accountNumbers[0], date);
  }

  return Promise.all(
    accountNumbers.map((account) => getPnlLedgerForAccount(account, date)),
  );
}
