// Authoritative realized option round-trips for a date window, straight from the
// tastytrade transaction ledger (getAccountTransactions). Read-only.
//
//   node --import tsx src/tools/realized-pnl.ts 2026-07-20
//
// The data-pull run NDJSON is a per-cycle DECISION log and misses async fill
// confirmations, so it under-reports (and can mislabel a realized win as
// "idle"). This ledger is the truth: it matches every opening leg to a terminal
// event (Sell-to-Close OR expiration/assignment) per option symbol, FIFO, and
// prints realized $ + %.
//
// All matching arithmetic lives in realized-pnl-report.ts so it can be tested
// without a broker session; this file only fetches and prints.
import { config } from "dotenv";

import { buildRealizedPnlReport, formatRealizedPnlReport } from "./realized-pnl-report";

config();

const ACCOUNTS: [string, string][] = [
  ["5WU18519", "cash"],
  ["5WI88116", "margin"],
];

type TransactionsService = {
  getAccountTransactions: (account: string, params: Record<string, unknown>) => Promise<unknown>;
};

function readItems(res: unknown): unknown[] {
  if (Array.isArray(res)) return res;
  const items = (res as { items?: unknown })?.items;
  return Array.isArray(items) ? items : [];
}

async function reportAccount(
  svc: TransactionsService,
  account: string,
  label: string,
  startDate: string,
): Promise<void> {
  console.log(`\n=== ${label} (${account}) — realized option round-trips since ${startDate} ===`);
  // Deliberately one request, exactly as the broker call was always made. The
  // report echoes "rows examined" so a paged-off tail shows up as a suspiciously
  // round count plus a spike in "closes w/o open in window", rather than as a
  // silently short total.
  const res = await svc
    .getAccountTransactions(account, { "start-date": startDate })
    .catch((error: Error) => {
      console.log(`  ledger error: ${error.message}`);
      return null;
    });
  if (res === null) return;
  const rows = readItems(res);
  for (const line of formatRealizedPnlReport(buildRealizedPnlReport(rows))) {
    console.log(line);
  }
}

async function main() {
  const startDate = process.argv[2] ?? new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const { default: api } = await import("../core/tastytrade-client");
  const svc = (api as unknown as { transactionsService: TransactionsService }).transactionsService;

  for (const [account, label] of ACCOUNTS) {
    await reportAccount(svc, account, label, startDate);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
