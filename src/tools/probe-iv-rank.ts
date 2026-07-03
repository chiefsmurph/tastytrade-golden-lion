// Standalone diagnostic for the IV-rank pipeline (safe: read-only market data).
//
//   node --import tsx src/tools/probe-iv-rank.ts MARA SPY
//
// Answers three questions in one run:
//   1. Does `symbols: [..]` (what the bot sends today → `symbols[]=A`) return
//      anything, vs `symbols: "A,B"` (comma form the API documents)?
//   2. What does a real market-metrics entry look like (field names present)?
//   3. Is `implied-volatility-index-rank` on a 0–1 or 0–100 scale?
//
// Accepts both current (CORE_*) and legacy (BASE_URL/API_*) env names via
// env-compat so it runs against the server's un-migrated .env as well as a
// local one. Each request is reported independently, with the failing URL on
// error, so an auth failure is distinguishable from a market-metrics failure.
import "./env-compat";

interface HttpishError {
  message?: string;
  config?: { url?: string; baseURL?: string; params?: unknown };
  response?: { status?: number; data?: unknown };
}

function describeFailure(label: string, error: unknown): void {
  const e = error as HttpishError;
  const url = e?.config ? `${e.config.baseURL ?? ""}${e.config.url ?? ""}` : "(unknown request)";
  const params = e?.config?.params !== undefined ? JSON.stringify(e.config.params) : "-";
  console.log(`\n=== ${label} → FAILED ===`);
  console.log(`  request: ${url} params=${params}`);
  console.log(`  status:  ${e?.response?.status ?? "(none)"}`);
  console.log(`  body:    ${JSON.stringify(e?.response?.data) ?? "(none)"}`);
  console.log(`  message: ${e?.message ?? String(error)}`);
  if (String(e?.config?.url ?? "").includes("oauth") || String(url).includes("token")) {
    console.log("  → the OAuth token refresh itself failed: the refresh token/client secret in this .env is bad.");
  }
}

function summarize(label: string, data: unknown): unknown[] {
  const arr: unknown[] = Array.isArray(data)
    ? data
    : ((data as { items?: unknown[] })?.items ?? []);
  console.log(`\n=== ${label} → ${arr.length} entries ===`);
  if (arr.length === 0) {
    console.log("(empty — the API returned no entries for this query form)");
  }
  for (const rawEntry of arr) {
    const entry = rawEntry as Record<string, unknown>;
    console.log(
      JSON.stringify({
        symbol: entry?.symbol,
        "implied-volatility-index-rank": entry?.["implied-volatility-index-rank"],
        "tw-implied-volatility-index-rank": entry?.["tw-implied-volatility-index-rank"],
        "tos-implied-volatility-index-rank": entry?.["tos-implied-volatility-index-rank"],
        "implied-volatility-percentile": entry?.["implied-volatility-percentile"],
        "implied-volatility-index": entry?.["implied-volatility-index"],
      }),
    );
  }
  return arr;
}

async function main(): Promise<void> {
  const argSymbols = process.argv.slice(2).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const symbols = argSymbols.length > 0 ? argSymbols : ["MARA", "SPY"];

  const { default: tastytradeApi } = await import("~/core/tastytrade-client");

  // Auth + connectivity sanity check first, so a dead refresh token can't be
  // mistaken for a market-metrics problem.
  try {
    const accounts = await tastytradeApi.accountsAndCustomersService.getCustomerAccounts();
    console.log(`auth OK — ${Array.isArray(accounts) ? accounts.length : "?"} account(s) visible`);
  } catch (error) {
    describeFailure("auth sanity check (getCustomerAccounts)", error);
    console.log("\nStopping: fix credentials first (refresh token appears invalid for this environment).");
    process.exit(1);
  }

  let commaEntries: unknown[] = [];

  try {
    const asArray = await tastytradeApi.marketMetricsService.getMarketMetrics({ symbols });
    summarize("symbols as ARRAY (bot's current call → symbols[]=A&symbols[]=B)", asArray);
  } catch (error) {
    describeFailure("symbols as ARRAY (bot's current call)", error);
    console.log("  → if this failed while the comma form below succeeds, the brackets-serialization bug is confirmed.");
  }

  try {
    const asCommaString = await tastytradeApi.marketMetricsService.getMarketMetrics({
      symbols: symbols.join(","),
    });
    commaEntries = summarize("symbols as comma STRING (symbols=A,B)", asCommaString);
  } catch (error) {
    describeFailure("symbols as comma STRING", error);
  }

  const ranks = commaEntries
    .map((e) => Number((e as Record<string, unknown>)?.["implied-volatility-index-rank"]))
    .filter(Number.isFinite);
  if (ranks.length > 0) {
    const verdict = ranks.every((r) => r <= 1)
      ? "0–1 — must be ×100 before comparing to the 20/50/70 thresholds"
      : "0–100 — matches current thresholds as-is";
    console.log(`\nScale verdict across ${ranks.length} value(s) [${ranks.join(", ")}]: ${verdict}`);
  }

  const { getUnderlyingIvMetrics } = await import("~/core/market-metrics");
  console.log("\n=== getUnderlyingIvMetrics (what the bot actually sees today) ===");
  for (const symbol of symbols) {
    console.log(symbol, JSON.stringify(await getUnderlyingIvMetrics(symbol)));
  }

  process.exit(0);
}

main().catch((error: unknown) => {
  describeFailure("probe", error);
  process.exit(1);
});
