import tastytradeApi from "~/core/tastytrade-client";
import {
  TastytradeOptionChain,
  TastytradeOptionChainWithVolumes,
  TastytradeStrikeWithVolumes,
} from "~/core/types";

const MIN_DTE = 28; // 4 weeks
const MAX_DTE = 42; // 6 weeks
const STRIKES_AROUND_ATM = 2;
const MIN_VOLUME = 120;

export interface OptionCandidateSelectionOptions {
  maxDTE?: number;
  minDTE?: number;
  preferredDTE?: number;
  strikeTarget?: "itm" | "otm";
  targetDelta?: number; // absolute value, e.g. 0.35; applied to whichever side is requested
}

export interface CandidateExpirationSelection {
  expirations: TastytradeOptionChainWithVolumes["expirations"];
  usedDteFallback: boolean;
}

export interface OptionCandidate extends TastytradeStrikeWithVolumes {
  dte: number;
  expirationDate: string;
  expirationType: string;
  streamerSymbol?: string;
  strike: number;
  symbol?: string;
}

function num(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

export function getOptionCandidateVolume(
  candidate: Pick<OptionCandidate, "callVolume" | "putVolume">,
  side: "call" | "put",
): number {
  return side === "call" ? Number(candidate.callVolume || 0) : Number(candidate.putVolume || 0);
}

export async function getOptionCandidates(
  symbol: string,
  side: "call" | "put" = "call",
  selectionOptions?: OptionCandidateSelectionOptions,
): Promise<ReturnType<typeof chooseOptionCandidates>> {
  const optionChain = await tastytradeApi.johnsService.fetchOptionChainWithVolume(
    symbol,
  );
  const underlyingPrice = await tastytradeApi.johnsService.getUnderlyingPrice(
    symbol,
  );
  const optionCandidates = chooseOptionCandidates(
    optionChain,
    underlyingPrice?.underlyingPrice || 0,
    selectionOptions,
    side,
  ).map((candidate) => ({
    ...candidate,
    meetsVolumeRequirement: getOptionCandidateVolume(candidate, side) >= MIN_VOLUME,
  }));
  if (optionCandidates.length === 0) {
    console.log("No option candidates found for", symbol);
    const fallbackOptionChainsByVolume = sortOptionChainByVolume(
      optionChain,
      side,
    );
    console.log(
      "Option chains sorted by volume:",
      JSON.stringify(fallbackOptionChainsByVolume, null, 2),
    );
  }
  return optionCandidates;
}

export function sortOptionChainByVolume(
  optionChain: TastytradeOptionChainWithVolumes,
  side: "call" | "put" = "call",
) {
  const sorted = optionChain.expirations
    .map(({ strikes, ...expiration }) =>
      strikes.map((strike) => ({
        ...expiration,
        ...strike,
        meetsVolumeRequirement: (strike[`${side}Volume`] || 0) >= MIN_VOLUME,
      })),
    )
    .flat()
    .sort((a, b) => (b[`${side}Volume`] || 0) - (a[`${side}Volume`] || 0));
  return sorted;
}

export function chooseOptionCandidates(
  optionChain: TastytradeOptionChainWithVolumes,
  underlyingPrice: number,
  selectionOptions: OptionCandidateSelectionOptions = {},
  side: "call" | "put" = "call",
): OptionCandidate[] {
  const { expirations, usedDteFallback } = resolveCandidateExpirations(
    optionChain,
    selectionOptions,
  );

  if (usedDteFallback) {
    console.warn(
      "No expirations found within DTE range for",
      optionChain["underlying-symbol"],
      "falling back to nearest available expiration",
    );
  }

  const strikeTarget = selectionOptions.strikeTarget ?? "itm";
  const targetDeltaAbs = selectionOptions.targetDelta ?? 0.35;
  const candidates: OptionCandidate[] = [];

  for (const exp of expirations) {
    const strikes = exp.strikes
      .map((strike) => ({
        expirationDate: exp["expiration-date"],
        expirationType: exp["expiration-type"],
        dte: num(exp["days-to-expiration"]),
        strike: num(strike["strike-price"]),
        symbol: side === "call" ? strike.call : strike.put,
        streamerSymbol: side === "call" ? strike["call-streamer-symbol"] : strike["put-streamer-symbol"],
        ...strike,
      }))
      .sort((a, b) => num(a["strike-price"]) - num(b["strike-price"]));

    if (strikeTarget === "otm") {
      // OTM for calls: strike > underlying; for puts: strike < underlying
      const otm = strikes.filter((s) =>
        side === "call" ? s.strike > underlyingPrice : s.strike < underlyingPrice,
      );
      if (!otm.length) continue;

      const hasDeltaData = otm.some((s) =>
        (side === "call" ? s.callDelta : s.putDelta) != null,
      );

      if (hasDeltaData) {
        // Pick strikes closest to target delta
        const sorted = [...otm].sort((a, b) => {
          const aDelta = Math.abs(
            (side === "call" ? a.callDelta : a.putDelta) ?? 0,
          );
          const bDelta = Math.abs(
            (side === "call" ? b.callDelta : b.putDelta) ?? 0,
          );
          return (
            Math.abs(aDelta - targetDeltaAbs) -
            Math.abs(bDelta - targetDeltaAbs)
          );
        });
        candidates.push(...sorted.slice(0, STRIKES_AROUND_ATM + 1));
      } else {
        // Fallback: first 1-2 strikes OTM from ATM
        const sorted =
          side === "call"
            ? [...otm].sort((a, b) => a.strike - b.strike)
            : [...otm].sort((a, b) => b.strike - a.strike);
        candidates.push(...sorted.slice(0, STRIKES_AROUND_ATM));
      }
    } else {
      // ITM: strike < underlying for calls, strike > underlying for puts
      const itm = strikes.filter((s) =>
        side === "call" ? s.strike < underlyingPrice : s.strike > underlyingPrice,
      );
      if (!itm.length) continue;

      // Closest ITM to ATM
      const closestItmIndex =
        side === "call" ? itm.length - 1 : 0;
      const step = side === "call" ? -1 : 1;
      const limit =
        side === "call"
          ? Math.max(0, closestItmIndex - STRIKES_AROUND_ATM)
          : Math.min(itm.length - 1, closestItmIndex + STRIKES_AROUND_ATM);

      for (let i = closestItmIndex; side === "call" ? i >= limit : i <= limit; i += step) {
        candidates.push(itm[i]);
      }
    }
  }

  return candidates;
}

export function resolveCandidateExpirations(
  optionChain: TastytradeOptionChainWithVolumes,
  selectionOptions: OptionCandidateSelectionOptions = {},
): CandidateExpirationSelection {
  const minDTE = selectionOptions.minDTE ?? MIN_DTE;
  const maxDTE = selectionOptions.maxDTE ?? MAX_DTE;
  const preferredDTE = selectionOptions.preferredDTE ?? 35;
  const expirationsInRange = optionChain.expirations
    .filter((exp) => {
      const dte = num(exp["days-to-expiration"]);
      return dte >= minDTE && dte <= maxDTE;
    })
    .sort((a, b) => compareExpirations(a, b, preferredDTE));
  const expirations =
    expirationsInRange.length > 0
      ? expirationsInRange
      : [...optionChain.expirations].sort((a, b) =>
          compareExpirations(a, b, preferredDTE),
        );

  if (!expirationsInRange.length) {
    if (!expirations.length) {
      console.warn(
        "No expirations found for",
        optionChain["underlying-symbol"],
      );
      return { expirations: [], usedDteFallback: false };
    }
  }

  return {
    expirations,
    usedDteFallback: expirationsInRange.length === 0,
  };
}

function compareExpirations(
  a: TastytradeOptionChain["expirations"][number],
  b: TastytradeOptionChain["expirations"][number],
  preferredDTE: number,
) {
  // Prefer regular monthly expirations, then closer to the preferred DTE.
  const aRegular = a["expiration-type"] === "Regular" ? 0 : 1;
  const bRegular = b["expiration-type"] === "Regular" ? 0 : 1;

  if (aRegular !== bRegular) {
    return aRegular - bRegular;
  }

  return (
    Math.abs(num(a["days-to-expiration"]) - preferredDTE) -
    Math.abs(num(b["days-to-expiration"]) - preferredDTE)
  );
}
