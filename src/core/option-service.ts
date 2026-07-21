import { getUnderlyingPrice } from "./market-data";
import {
  restartOnFatalQuoteStreamerError,
  triggerQuoteStreamerRestart,
} from "./quote-streamer-recovery";
import { ensureQuoteStreamerSessionConnected } from "./quote-streamer-session";
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
    const chainLabels = data
      .map((chain) => `${chain["root-symbol"] ?? "?"}/${chain["option-chain-type"] ?? "?"}`)
      .join(", ");
    console.warn(
      `Received multiple option chains for symbol ${symbol}, using the first one: ${chainLabels}`,
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

export interface OptionVolumesSampleOptions {
  /** Hard cap on the streamer sampling window (ms). */
  sampleMs?: number;
  /** Streamer symbols whose greeks must ALL arrive before an early-exit may fire. */
  requiredSymbols?: readonly string[];
  /** Minimum time to sample before an early-exit is allowed (ms). */
  minSettleMs?: number;
  /** Underlying symbol — logging/telemetry only. */
  label?: string;
}

/** Pure: pull every streamer symbol (`*-streamer-symbol` fields) out of an option chain. */
export function extractStreamerSymbols(chain: unknown): string[] {
  const out = new Set<string>();
  (function collect(obj: any) {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && /streamer-symbol|streamer/.test(k)) out.add(v);
      else if (typeof v === "object") collect(v);
    }
  })(chain);
  return Array.from(out);
}

/**
 * Pure: have ALL required streamer symbols reported greeks yet? An empty required
 * set returns false so the sampler waits its full budget (no early-exit target).
 */
export function allRequiredCovered(
  required: readonly string[],
  coveredSymbols: ReadonlySet<string>,
): boolean {
  if (required.length === 0) return false;
  return required.every((s) => coveredSymbols.has(s));
}

export interface EarlyExitController {
  /** Resolves when sampling should stop (all required covered past the floor, or the cap). */
  readonly done: Promise<void>;
  /** Record that a streamer symbol reported greeks; may trigger an early exit. */
  markCovered(symbol: string): void;
  /** Clear any outstanding timers. Idempotent; safe to call after `done`. */
  cleanup(): void;
}

/**
 * Timing core for the D1 early-exit. Kept separate + fully injectable (now/setTimer/
 * clearTimer) so the exit logic is unit-testable with a fake clock, independent of the
 * live quote streamer. Resolves `done` when every `requiredSymbols` entry has been
 * markCovered()'d AND `minSettleMs` has elapsed, or when `sampleMs` caps out first.
 */
export function createEarlyExitController(opts: {
  sampleMs: number;
  requiredSymbols: readonly string[];
  minSettleMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}): EarlyExitController {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
  const { sampleMs, requiredSymbols } = opts;
  const minSettleMs = Math.min(Math.max(opts.minSettleMs ?? 0, 0), sampleMs);

  const covered = new Set<string>();
  const startedAt = now();
  let settled = false;
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });

  let capTimer: ReturnType<typeof setTimeout> | undefined;
  let floorTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (capTimer) clearTimer(capTimer);
    if (floorTimer) clearTimer(floorTimer);
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve();
  };
  const maybeEarly = () => {
    if (settled) return;
    if (now() - startedAt < minSettleMs) return;
    if (!allRequiredCovered(requiredSymbols, covered)) return;
    finish();
  };

  capTimer = setTimer(finish, sampleMs);
  if (requiredSymbols.length > 0 && minSettleMs > 0) {
    floorTimer = setTimer(maybeEarly, minSettleMs);
  }

  return {
    done,
    markCovered(symbol: string) {
      covered.add(symbol);
      maybeEarly();
    },
    cleanup,
  };
}

export interface OptionMarketSample {
  volumes: Record<string, number>;        // streamer symbol → day volume (traded today)
  openInterestBySymbol: Record<string, number>; // streamer symbol → open interest (standing)
  ivBySymbol: Record<string, number>;    // streamer symbol → implied volatility (decimal)
  deltaBySymbol: Record<string, number>; // streamer symbol → delta
}

// Serializes all connect/sample/disconnect cycles — DxLink doesn't support concurrent sessions.
let streamerMutex = Promise.resolve();

export async function fetchOptionVolumes(
  streamerSymbols: readonly string[],
  options: OptionVolumesSampleOptions = {},
): Promise<OptionMarketSample> {
  const queued = streamerMutex.then(() => fetchOptionVolumesInner(streamerSymbols, options));
  streamerMutex = queued.then(() => {}, () => {});
  return queued;
}

