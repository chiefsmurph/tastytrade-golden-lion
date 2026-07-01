import { getUnderlyingPrice } from "./market-data";
import {
  restartOnFatalQuoteStreamerError,
  triggerQuoteStreamerRestart,
} from "./quote-streamer-recovery";
import tastytradeApi from "./tastytrade-client";
import {
  TastytradeOptionChain,
  TastytradeOptionChains,
  TastytradeOptionChainWithVolumes,
} from "./types";

const MAX_VOLUME_SAMPLE_DTE = 50;
const MAX_STRIKES_PER_EXPIRATION_FOR_VOLUME = 10;
const MAX_STRIKE_DISTANCE_RATIO_FOR_VOLUME = 0.12;
const MANDATORY_ITM_STRIKES_PER_EXPIRATION = 3;

export async function fetchOptionChain(symbol: string): Promise<TastytradeOptionChain> {
  const data: TastytradeOptionChains =
    await tastytradeApi.instrumentsService.getNestedOptionChain(symbol);
  if (data.length > 1) {
    console.warn(
      `Received multiple option chains for symbol ${symbol}, using the first one. Data:`,
      JSON.stringify(data, null, 2),
    );
  }
  return data[0];
}

function toNumber(value: string | number | undefined): number {
  if (typeof value === "number") {
    return value;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickMandatoryCandidateStrikes(
  strikes: TastytradeOptionChain["expirations"][number]["strikes"],
  underlyingPrice: number,
) {
  if (underlyingPrice <= 0 || strikes.length === 0) {
    return [];
  }

  const sortedByStrike = [...strikes].sort(
    (left, right) =>
      toNumber(left["strike-price"]) - toNumber(right["strike-price"]),
  );
  const itm = sortedByStrike.filter(
    (strike) => toNumber(strike["strike-price"]) < underlyingPrice,
  );

  if (itm.length === 0) {
    return [];
  }

  return itm.slice(-MANDATORY_ITM_STRIKES_PER_EXPIRATION);
}

export function filterOptionChainForVolumeSampling(
  optionChain: TastytradeOptionChain,
  underlyingPrice: number,
): TastytradeOptionChain {
  const maxStrikeDistance =
    underlyingPrice > 0
      ? underlyingPrice * MAX_STRIKE_DISTANCE_RATIO_FOR_VOLUME
      : Number.POSITIVE_INFINITY;

  return {
    ...optionChain,
    expirations: optionChain.expirations
      .filter(
        (expiration) =>
          toNumber(expiration["days-to-expiration"]) <= MAX_VOLUME_SAMPLE_DTE,
      )
      .map((expiration) => {
        const strikesWithinBand = expiration.strikes.filter((strike) => {
          const strikePrice = toNumber(strike["strike-price"]);
          return Math.abs(strikePrice - underlyingPrice) <= maxStrikeDistance;
        });
        const candidateStrikesByDistance =
          strikesWithinBand.length > 0 ? strikesWithinBand : expiration.strikes;
        const cappedByDistance = [...candidateStrikesByDistance]
          .sort((left, right) => {
            const leftDistance = Math.abs(
              toNumber(left["strike-price"]) - underlyingPrice,
            );
            const rightDistance = Math.abs(
              toNumber(right["strike-price"]) - underlyingPrice,
            );
            return leftDistance - rightDistance;
          })
          .slice(0, MAX_STRIKES_PER_EXPIRATION_FOR_VOLUME);
        const mandatoryCandidateStrikes = pickMandatoryCandidateStrikes(
          expiration.strikes,
          underlyingPrice,
        );
        const strikes = Array.from(
          new Map(
            [...cappedByDistance, ...mandatoryCandidateStrikes].map((strike) => [
              strike["strike-price"],
              strike,
            ]),
          ).values(),
        );

        return {
          ...expiration,
          strikes,
        };
      })
      .filter((expiration) => expiration.strikes.length > 0),
  };
}

export function buildMandatoryCandidateSamplingChain(
  optionChain: TastytradeOptionChain,
  underlyingPrice: number,
): TastytradeOptionChain {
  return {
    ...optionChain,
    expirations: optionChain.expirations
      .filter(
        (expiration) =>
          toNumber(expiration["days-to-expiration"]) <= MAX_VOLUME_SAMPLE_DTE,
      )
      .map((expiration) => ({
        ...expiration,
        strikes: pickMandatoryCandidateStrikes(
          expiration.strikes,
          underlyingPrice,
        ),
      }))
      .filter((expiration) => expiration.strikes.length > 0),
  };
}

function mergeVolumeMaps(
  primary: Record<string, number>,
  secondary: Record<string, number>,
) {
  const merged = { ...primary };
  for (const [symbol, volume] of Object.entries(secondary)) {
    const current = merged[symbol];
    merged[symbol] =
      current == null ? toNumber(volume) : Math.max(toNumber(current), toNumber(volume));
  }
  return merged;
}

function mergeIvMaps(
  primary: Record<string, number>,
  secondary: Record<string, number>,
): Record<string, number> {
  return { ...secondary, ...primary }; // primary wins (first sample)
}

export interface OptionMarketSample {
  volumes: Record<string, number>;
  ivBySymbol: Record<string, number>;    // streamer symbol → implied volatility (decimal)
  deltaBySymbol: Record<string, number>; // streamer symbol → delta
}

// Serializes all connect/sample/disconnect cycles — DxLink doesn't support concurrent sessions.
let streamerMutex = Promise.resolve();

export async function fetchOptionVolumes(
  optionChain: TastytradeOptionChain,
  sampleMs = 5000,
): Promise<OptionMarketSample> {
  const queued = streamerMutex.then(() => fetchOptionVolumesInner(optionChain, sampleMs));
  streamerMutex = queued.then(() => {}, () => {});
  return queued;
}

async function fetchOptionVolumesInner(
  optionChain: TastytradeOptionChain,
  sampleMs = 5000,
): Promise<OptionMarketSample> {
  try {
    const streamerSymbols = new Set<string>();
    function collect(obj: any) {
      if (!obj || typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && /streamer-symbol|streamer/.test(k)) {
          streamerSymbols.add(v);
        } else if (typeof v === "object") {
          collect(v);
        }
      }
    }
    collect(optionChain);
    const resolvedStreamerSymbols = Array.from(streamerSymbols);

    if (resolvedStreamerSymbols.length === 0) {
      console.warn(
        "No streamer symbols found in nested option chain for",
        optionChain["underlying-symbol"],
      );
      return { volumes: {}, ivBySymbol: {}, deltaBySymbol: {} };
    }

    await tastytradeApi.quoteStreamer.connect();

    const volumes: Record<string, number> = {};
    const ivBySymbol: Record<string, number> = {};
    const deltaBySymbol: Record<string, number> = {};
    let rawEventCount = 0;

    function toNumberMaybe(value: any): number | null {
      if (value == null) return null;
      if (typeof value === "number" && !Number.isNaN(value)) return value;
      if (typeof value === "string") {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    }

    function getMaxFiniteNumber(
      ...values: any[]
    ): number | null {
      let maxFinite: number | null = null;

      for (const value of values) {
        const parsed = toNumberMaybe(value);
        if (parsed != null) {
          if (maxFinite == null || parsed > maxFinite) {
            maxFinite = parsed;
          }
        }
      }

      return maxFinite;
    }

    function extractVolumeFromEvent(
      ev: any,
    ): { symbol?: string; volume?: number; source?: string } | null {
      if (!ev) return null;

      const symbol =
        ev.eventSymbol || ev.symbol || ev.s || ev.t || ev.ticker || ev[1];

      const vol = getMaxFiniteNumber(
        ev.volume,
        ev.dayVolume,
        ev["day-volume"],
        ev.totalVolume,
        ev["total-volume"],
        ev.openInterest,
        ev["open-interest"],
        ev.oi,
      );
      if (vol != null) {
        return {
          symbol,
          source:
            ev.volume != null ||
            ev.dayVolume != null ||
            ev["day-volume"] != null ||
            ev.totalVolume != null ||
            ev["total-volume"] != null
              ? "volume"
              : "openInterest",
          volume: vol,
        };
      }

      return null;
    }

    function extractGreeksFromEvent(
      ev: any,
    ): { symbol?: string; volatility?: number; delta?: number } | null {
      if (!ev) return null;
      const symbol =
        ev.eventSymbol || ev.symbol || ev.s || ev.t || ev.ticker || ev[1];
      if (!symbol) return null;
      const volatility = toNumberMaybe(
        ev.volatility ?? ev.impliedVolatility ?? ev["implied-volatility"],
      );
      const delta = toNumberMaybe(ev.delta);
      if (volatility == null && delta == null) return null;
      return {
        symbol,
        volatility: volatility != null && volatility > 0 ? volatility : undefined,
        delta: delta ?? undefined,
      };
    }

    const removeListener = tastytradeApi.quoteStreamer.addEventListener(
      (events: any[]) => {
        const arr = Array.isArray(events) ? events : [events];
        for (const ev of arr) {
          rawEventCount += 1;

          try {
            const parsed = extractVolumeFromEvent(ev);
            if (parsed && parsed.symbol && typeof parsed.volume === "number") {
              volumes[parsed.symbol] = Math.max(
                volumes[parsed.symbol] || 0,
                parsed.volume,
              );
            }

            const greeks = extractGreeksFromEvent(ev);
            if (greeks?.symbol) {
              if (greeks.volatility != null) {
                ivBySymbol[greeks.symbol] = greeks.volatility;
              }
              if (greeks.delta != null) {
                deltaBySymbol[greeks.symbol] = greeks.delta;
              }
            }
          } catch (e) {}
        }
      },
    );

    tastytradeApi.quoteStreamer.subscribe(resolvedStreamerSymbols);

    await new Promise((res) => setTimeout(res, sampleMs));

    tastytradeApi.quoteStreamer.unsubscribe(resolvedStreamerSymbols);
    removeListener();
    tastytradeApi.quoteStreamer.disconnect();

    if (rawEventCount === 0) {
      console.warn(
        "No raw events received from quoteStreamer — check authentication and connectivity.",
      );
      // If streamer is authenticated out or hard-disconnected, force a PM2 restart.
      triggerQuoteStreamerRestart(
        "quoteStreamer produced zero raw events",
        {
          symbol: optionChain["underlying-symbol"],
          streamerSymbolCount: resolvedStreamerSymbols.length,
        },
      );
    }

    return { volumes, ivBySymbol, deltaBySymbol };
  } catch (err: any) {
    console.error("Error collecting option volumes:", err?.message || err);
    restartOnFatalQuoteStreamerError("fetchOptionVolumes", err);
    throw err;
  }
}

export function candidateSymbolsFor(raw: string | undefined) {
  if (!raw) return [];
  const out = new Set<string>();
  out.add(raw);
  out.add(raw.replace(/^\.\//, ""));
  out.add(raw.replace(/^\./, ""));
  out.add(raw.replace(/:.+$/, ""));
  out.add(raw.startsWith(".") ? raw : `.${raw}`);
  out.add(raw.startsWith(".") ? raw.slice(1) : raw);
  return Array.from(out);
}

export function mergeVolumesIntoChain(
  chain: TastytradeOptionChain,
  volumes: Record<string, number>,
) {
  if (!chain || typeof chain !== "object") return chain;
  const hasVolumeForKey = (key: string) =>
    Object.prototype.hasOwnProperty.call(volumes, key);

  function merge(obj: any) {
    if (!obj || typeof obj !== "object") return;
    const keysToCheck = [
      "call-streamer-symbol",
      "put-streamer-symbol",
      "callStreamerSymbol",
      "putStreamerSymbol",
      "call",
      "put",
      "symbol",
    ];
    let attached = false;
    for (const k of keysToCheck) {
      if (k in obj) {
        const raw = obj[k];
        if (typeof raw === "string") {
          const candidates = candidateSymbolsFor(raw);
          for (const c of candidates) {
            if (hasVolumeForKey(c)) {
              const short = k.includes("call")
                ? "callVolume"
                : k.includes("put")
                  ? "putVolume"
                  : "volume";
              obj[short] = volumes[c];
              attached = true;
              break;
            }
          }
        }
      }
    }

    for (const v of Object.values(obj)) {
      if (typeof v === "object") merge(v);
    }
    return attached;
  }

  const cloned = JSON.parse(JSON.stringify(chain));
  merge(cloned);
  return cloned as TastytradeOptionChainWithVolumes;
}

export function mergeGreeksIntoChain(
  chain: TastytradeOptionChainWithVolumes,
  ivBySymbol: Record<string, number>,
  deltaBySymbol: Record<string, number>,
): TastytradeOptionChainWithVolumes {
  if (!chain || typeof chain !== "object") return chain;
  const hasKey = (map: Record<string, number>, key: string) =>
    Object.prototype.hasOwnProperty.call(map, key);

  function merge(obj: any) {
    if (!obj || typeof obj !== "object") return;
    const callStreamer = obj["call-streamer-symbol"];
    const putStreamer = obj["put-streamer-symbol"];

    if (typeof callStreamer === "string") {
      for (const c of candidateSymbolsFor(callStreamer)) {
        if (hasKey(ivBySymbol, c)) { obj.callIv = ivBySymbol[c]; break; }
      }
      for (const c of candidateSymbolsFor(callStreamer)) {
        if (hasKey(deltaBySymbol, c)) { obj.callDelta = deltaBySymbol[c]; break; }
      }
    }

    if (typeof putStreamer === "string") {
      for (const c of candidateSymbolsFor(putStreamer)) {
        if (hasKey(ivBySymbol, c)) { obj.putIv = ivBySymbol[c]; break; }
      }
      for (const c of candidateSymbolsFor(putStreamer)) {
        if (hasKey(deltaBySymbol, c)) { obj.putDelta = deltaBySymbol[c]; break; }
      }
    }

    for (const v of Object.values(obj)) {
      if (typeof v === "object") merge(v);
    }
  }

  const cloned = JSON.parse(JSON.stringify(chain));
  merge(cloned);
  return cloned as TastytradeOptionChainWithVolumes;
}

export async function fetchOptionChainWithVolume(symbol: string) {
  const optionChain = await fetchOptionChain(symbol);
  if (!optionChain) {
    console.warn(`No option chain found for ${symbol} — returning empty chain`);
    return {
      'underlying-symbol': symbol.toUpperCase(),
      'root-symbol': symbol.toUpperCase(),
      'option-chain-type': '',
      'shares-per-contract': 100,
      expirations: [],
    } satisfies TastytradeOptionChainWithVolumes;
  }
  const underlyingPrice = await getUnderlyingPrice(symbol);
  const resolvedUnderlyingPrice = underlyingPrice?.underlyingPrice || 0;
  const filteredForVolumeSampling = filterOptionChainForVolumeSampling(
    optionChain,
    resolvedUnderlyingPrice,
  );
  const mandatoryCandidateSamplingChain = buildMandatoryCandidateSamplingChain(
    optionChain,
    resolvedUnderlyingPrice,
  );
  const { volumes: optionVolumes, ivBySymbol: optionIvBySymbol, deltaBySymbol: optionDeltaBySymbol } =
    await fetchOptionVolumes(filteredForVolumeSampling, 5000);
  const { volumes: mandatoryCandidateVolumes, ivBySymbol: mandatoryIvBySymbol, deltaBySymbol: mandatoryDeltaBySymbol } =
    await fetchOptionVolumes(mandatoryCandidateSamplingChain, 7000);
  const mergedOptionVolumes = mergeVolumeMaps(optionVolumes, mandatoryCandidateVolumes);
  const mergedIvBySymbol = mergeIvMaps(optionIvBySymbol, mandatoryIvBySymbol);
  const mergedDeltaBySymbol = mergeIvMaps(optionDeltaBySymbol, mandatoryDeltaBySymbol);
  const merged = mergeVolumesIntoChain(optionChain, mergedOptionVolumes);
  return mergeGreeksIntoChain(merged, mergedIvBySymbol, mergedDeltaBySymbol);
}
