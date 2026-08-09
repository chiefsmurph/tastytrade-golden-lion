// Pure round-trip matching for the tastytrade transaction ledger. Split out of
// realized-pnl.ts so the arithmetic is testable without a broker session.
//
// WHY THIS EXISTS IN THIS SHAPE (regression, 2026-08-08)
// The first version of this report understated realized loss by roughly 3×:
//
//   1. Expired-worthless contracts vanished. The open leg had no Sell-to-Close to
//      pair with, so it sat forever in the FIFO map and was never printed — a
//      −100% outcome silently left the report. Every open leg now reaches a
//      terminal state (closed / expired / explicitly still-open) and the
//      reconciliation counts prove it.
//   2. It priced trips off `value`, which excludes commissions and fees. Opening
//      costs roughly $1/contract and closing roughly $0.12, which is material at
//      this book's premium sizes. `net-value` is the default now, with the gross
//      figure kept alongside so the fee drag is visible rather than buried.
//
// Also handled, because both were hit in practice: OCC root changes across a
// corporate action (EOSE → EOSE1) must still pair, and manual EQUITY round-trips
// in these accounts must never land in an options P&L.
import { isOccOptionSymbol } from "~/bot/actions/order-utils";

export type LedgerRow = Record<string, unknown>;

export type LegKind = "open" | "close" | "expiration";
export type InstrumentClass = "option" | "equity" | "other";

export interface NormalizedLeg {
  symbol: string;
  /** FIFO bucket. Normalizes the OCC root so a renamed contract still pairs. */
  matchKey: string;
  underlying: string;
  quantity: number;
  /** Signed cash: positive = credit received, negative = debit paid. */
  signedGross: number;
  signedNet: number;
  executedAt: string;
  kind: LegKind;
  /** Raw transaction-sub-type, kept for the printed label ("Expiration"). */
  subType: string;
  instrument: InstrumentClass;
}

export interface Trip {
  underlying: string;
  openSymbol: string;
  closeSymbol: string;
  quantity: number;
  grossCost: number;
  netCost: number;
  grossProceeds: number;
  netProceeds: number;
  openedAt: string;
  closedAt: string;
  outcome: "closed" | "expired";
  subType: string;
}

export interface DanglingLeg {
  symbol: string;
  underlying: string;
  quantity: number;
  netAmount: number;
  executedAt: string;
}

export interface Reconciliation {
  /** Ledger rows handed to the report, before any classification. */
  rowsExamined: number;
  openLegs: number;
  closeLegs: number;
  expirationLegs: number;
  trips: number;
  /** Opens with no terminal event in the window — still held. */
  stillOpen: DanglingLeg[];
  /** Closes/expirations whose open leg predates the window. */
  closesWithoutOpen: DanglingLeg[];
  skippedRows: number;
}

export interface EquitySummary {
  rowCount: number;
  symbols: string[];
  netCashFlow: number;
}

export interface RealizedPnlReport {
  trips: Trip[];
  totals: {
    grossCost: number;
    netCost: number;
    grossProceeds: number;
    netProceeds: number;
    netPnl: number;
    grossPnl: number;
    fees: number;
    netReturnPct: number | null;
    grossReturnPct: number | null;
    /** Fee cost expressed in percentage points of deployed (net) cost basis. */
    feeDragPp: number | null;
  };
  reconciliation: Reconciliation;
  equity: EquitySummary;
}

function readString(row: LedgerRow, key: string): string {
  return String(row?.[key] ?? "").trim();
}

/**
 * Signed cash for a value/effect pair. tastytrade reports magnitudes plus a
 * Debit/Credit flag; a missing flag (zero-value expiration rows) is taken as-is.
 */
function signedAmount(row: LedgerRow, valueKey: string, effectKey: string): number | null {
  const raw = Number(row?.[valueKey]);
  if (!Number.isFinite(raw)) return null;
  const effect = readString(row, effectKey).toLowerCase();
  if (effect === "debit") return -Math.abs(raw);
  if (effect === "credit") return Math.abs(raw);
  return raw;
}

