// Authoritative realized option round-trips for a date window, straight from the
// tastytrade transaction ledger (getAccountTransactions). Read-only.
//
//   node --import tsx src/tools/realized-pnl.ts 2026-07-20
//
// The data-pull run NDJSON is a per-cycle DECISION log and misses async fill
// confirmations, so it under-reports (and can mislabel a realized win as
// "idle"). This ledger is the truth: it matches Buy-to-Open ↔ Sell-to-Close per
// option symbol (FIFO) and prints realized $ + %.
import { config } from "dotenv";
config();

const ACCOUNTS: [string, string][] = [
  ["5WU18519", "cash"],
  ["5WI88116", "margin"],
];

interface Fill { symbol: string; underlying: string; qty: number; price: number; when: string; open: boolean; }

// fallow-ignore-next-line complexity
function isOptionTransaction(t: any): boolean {
  return String(t?.["instrument-type"] ?? "").includes("Option") || Boolean(String(t?.symbol ?? "").match(/\s\d{6}[CP]\d{8}$/));
}

// fallow-ignore-next-line complexity
async function main() {
  const startDate = process.argv[2] ?? new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const { default: api } = await import("../core/tastytrade-client");
  const svc: any = (api as any).transactionsService;

  for (const [acct, label] of ACCOUNTS) {
    let res: any;
    try { res = await svc.getAccountTransactions(acct, { "start-date": startDate }); }
    catch (e: any) { console.log(`\n=== ${label} — ledger error: ${e.message}`); continue; }
    const items: any[] = res?.items ?? res ?? [];
    const fills: Fill[] = (Array.isArray(items) ? items : [])
      .filter(isOptionTransaction)
      // fallow-ignore-next-line complexity
      .map((t) => {
        const sub = String(t?.["transaction-sub-type"] ?? "");
        const val = Number(t?.value ?? 0);
        const eff = String(t?.["value-effect"] ?? "");
        return {
          symbol: String(t?.symbol ?? ""),
          underlying: String(t?.["underlying-symbol"] ?? t?.symbol ?? "").split(/\s/)[0],
          qty: Math.abs(Number(t?.quantity ?? 0)),
          price: Number(t?.price ?? (val / (100 * Math.max(1, Math.abs(Number(t?.quantity ?? 1)))))),
          when: String(t?.["executed-at"] ?? "").slice(0, 16),
          open: /Open/i.test(sub) || eff === "Debit",
        };
      });

    // FIFO-match opens↔closes per option symbol
    const opens: Record<string, Fill[]> = {};
    const trips: { sym: string; under: string; cost: number; proceeds: number }[] = [];
    for (const f of fills.sort((a, b) => a.when.localeCompare(b.when))) {
      if (f.open) { (opens[f.symbol] ??= []).push(f); continue; }
      let remaining = f.qty;
      while (remaining > 0 && opens[f.symbol]?.length) {
        const o = opens[f.symbol][0];
        const m = Math.min(remaining, o.qty);
        trips.push({ sym: f.symbol, under: f.underlying, cost: m * o.price * 100, proceeds: m * f.price * 100 });
        o.qty -= m; remaining -= m;
        if (o.qty <= 0) opens[f.symbol].shift();
      }
    }

    console.log(`\n=== ${label} (${acct}) — realized round-trips since ${startDate} ===`);
    if (!trips.length) { console.log("  (none closed)"); continue; }
    let tc = 0, tp = 0;
    for (const t of trips) {
      const pct = t.cost > 0 ? (100 * (t.proceeds - t.cost)) / t.cost : 0;
      console.log(`  ${t.under.padEnd(6)} ${t.sym.padEnd(22)} cost $${t.cost.toFixed(0)} → $${t.proceeds.toFixed(0)}  ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`);
      tc += t.cost; tp += t.proceeds;
    }
    const total = tc > 0 ? (100 * (tp - tc)) / tc : 0;
    console.log(`  ---- blended: $${tc.toFixed(0)} → $${tp.toFixed(0)}  ${total >= 0 ? "+" : ""}${total.toFixed(1)}% ($${(tp - tc).toFixed(0)})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