async function fetchOptionVolumesInner(
  streamerSymbols: readonly string[],
  options: OptionVolumesSampleOptions = {},
): Promise<OptionMarketSample> {
  try {
    const sampleMs = options.sampleMs ?? 5000;
    const requiredSymbols = options.requiredSymbols ?? [];
    const minSettleMs = Math.min(Math.max(options.minSettleMs ?? 0, 0), sampleMs);
    const resolvedStreamerSymbols = Array.from(new Set(streamerSymbols));

    if (resolvedStreamerSymbols.length === 0) {
      console.warn(
        "No streamer symbols to sample for",
        options.label ?? "(unknown)",
      );
      return { volumes: {}, openInterestBySymbol: {}, ivBySymbol: {}, deltaBySymbol: {} };
    }

    // Reuse the process-wide managed dxLink session. This used to call
    // quoteStreamer.connect() unconditionally — a brand-new dxLink session per
    // chain fetch, with the previous one orphaned but still keepalive-ing
    // server-side. That per-fetch churn is what saturated the account's
    // session limit (60 UNAUTHORIZED kicks on 2026-07-06).
    await ensureQuoteStreamerSessionConnected();

    const volumes: Record<string, number> = {};
    const openInterestBySymbol: Record<string, number> = {};
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

    // Volume and open interest are extracted separately — OI is standing
    // depth from Summary events, volume is today's traded activity. They
    // used to be max()-merged into one number, which made "volume" ambiguous.
    function extractVolumeFromEvent(
      ev: any,
    ): { symbol?: string; volume?: number; openInterest?: number } | null {
      if (!ev) return null;

      const symbol =
        ev.eventSymbol || ev.symbol || ev.s || ev.t || ev.ticker || ev[1];

      const vol = getMaxFiniteNumber(
        ev.volume,
        ev.dayVolume,
        ev["day-volume"],
        ev.totalVolume,
        ev["total-volume"],
      );
      const openInterest = getMaxFiniteNumber(
        ev.openInterest,
        ev["open-interest"],
        ev.oi,
      );

      if (vol != null || openInterest != null) {
        return {
          symbol,
          volume: vol ?? undefined,
          openInterest: openInterest ?? undefined,
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

    // D1 early-exit: stop as soon as every mandatory candidate strike has reported
    // greeks (past the settle floor), else wait out the sampleMs cap. The injectable,
    // unit-tested timing core lives in createEarlyExitController.
    const exit = createEarlyExitController({ sampleMs, requiredSymbols, minSettleMs });

    const removeListener = tastytradeApi.quoteStreamer.addEventListener(
      (events: any[]) => {
        const arr = Array.isArray(events) ? events : [events];
        for (const ev of arr) {
          rawEventCount += 1;

          try {
            const parsed = extractVolumeFromEvent(ev);
            if (parsed?.symbol && typeof parsed.volume === "number") {
              volumes[parsed.symbol] = Math.max(
                volumes[parsed.symbol] || 0,
                parsed.volume,
              );
            }
            if (parsed?.symbol && typeof parsed.openInterest === "number") {
              openInterestBySymbol[parsed.symbol] = Math.max(
                openInterestBySymbol[parsed.symbol] || 0,
                parsed.openInterest,
              );
            }

            const greeks = extractGreeksFromEvent(ev);
            if (greeks?.symbol) {
              if (greeks.volatility != null) {
                ivBySymbol[greeks.symbol] = greeks.volatility;
              }
              if (greeks.delta != null) {
                deltaBySymbol[greeks.symbol] = greeks.delta;
                exit.markCovered(greeks.symbol);
              }
            }
          } catch (e) {}
        }
      },
    );

    tastytradeApi.quoteStreamer.subscribe(resolvedStreamerSymbols);

    await exit.done;

    exit.cleanup();
    tastytradeApi.quoteStreamer.unsubscribe(resolvedStreamerSymbols);
    removeListener();
    // No disconnect here: the SDK's disconnect() only dropped listeners and
    // leaked the WebSocket anyway. The managed session stays connected for
    // reuse; quote-streamer-session owns teardown (shutdown/recovery).

    if (rawEventCount === 0) {
      console.warn(
        "No raw events received from quoteStreamer — check authentication and connectivity.",
      );
      // If streamer is authenticated out or hard-disconnected, force a PM2 restart.
      triggerQuoteStreamerRestart(
        "quoteStreamer produced zero raw events",
        {
          symbol: options.label ?? resolvedStreamerSymbols[0],
          streamerSymbolCount: resolvedStreamerSymbols.length,
        },
      );
    }

    return { volumes, openInterestBySymbol, ivBySymbol, deltaBySymbol };
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

export interface ChainMetricFieldNames {
  call: string;
  put: string;
  generic: string;
}

export const VOLUME_FIELD_NAMES: ChainMetricFieldNames = {
  call: "callVolume",
  put: "putVolume",
  generic: "volume",
};

export const OPEN_INTEREST_FIELD_NAMES: ChainMetricFieldNames = {
  call: "callOpenInterest",
  put: "putOpenInterest",
  generic: "openInterest",
};

export function mergeVolumesIntoChain(
  chain: TastytradeOptionChain,
  volumes: Record<string, number>,
  fieldNames: ChainMetricFieldNames = VOLUME_FIELD_NAMES,
) {
  if (!chain || typeof chain !== "object") return chain;
  const hasVolumeForKey = (key: string) =>
    Object.prototype.hasOwnProperty.call(volumes, key);

  // fallow-ignore-next-line complexity
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
                ? fieldNames.call
                : k.includes("put")
                  ? fieldNames.put
                  : fieldNames.generic;
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
  // D2 (2026-07-20): sample the UNION of the broad volume-sampling set and the
  // mandatory candidate strikes in ONE streamer window instead of two sequential
  // windows (was a fixed 5s + 7s = 12s floor). D1: early-exit as soon as every
  // mandatory candidate strike has reported greeks (capped at 7s), so liquid names
  // resolve in ~1-2s while illiquid names still fall back to the full window.
  const filteredStreamerSymbols = extractStreamerSymbols(filteredForVolumeSampling);
  const mandatoryStreamerSymbols = extractStreamerSymbols(mandatoryCandidateSamplingChain);
  const unionStreamerSymbols = Array.from(
    new Set([...filteredStreamerSymbols, ...mandatoryStreamerSymbols]),
  );

  const sample = await fetchOptionVolumes(unionStreamerSymbols, {
    sampleMs: 7000,
    requiredSymbols: mandatoryStreamerSymbols,
    minSettleMs: 1000,
    label: symbol.toUpperCase(),
  });

  const merged = mergeVolumesIntoChain(
    mergeVolumesIntoChain(optionChain, sample.volumes),
    sample.openInterestBySymbol,
    OPEN_INTEREST_FIELD_NAMES,
  );
  return mergeGreeksIntoChain(merged, sample.ivBySymbol, sample.deltaBySymbol);
}