export function classifyInstrument(row: LedgerRow): InstrumentClass {
  const symbol = readString(row, "symbol");
  const instrumentType = readString(row, "instrument-type");
  if (isOccOptionSymbol(symbol) || /option/i.test(instrumentType)) return "option";
  if (!symbol) return "other";
  if (/equity|stock/i.test(instrumentType)) return "equity";
  return "other";
}

/**
 * open / close / expiration.
 *
 * Expirations are the load-bearing case: they arrive as `Receive Deliver` with a
 * sub-type of Expiration (or an Assignment/Exercise removal), never as a
 * Sell-to-Close, and the old filter dropped them entirely. Anything that removes
 * an option leg without being an opening trade terminates the FIFO lot here.
 */
// fallow-ignore-next-line complexity
export function classifyLegKind(row: LedgerRow): LegKind {
  const subType = readString(row, "transaction-sub-type");
  const transactionType = readString(row, "transaction-type");
  const action = readString(row, "action");
  const description = readString(row, "description");

  if (/expir/i.test(subType) || /expir/i.test(description)) return "expiration";
  if (/assign|exercis/i.test(subType)) return "expiration";
  if (/open/i.test(subType) || /open/i.test(action)) return "open";
  if (/close/i.test(subType) || /close/i.test(action)) return "close";
  // Any other Receive Deliver row removes the leg rather than trading it.
  if (/receive\s*deliver/i.test(transactionType)) return "expiration";
  // Last resort, the pre-fix heuristic: money out = we bought.
  return (signedAmount(row, "value", "value-effect") ?? 0) < 0 ? "open" : "close";
}

/**
 * OCC root without its corporate-action suffix. A rename mid-position (EOSE →
 * EOSE1) otherwise strands the open leg in its own FIFO bucket and the round trip
 * disappears from the report.
 */
export function normalizeOptionRoot(root: string): string {
  const trimmed = root.trim().toUpperCase();
  return trimmed.replace(/\d+$/, "") || trimmed;
}

export function buildMatchKey(symbol: string, instrument: InstrumentClass): string {
  if (instrument !== "option") return `EQUITY:${symbol.trim().toUpperCase()}`;
  if (!isOccOptionSymbol(symbol)) return `OPT:${symbol.trim().toUpperCase()}`;
  return `OPT:${normalizeOptionRoot(symbol.slice(0, 6))}:${symbol.slice(6)}`;
}

export function normalizeLedgerRow(row: LedgerRow): NormalizedLeg | null {
  const symbol = readString(row, "symbol");
  if (!symbol) return null;
  const instrument = classifyInstrument(row);
  if (instrument === "other") return null;

  const signedGross = signedAmount(row, "value", "value-effect") ?? 0;
  const signedNet = signedAmount(row, "net-value", "net-value-effect") ?? signedGross;

  return {
    symbol,
    matchKey: buildMatchKey(symbol, instrument),
    underlying: (readString(row, "underlying-symbol") || symbol).split(/\s/)[0]!.toUpperCase(),
    quantity: Math.abs(Number(row?.quantity) || 0),
    signedGross,
    signedNet,
    executedAt: readString(row, "executed-at").slice(0, 16),
    kind: classifyLegKind(row),
    subType: readString(row, "transaction-sub-type") || readString(row, "transaction-type"),
    instrument,
  };
}

interface OpenLot {
  leg: NormalizedLeg;
  remaining: number;
  netCostPerUnit: number;
  grossCostPerUnit: number;
}

function toOpenLot(leg: NormalizedLeg): OpenLot | null {
  if (!(leg.quantity > 0)) return null;
  return {
    leg,
    remaining: leg.quantity,
    // Debits are negative, so negating gives dollars out per contract. Using the
    // cash amount rather than price × 100 keeps commissions in the cost basis.
    netCostPerUnit: -leg.signedNet / leg.quantity,
    grossCostPerUnit: -leg.signedGross / leg.quantity,
  };
}

