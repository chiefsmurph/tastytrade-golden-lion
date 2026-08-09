import tastytradeApi from "./tastytrade-client";

export interface UnderlyingIvMetrics {
  ivRank: number;              // 0–100 scale (matches UI "IV Rank")
  rawIvRank: number;           // pre-scale value straight from the API (0–1 decimal); kept for diagnostics/logs
  impliedVolatility: number | null; // raw IV index level (decimal, e.g. 1.187 = 118.7%)
}

const ivMetricsCache = new Map<string, { cachedAt: number; metrics: UnderlyingIvMetrics | null }>();
const IV_METRICS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The API returns implied-volatility-index-rank as a 0–1 decimal (live-verified
// 2026-07-03: MARA "0.355173693"); every threshold in this codebase (entry min
// 20, seed fallbacks 50/70) is 0–100, so fractional values are scaled up ×100.
//
// IV rank is contractually a 0–1 fraction, but it can transiently exceed 1.0 when
// current IV prints above its trailing-year high (rank slightly over 100%). The
// old `<= 1` guard mis-read such a raw 1.2 (= 120%, a HIGH-premium name) as a bare
// 1.2% "low premium" and skipped it. We now treat any raw value below
// IV_RANK_FRACTIONAL_MAX as a fraction and scale it; values at/above the cutoff are
// assumed already on the 0–100 scale (defensive against an API scale change). A
// real 0–1 rank never reaches the cutoff (max ~1.x), so the partition is clean.
const IV_RANK_FRACTIONAL_MAX = 2;

// ── Plausibility guards ─────────────────────────────────────────────────────
// The upstream feed emits ranks that a 52-week percentile cannot produce, and
// STRATEGY_MIN_IV_RANK_PCT gates live entries on this number, so a corrupt read
// flips a real gate. Ground truth, XXI on 2026-07-21 (one clean
// `strategy:getUnderlyingIvMetrics` series, ipc ids de-duplicated):
//
//   06:44  rank 35.48   IV 0.775
//   07:14  rank  1.38   IV 1.625   <- IV nearly doubled, rank collapsed
//   07:45  rank  1.30   IV 1.546
//   08:17  rank 87.32   IV 1.352   <- IV BELOW the 07:14 print, rank 87
//   08:45  rank 95.97   IV 1.409
//
// Rank is by construction monotonic in IV over a fixed trailing window, so
// "rank 1.4 at IV 1.625" and "rank 87.3 at IV 1.352" cannot both be true of the
// same window — this is corruption, not a market move. The 1.38/1.30 prints sit
// below the default STRATEGY_MIN_IV_RANK_PCT of 20, so they skipped XXI entries
// for an hour on the highest-premium name of that session.
//
// Two guards, in order:
//   1. RANGE (stateless, here): a percentile cannot be negative, and while it
//      can sit slightly above 100 when current IV prints above the trailing-year
//      high, it cannot run away. Anything outside [0, IV_RANK_PLAUSIBLE_MAX] is
//      not a rank.
//   2. TRANSITION (stateful, in getUnderlyingIvMetrics): rank and IV must move
//      in the same direction when both move materially.
//
// A rejected read resolves to `null`, i.e. exactly the existing
// "IV data unavailable" state that both consumers already handle — see
// getUnderlyingIvMetrics for why that is the fail-safe answer.
const IV_RANK_PLAUSIBLE_MIN = 0;
const IV_RANK_PLAUSIBLE_MAX = 150;

// Materiality thresholds for the directional-consistency check. Calibrated on
// 189 clean production samples across 13 sessions (117 consecutive transitions):
// every setting swept from (10 pts, 5%) to (30 pts, 20%) flagged the same 2
// transitions — both of them the XXI corruption above — and nothing else. The
// mid-range pair is used so ordinary rank drift (the healthy series move <5 pts
// per ~30-min probe) has a wide margin before it can trip the guard.
const IV_RANK_CONTRADICTION_MIN_RANK_DELTA = 20; // percentile points
const IV_RANK_CONTRADICTION_MIN_IV_REL_DELTA = 0.15; // fraction of the prior IV

// True when `ivRank` is outside the range a 52-week percentile can occupy.
export function isImplausibleIvRank(ivRank: number): boolean {
  return (
    !Number.isFinite(ivRank) ||
    ivRank < IV_RANK_PLAUSIBLE_MIN ||
    ivRank > IV_RANK_PLAUSIBLE_MAX
  );
}

// True when `next` contradicts `prior`: both rank and IV moved materially, but
// in OPPOSITE directions. Rank is a percentile of IV over a trailing window, so
// within that window it is monotonic in IV — IV up with rank down (or the
// reverse) means one of the two readings is wrong.
//
// Deliberately permissive: it needs BOTH a >= 20-point rank move AND a >= 15%
// relative IV move before it will call anything a contradiction, and a missing
// or non-positive IV on either side means no opinion (return false). The
// trailing window does roll, so tiny opposite moves are legitimate.
export function isContradictoryIvReading(
  prior: Pick<UnderlyingIvMetrics, "ivRank" | "impliedVolatility">,
  next: Pick<UnderlyingIvMetrics, "ivRank" | "impliedVolatility">,
): boolean {
  const priorIv = prior.impliedVolatility;
  const nextIv = next.impliedVolatility;
  if (priorIv == null || nextIv == null || !(priorIv > 0) || !(nextIv > 0)) {
    return false;
  }
  const rankDelta = next.ivRank - prior.ivRank;
  const ivRelDelta = (nextIv - priorIv) / priorIv;
  return (
    Math.abs(rankDelta) >= IV_RANK_CONTRADICTION_MIN_RANK_DELTA &&
    Math.abs(ivRelDelta) >= IV_RANK_CONTRADICTION_MIN_IV_REL_DELTA &&
    Math.sign(rankDelta) !== Math.sign(ivRelDelta)
  );
}

export function parseUnderlyingIvMetricsEntry(entry: unknown): UnderlyingIvMetrics | null {
  const record = entry as Record<string, unknown> | null | undefined;
  const rawIvRank = toNumber(record?.["implied-volatility-index-rank"]);
  if (rawIvRank == null) return null;

  const ivRank = rawIvRank < IV_RANK_FRACTIONAL_MAX ? rawIvRank * 100 : rawIvRank;
  if (isImplausibleIvRank(ivRank)) return null;

  return {
    ivRank,
    rawIvRank,
    impliedVolatility: toNumber(record?.["implied-volatility-index"]),
  };
}

// IPC boundary wrapper for `strategy:getUnderlyingIvMetrics`. The feed process
// skips the chain-walking candidate command for tickers this bot already holds,
// so this lightweight call is its only IV source for held names. Contract:
// unavailable data is a clean `null` — no error may cross the IPC boundary.
// `fetchMetrics` is injectable for tests only; production uses the cached
// getUnderlyingIvMetrics below (which itself resolves null on any failure).
export async function getUnderlyingIvMetricsForIpc(
  rawSymbol: string | undefined,
  fetchMetrics: (symbol: string) => Promise<UnderlyingIvMetrics | null> = getUnderlyingIvMetrics,
): Promise<UnderlyingIvMetrics | null> {
  const symbol = rawSymbol?.trim().toUpperCase();
  if (!symbol) return null;

  try {
    return (await fetchMetrics(symbol)) ?? null;
  } catch {
    return null;
  }
}

// ── Transition guard state ──────────────────────────────────────────────────
// Last ACCEPTED reading per symbol, used as the anchor for
// isContradictoryIvReading. Two rules keep a corrupt print from becoming the
// anchor and locking the guard onto bad data:
//
//   - a REJECTED read does not advance the anchor. This is what resolves the
//     XXI sequence: the anchor stays at 06:44 (rank 35.5, IV 0.775), 07:14 and
//     07:45 are both rejected against it, and 08:17 (rank 87.3, IV 1.352 — rank
//     UP, IV UP) is consistent with that anchor and is accepted.
//   - the anchor expires, by age and by consecutive-rejection count, so a
//     genuine regime change always re-baselines rather than being fought
//     forever. 2h spans the ~63-min XXI corruption with room to spare while
//     never carrying across a session; 3 rejections is one more than the worst
//     observed run.
const IV_ANCHOR_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const IV_ANCHOR_MAX_CONSECUTIVE_REJECTIONS = 3;

interface IvRankAnchor {
  metrics: UnderlyingIvMetrics;
  observedAt: number;
  consecutiveRejections: number;
}

const ivRankAnchorBySymbol = new Map<string, IvRankAnchor>();

// Must be the comma-separated string form: the SDK serializes arrays as
// symbols[]=X (qs brackets), which the API rejects with a bare 400.
function defaultFetchMarketMetrics(symbols: string): Promise<unknown> {
  return tastytradeApi.marketMetricsService.getMarketMetrics({ symbols });
}

// Test hook: expire the 5-minute response cache without touching the anchors,
// so a sequence of readings for one symbol can be replayed in a single tick.
export function clearUnderlyingIvMetricsCache(): void {
  ivMetricsCache.clear();
}

// Test hook: clear the per-symbol anchors AND the response cache between cases.
export function clearUnderlyingIvMetricsState(): void {
  ivRankAnchorBySymbol.clear();
  clearUnderlyingIvMetricsCache();
}

// Applies the transition guard and maintains the anchor. Returns the metrics to
// use, or null when the reading was rejected as implausible. Exported for tests
// so the shipped guard is exercised directly rather than re-implemented.
export function screenIvMetricsReading(
  key: string,
  metrics: UnderlyingIvMetrics,
  now: number,
): UnderlyingIvMetrics | null {
  const anchor = ivRankAnchorBySymbol.get(key);
  const anchorUsable =
    anchor != null &&
    now - anchor.observedAt <= IV_ANCHOR_MAX_AGE_MS &&
    anchor.consecutiveRejections < IV_ANCHOR_MAX_CONSECUTIVE_REJECTIONS;

  if (anchorUsable && isContradictoryIvReading(anchor.metrics, metrics)) {
    anchor.consecutiveRejections += 1;
    console.warn(
      JSON.stringify({
        scope: "market-metrics-iv-rank-rejected",
        reason: "contradictory-iv-rank-transition",
        symbol: key,
        ivRank: metrics.ivRank,
        impliedVolatility: metrics.impliedVolatility,
        anchorIvRank: anchor.metrics.ivRank,
        anchorImpliedVolatility: anchor.metrics.impliedVolatility,
        anchorAgeMs: now - anchor.observedAt,
        consecutiveRejections: anchor.consecutiveRejections,
        timestamp: new Date(now).toISOString(),
      }),
    );
    return null;
  }

  ivRankAnchorBySymbol.set(key, { metrics, observedAt: now, consecutiveRejections: 0 });
  return metrics;
}

// Resolves to null on ANY failure — including a reading rejected by the
// plausibility guards. null is deliberately the same "no IV data" state the
// existing API-outage path produces, because both consumers already handle it
// and both handle it in the safe direction:
//
//   - option-candidate/selection.ts skips the STRATEGY_MIN_IV_RANK_PCT gate
//     entirely when ivRank is null, so a rejected read no longer BLOCKS an
//     entry. That is the XXI failure mode, and it degrades to exactly what the
//     bot already does when market-metrics is down.
//   - strategy/seed-decision.ts returns shouldSeed:false when ivRank is null,
//     so a rejected read cannot open new margin exposure off a number we do not
//     trust.
//
// The alternative — serving the last good value — was rejected: it would put
// stale data behind a live gate and add a failure mode neither consumer models.
//
// `fetchMarketMetrics` is injectable for tests only (same seam as
// getUnderlyingIvMetricsForIpc); production callers pass the symbol alone.
export async function getUnderlyingIvMetrics(
  symbol: string,
  fetchMarketMetrics: (symbols: string) => Promise<unknown> = defaultFetchMarketMetrics,
): Promise<UnderlyingIvMetrics | null> {
  const key = symbol.toUpperCase();
  const now = Date.now();
  const cached = ivMetricsCache.get(key);

  if (cached && now - cached.cachedAt <= IV_METRICS_CACHE_TTL_MS) {
    return cached.metrics;
  }

  try {
    const data = await fetchMarketMetrics(key);

    // Response is an array of per-symbol objects
    const arr: any[] = Array.isArray(data) ? data : ((data as any)?.items ?? []);
    const entry = arr.find(
      (m: any) => String(m?.symbol ?? "").toUpperCase() === key,
    );

    if (!entry) {
      console.error(`[market-metrics] no market-metrics entry for ${key} — ivRank unavailable (cached ${IV_METRICS_CACHE_TTL_MS / 60000} min)`);
      ivMetricsCache.set(key, { cachedAt: now, metrics: null });
      return null;
    }

    const metrics = parseUnderlyingIvMetricsEntry(entry);
    if (metrics == null) {
      console.error(`[market-metrics] implied-volatility-index-rank missing/invalid/implausible for ${key} (raw: ${JSON.stringify(entry["implied-volatility-index-rank"])}) — ivRank unavailable (cached ${IV_METRICS_CACHE_TTL_MS / 60000} min)`);
      ivMetricsCache.set(key, { cachedAt: now, metrics: null });
      return null;
    }

    const screened = screenIvMetricsReading(key, metrics, now);
    // Cache the rejection too, so a corrupt upstream print does not turn into a
    // per-tick re-fetch storm.
    ivMetricsCache.set(key, { cachedAt: now, metrics: screened });
    return screened;
  } catch (error) {
    // Graceful degradation — no IV gate if API unavailable
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[market-metrics] market-metrics fetch failed for ${key}: ${message} — ivRank unavailable (cached ${IV_METRICS_CACHE_TTL_MS / 60000} min)`);
    ivMetricsCache.set(key, { cachedAt: now, metrics: null });
    return null;
  }
}
