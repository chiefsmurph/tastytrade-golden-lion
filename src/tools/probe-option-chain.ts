// Standalone diagnostic for the option-chain data pipeline (read-only).
//
//   node --import tsx src/tools/probe-option-chain.ts MARA call [targetDTE]
//
// Runs the bot's real code path (fetchOptionChainWithVolume → streamer volume/
// greeks sampling → chooseOptionCandidates → getTopOptionCandidateForSymbol)
// and reports what actually came back:
//   - per-expiration coverage: how many strikes carry volume / IV / delta data
//     (volume is max(dayVolume-ish, openInterest) — OI is a fallback, not a
//     separate field; bid/ask SIZES are not captured anywhere in the bot)
//   - the candidates each account type would consider (cash ITM, margin OTM
//     delta-targeted), with their volume/iv/delta values
//   - the final top-candidate result including spread gate and ivRank
//
// Caveats: samples the live dxLink streamer (~12s), so avoid running while the
// prod bot is mid-cycle (session limits). On a closed market day expect thin
// volume; openInterest and last greeks usually still populate. If the streamer
// yields zero events this process exits via the quote-streamer restart path.
import "./env-compat";

interface Strikeish {
  [key: string]: unknown;
  callVolume?: number;
  putVolume?: number;
  callIv?: number;
  putIv?: number;
  callDelta?: number;
  putDelta?: number;
}

async function main(): Promise<void> {
  const symbol = (process.argv[2] ?? "MARA").trim().toUpperCase();
  const side = (process.argv[3] === "put" ? "put" : "call") as "call" | "put";
  const targetDTE = process.argv[4] ? Number(process.argv[4]) : undefined;

  const { default: tastytradeApi } = await import("~/core/tastytrade-client");
  const { chooseOptionCandidates, getOptionCandidateVolume } = await import(
    "~/bot/option-contracts"
  );
  const { getTopOptionCandidateForSymbol } = await import(
    "~/strategy/option-candidate"
  );
  const { getMarginTargetCallDelta } = await import("~/strategy/entry-filters");

  console.log(`Fetching chain + streamer sample for ${symbol} (${side})…`);
  const [chain, underlying] = await Promise.all([
    tastytradeApi.johnsService.fetchOptionChainWithVolume(symbol),
    tastytradeApi.johnsService.getUnderlyingPrice(symbol),
  ]);
  const underlyingPrice = underlying?.underlyingPrice || 0;
  console.log(`underlying price: ${underlyingPrice}`);

  console.log("\n=== per-expiration data coverage ===");
  console.log("dte | strikes | callVol>0 | maxCallVol | callIv | callDelta | putVol>0");
  for (const exp of chain.expirations ?? []) {
    const strikes = (exp.strikes ?? []) as unknown as Strikeish[];
    const withCallVol = strikes.filter((s) => Number(s.callVolume ?? 0) > 0).length;
    const withPutVol = strikes.filter((s) => Number(s.putVolume ?? 0) > 0).length;
    const withCallIv = strikes.filter((s) => s.callIv != null).length;
    const withCallDelta = strikes.filter((s) => s.callDelta != null).length;
    const maxCallVol = Math.max(0, ...strikes.map((s) => Number(s.callVolume ?? 0)));
    console.log(
      `${String(exp["days-to-expiration"]).padStart(3)} | ${String(strikes.length).padStart(7)} | ${String(withCallVol).padStart(9)} | ${String(maxCallVol).padStart(10)} | ${String(withCallIv).padStart(6)} | ${String(withCallDelta).padStart(9)} | ${String(withPutVol).padStart(8)}`,
    );
  }

  const printCandidates = (label: string, candidates: ReturnType<typeof chooseOptionCandidates>) => {
    console.log(`\n=== ${label}: ${candidates.length} candidate(s), top 5 ===`);
    for (const candidate of candidates.slice(0, 5)) {
      console.log(
        JSON.stringify({
          symbol: candidate.symbol,
          dte: candidate.dte,
          strike: candidate.strike,
          volume: getOptionCandidateVolume(candidate, side),
          iv: side === "call" ? candidate.callIv : candidate.putIv,
          delta: side === "call" ? candidate.callDelta : candidate.putDelta,
        }),
      );
    }
    if (candidates.length === 0) console.log("(none)");
  };

  printCandidates(
    "cash-style candidates (ITM)",
    chooseOptionCandidates(chain, underlyingPrice, { preferredDTE: targetDTE, strikeTarget: "itm" }, side),
  );
  printCandidates(
    `margin-style candidates (OTM, delta≈${getMarginTargetCallDelta()})`,
    chooseOptionCandidates(
      chain,
      underlyingPrice,
      { preferredDTE: targetDTE, strikeTarget: "otm", targetDelta: getMarginTargetCallDelta() },
      side,
    ),
  );

  console.log("\n=== full selection pipeline (spread gate + ivRank) ===");
  const top = await getTopOptionCandidateForSymbol(symbol, side, targetDTE);
  console.log(
    JSON.stringify(
      {
        symbol: top?.symbol ?? null,
        dte: top?.dte,
        ivRank: top?.ivRank,
        spreadPct: top?.spreadPct,
        maxAllowedSpreadPct: top?.maxAllowedSpreadPct,
        meetsSpreadRequirement: top?.meetsSpreadRequirement,
        meetsVolumeRequirement: (top as { meetsVolumeRequirement?: boolean } | undefined)
          ?.meetsVolumeRequirement,
        skippedByIvGate: top?.skippedByIvGate,
        skippedReason: top?.skippedReason ?? null,
      },
      null,
      2,
    ),
  );

  process.exit(0);
}

main().catch((error: unknown) => {
  const e = error as { response?: { status?: number; data?: unknown }; config?: { url?: string }; message?: string };
  console.error(
    "PROBE FAILED:",
    e?.config?.url ?? "",
    e?.response?.status ?? "",
    JSON.stringify(e?.response?.data) ?? e?.message ?? error,
  );
  process.exit(1);
});