function summarizeEquity(legs: NormalizedLeg[]): EquitySummary {
  const equityLegs = legs.filter((leg) => leg.instrument === "equity");
  return {
    rowCount: equityLegs.length,
    symbols: [...new Set(equityLegs.map((leg) => leg.underlying))].sort(),
    netCashFlow: equityLegs.reduce((sum, leg) => sum + leg.signedNet, 0),
  };
}

// fallow-ignore-next-line complexity
function matchTerminalLeg(
  leg: NormalizedLeg,
  lots: OpenLot[],
  trips: Trip[],
  closesWithoutOpen: DanglingLeg[],
): void {
  const openUnits = lots.reduce((sum, lot) => sum + lot.remaining, 0);
  // A quantity-less expiration removes whatever is left of the position.
  const units = leg.quantity > 0 ? leg.quantity : openUnits;
  const netPerUnit = leg.quantity > 0 ? leg.signedNet / leg.quantity : 0;
  const grossPerUnit = leg.quantity > 0 ? leg.signedGross / leg.quantity : 0;

  let remaining = units;
  while (remaining > 0 && lots.length > 0) {
    const lot = lots[0]!;
    const matched = Math.min(remaining, lot.remaining);
    trips.push({
      underlying: leg.underlying,
      openSymbol: lot.leg.symbol,
      closeSymbol: leg.symbol,
      quantity: matched,
      grossCost: matched * lot.grossCostPerUnit,
      netCost: matched * lot.netCostPerUnit,
      grossProceeds: matched * grossPerUnit,
      netProceeds: matched * netPerUnit,
      openedAt: lot.leg.executedAt,
      closedAt: leg.executedAt,
      outcome: leg.kind === "expiration" ? "expired" : "closed",
      subType: leg.subType,
    });
    lot.remaining -= matched;
    remaining -= matched;
    if (lot.remaining <= 0) lots.shift();
  }

  // Opened before the window (or already reconciled) — reported, never dropped.
  if (remaining > 0) {
    closesWithoutOpen.push({
      symbol: leg.symbol,
      underlying: leg.underlying,
      quantity: remaining,
      netAmount: remaining * netPerUnit,
      executedAt: leg.executedAt,
    });
  }
}

// fallow-ignore-next-line complexity
export function buildRealizedPnlReport(rows: unknown[]): RealizedPnlReport {
  const source = Array.isArray(rows) ? rows : [];
  const legs: NormalizedLeg[] = [];
  let skippedRows = 0;
  for (const row of source) {
    const leg = normalizeLedgerRow((row ?? {}) as LedgerRow);
    if (leg) legs.push(leg);
    else skippedRows += 1;
  }

  const optionLegs = legs
    .filter((leg) => leg.instrument === "option")
    .sort((a, b) => a.executedAt.localeCompare(b.executedAt));

  const openLotsByKey = new Map<string, OpenLot[]>();
  const trips: Trip[] = [];
  const closesWithoutOpen: DanglingLeg[] = [];
  const counts = { openLegs: 0, closeLegs: 0, expirationLegs: 0 };

  for (const leg of optionLegs) {
    if (leg.kind === "open") {
      counts.openLegs += 1;
      const lot = toOpenLot(leg);
      if (lot) {
        const lots = openLotsByKey.get(leg.matchKey) ?? [];
        lots.push(lot);
        openLotsByKey.set(leg.matchKey, lots);
      }
      continue;
    }
    if (leg.kind === "expiration") counts.expirationLegs += 1;
    else counts.closeLegs += 1;
    matchTerminalLeg(
      leg,
      openLotsByKey.get(leg.matchKey) ?? [],
      trips,
      closesWithoutOpen,
    );
  }

  const stillOpen: DanglingLeg[] = [];
  for (const lots of openLotsByKey.values()) {
    for (const lot of lots) {
      if (lot.remaining <= 0) continue;
      stillOpen.push({
        symbol: lot.leg.symbol,
        underlying: lot.leg.underlying,
        quantity: lot.remaining,
        netAmount: -lot.remaining * lot.netCostPerUnit,
        executedAt: lot.leg.executedAt,
      });
    }
  }

  const sum = (pick: (trip: Trip) => number) => trips.reduce((total, t) => total + pick(t), 0);
  const grossCost = sum((t) => t.grossCost);
  const netCost = sum((t) => t.netCost);
  const grossProceeds = sum((t) => t.grossProceeds);
  const netProceeds = sum((t) => t.netProceeds);
  const netPnl = netProceeds - netCost;
  const grossPnl = grossProceeds - grossCost;

  return {
    trips,
    totals: {
      grossCost,
      netCost,
      grossProceeds,
      netProceeds,
      netPnl,
      grossPnl,
      fees: grossPnl - netPnl,
      netReturnPct: netCost > 0 ? (100 * netPnl) / netCost : null,
      grossReturnPct: grossCost > 0 ? (100 * grossPnl) / grossCost : null,
      feeDragPp: netCost > 0 ? (100 * (grossPnl - netPnl)) / netCost : null,
    },
    reconciliation: {
      rowsExamined: source.length,
      ...counts,
      trips: trips.length,
      stillOpen,
      closesWithoutOpen,
      skippedRows,
    },
    equity: summarizeEquity(legs),
  };
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function units(legs: DanglingLeg[]): number {
  return legs.reduce((total, leg) => total + leg.quantity, 0);
}

// fallow-ignore-next-line complexity
export function formatRealizedPnlReport(report: RealizedPnlReport): string[] {
  const lines: string[] = [];
  for (const trip of report.trips) {
    const pct = trip.netCost > 0 ? (100 * (trip.netProceeds - trip.netCost)) / trip.netCost : 0;
    const label = trip.outcome === "expired" ? ` (${trip.subType || "expired"})` : "";
    lines.push(
      `  ${trip.underlying.padEnd(6)} ${trip.closeSymbol.padEnd(22)} ` +
        `cost $${trip.netCost.toFixed(0)} → $${trip.netProceeds.toFixed(0)}  ${signed(pct)}%${label}`,
    );
  }

  const t = report.totals;
  if (report.trips.length === 0) {
    lines.push("  (no round trips closed in this window)");
  } else {
    lines.push(
      `  ---- blended NET: $${t.netCost.toFixed(0)} → $${t.netProceeds.toFixed(0)}  ` +
        `${signed(t.netReturnPct ?? 0)}% ($${t.netPnl.toFixed(0)})`,
    );
    lines.push(
      `  ---- gross (pre-fee): ${signed(t.grossReturnPct ?? 0)}%  |  ` +
        `fees $${t.fees.toFixed(0)} = ${(t.feeDragPp ?? 0).toFixed(2)}pp of cost basis`,
    );
  }

  // Every open leg reaches a terminal state; this line is the proof.
  const r = report.reconciliation;
  lines.push(
    `  ---- reconciliation: rows ${r.rowsExamined} | opens ${r.openLegs} | closes ${r.closeLegs} | ` +
      `expirations ${r.expirationLegs} | trips ${r.trips} | ` +
      `still open ${r.stillOpen.length} legs (${units(r.stillOpen)} contracts) | ` +
      `closes w/o open in window ${r.closesWithoutOpen.length} (${units(r.closesWithoutOpen)} contracts)`,
  );
  for (const leg of r.stillOpen) {
    lines.push(
      `       STILL OPEN ${leg.underlying.padEnd(6)} ${leg.symbol.padEnd(22)} ` +
        `${leg.quantity} @ cost $${Math.abs(leg.netAmount).toFixed(0)} (opened ${leg.executedAt})`,
    );
  }
  for (const leg of r.closesWithoutOpen) {
    lines.push(
      `       PRE-WINDOW OPEN ${leg.underlying.padEnd(6)} ${leg.symbol.padEnd(22)} ` +
        `${leg.quantity} closed for $${leg.netAmount.toFixed(0)} — cost basis outside the window`,
    );
  }

  if (report.equity.rowCount > 0) {
    lines.push(
      `  ---- equity rows EXCLUDED from the options P&L: ${report.equity.rowCount} transactions ` +
        `across ${report.equity.symbols.join(", ")} | net cash flow $${report.equity.netCashFlow.toFixed(0)}`,
    );
  }

  return lines;
}
