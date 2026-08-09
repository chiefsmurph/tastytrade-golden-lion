import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearUnderlyingIvMetricsCache,
  clearUnderlyingIvMetricsState,
  getUnderlyingIvMetrics,
  isContradictoryIvReading,
  isImplausibleIvRank,
  parseUnderlyingIvMetricsEntry,
  screenIvMetricsReading,
  type UnderlyingIvMetrics,
} from "~/core/market-metrics";

// Optional chaining inside an assertion counts as real branching to complexity
// tooling while adding none; these keep the assertion bodies flat.
const rankOf = (raw: string): number | undefined =>
  parseUnderlyingIvMetricsEntry({ "implied-volatility-index-rank": raw })?.ivRank;

const assertCloseTo = (actual: number | undefined, expected: number, eps = 1e-6): void => {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < eps,
    `expected ${String(actual)} within ${eps} of ${expected}`,
  );
};

// ── Production fixtures ─────────────────────────────────────────────────────
// Every reading below is a real `strategy:getUnderlyingIvMetrics` IPC response
// lifted verbatim from data-pull pm2 logs. They are joined to their request by
// IPC id, dropping the 20/10114 ids the client reuses (Date.now collisions) —
// without that de-duplication the joined series are contaminated and show
// jumps that never happened.
//
// XXI on 2026-07-21 is the corruption this guard exists for. Rank is a
// percentile of IV over a trailing window, so within that window it is
// monotonic in IV; "rank 1.38 at IV 1.625" and "rank 87.32 at IV 1.352" cannot
// both describe the same window.
const XXI_2026_07_21: ReadonlyArray<{ at: string; metrics: UnderlyingIvMetrics }> = [
  { at: "06:44:26", metrics: { ivRank: 35.4833948, rawIvRank: 0.354833948, impliedVolatility: 0.775170784 } },
  { at: "07:14:48", metrics: { ivRank: 1.376383764, rawIvRank: 0.01376383764, impliedVolatility: 1.624849485 } },
  { at: "07:45:24", metrics: { ivRank: 1.301697417, rawIvRank: 0.01301697417, impliedVolatility: 1.546109589 } },
  { at: "08:17:40", metrics: { ivRank: 87.3210332, rawIvRank: 0.873210332, impliedVolatility: 1.351756544 } },
  { at: "08:45:26", metrics: { ivRank: 95.9704797, rawIvRank: 0.959704797, impliedVolatility: 1.409115615 } },
  { at: "09:16:53", metrics: { ivRank: 83.202952, rawIvRank: 0.83202952, impliedVolatility: 1.084230805 } },
  { at: "09:55:52", metrics: { ivRank: 75.1143911, rawIvRank: 0.751143911, impliedVolatility: 1.257075954 } },
  { at: "10:29:12", metrics: { ivRank: 71.704797, rawIvRank: 0.71704797, impliedVolatility: 1.191595346 } },
  { at: "10:59:52", metrics: { ivRank: 69.195572, rawIvRank: 0.69195572, impliedVolatility: 1.087134801 } },
  { at: "11:32:26", metrics: { ivRank: 47.1143911, rawIvRank: 0.471143911, impliedVolatility: 0.843304324 } },
  { at: "12:03:24", metrics: { ivRank: 64.1328413, rawIvRank: 0.641328413, impliedVolatility: 1.06344471 } },
  { at: "12:35:26", metrics: { ivRank: 67.5719557, rawIvRank: 0.675719557, impliedVolatility: 1.165085535 } },
];

// Healthy control series, same extraction, same sessions. If the guard ever
// fires on one of these it is mis-calibrated: these are the ordinary shape of
// an IV-rank series and every one of them must survive untouched.
const HEALTHY_SERIES: ReadonlyArray<{
  name: string;
  readings: ReadonlyArray<{ ivRank: number; impliedVolatility: number }>;
}> = [
  {
    name: "ASAN 2026-07-22",
    readings: [
      { ivRank: 95.6862745, impliedVolatility: 0.611793878 },
      { ivRank: 85.7107843, impliedVolatility: 0.560677465 },
      { ivRank: 82.1078431, impliedVolatility: 0.542568308 },
      { ivRank: 75.122549, impliedVolatility: 0.507265717 },
      { ivRank: 84.1911765, impliedVolatility: 0.553153152 },
      { ivRank: 86.5686275, impliedVolatility: 0.565144042 },
      { ivRank: 78.3823529, impliedVolatility: 0.523869719 },
      { ivRank: 76.5931373, impliedVolatility: 0.514810621 },
      { ivRank: 80.8823529, impliedVolatility: 0.536450696 },
      { ivRank: 77.9411765, impliedVolatility: 0.521633159 },
      { ivRank: 82.3529412, impliedVolatility: 0.543813574 },
      { ivRank: 83.8235294, impliedVolatility: 0.551295306 },
    ],
  },
  {
    name: "CRML 2026-07-20 (genuinely low-rank all day)",
    readings: [
      { ivRank: 7.0396387, impliedVolatility: 1.11258502 },
      { ivRank: 6.6482689, impliedVolatility: 1.106448711 },
      { ivRank: 10.0401405, impliedVolatility: 1.159607295 },
      { ivRank: 8.6402408, impliedVolatility: 1.13765533 },
      { ivRank: 9.8896136, impliedVolatility: 1.157247158 },
      { ivRank: 9.7441044, impliedVolatility: 1.154964742 },
      { ivRank: 9.7691922, impliedVolatility: 1.155358187 },
      { ivRank: 10.2558956, impliedVolatility: 1.16299098 },
      { ivRank: 10.0401405, impliedVolatility: 1.159607295 },
      { ivRank: 11.0, impliedVolatility: 1.174655537 },
      { ivRank: 9.0817863, impliedVolatility: 1.144581486 },
    ],
  },
  {
    name: "SG 2026-07-20",
    readings: [
      { ivRank: 61.4, impliedVolatility: 0.398 },
      { ivRank: 59.9, impliedVolatility: 0.393 },
      { ivRank: 61.9, impliedVolatility: 0.4 },
      { ivRank: 62.0, impliedVolatility: 0.4005 },
      { ivRank: 63.3, impliedVolatility: 0.405 },
      { ivRank: 61.2, impliedVolatility: 0.3975 },
      { ivRank: 59.8, impliedVolatility: 0.3927 },
      { ivRank: 61.7, impliedVolatility: 0.3993 },
      { ivRank: 64.3, impliedVolatility: 0.4085 },
      { ivRank: 63.2, impliedVolatility: 0.4047 },
      { ivRank: 63.7, impliedVolatility: 0.4064 },
      { ivRank: 60.7, impliedVolatility: 0.396 },
    ],
  },
];

const MIN = 60 * 1000;

// ── Stateless range guard (parseUnderlyingIvMetricsEntry) ───────────────────

test("parse rejects ranks outside what a 52-week percentile can be", () => {
  // Negative percentile.
  assert.equal(parseUnderlyingIvMetricsEntry({ "implied-volatility-index-rank": "-0.4" }), null);
  // Already-0-100-scale garbage well past the ceiling.
  assert.equal(parseUnderlyingIvMetricsEntry({ "implied-volatility-index-rank": "151" }), null);
  assert.equal(parseUnderlyingIvMetricsEntry({ "implied-volatility-index-rank": "9999" }), null);
});

test("parse still accepts the legitimate over-100 case and ordinary ranks", () => {
  // Current IV above its trailing-year high => rank slightly over 100%. This is
  // real and must survive: the whole point of IV_RANK_FRACTIONAL_MAX.
  assert.equal(rankOf("1.2"), 120);
  assert.equal(rankOf("1"), 100);
  assert.equal(rankOf("0"), 0);
  assertCloseTo(rankOf("0.355173693"), 35.5173693, 1e-9);
});

test("isImplausibleIvRank flags only out-of-range values", () => {
  assert.equal(isImplausibleIvRank(-0.0001), true);
  assert.equal(isImplausibleIvRank(150.0001), true);
  assert.equal(isImplausibleIvRank(Number.NaN), true);
  assert.equal(isImplausibleIvRank(Number.POSITIVE_INFINITY), true);
  assert.equal(isImplausibleIvRank(0), false);
  assert.equal(isImplausibleIvRank(1.3), false); // a low rank alone is NOT implausible
  assert.equal(isImplausibleIvRank(100), false);
  assert.equal(isImplausibleIvRank(120), false);
});

// ── Directional-consistency predicate ───────────────────────────────────────

test("isContradictoryIvReading flags the XXI transitions and nothing in the healthy series", () => {
  const anchor = XXI_2026_07_21[0].metrics; // 06:44 rank 35.48 / IV 0.775
  // IV nearly doubled while rank collapsed 34 points — impossible for one window.
  assert.equal(isContradictoryIvReading(anchor, XXI_2026_07_21[1].metrics), true);
  assert.equal(isContradictoryIvReading(anchor, XXI_2026_07_21[2].metrics), true);
  // Rank UP and IV UP relative to the same anchor — consistent, must pass.
  assert.equal(isContradictoryIvReading(anchor, XXI_2026_07_21[3].metrics), false);
  assert.equal(isContradictoryIvReading(anchor, XXI_2026_07_21[4].metrics), false);

  for (const series of HEALTHY_SERIES) {
    for (let i = 1; i < series.readings.length; i++) {
      const prior = { ...series.readings[i - 1], rawIvRank: 0 };
      const next = { ...series.readings[i], rawIvRank: 0 };
      assert.equal(
        isContradictoryIvReading(prior, next),
        false,
        `${series.name} transition ${i} must not be flagged`,
      );
    }
  }
});

test("isContradictoryIvReading has no opinion without usable IV on both sides", () => {
  const withIv = { ivRank: 90, impliedVolatility: 0.2 };
  const noIv = { ivRank: 5, impliedVolatility: null };
  assert.equal(isContradictoryIvReading(withIv, noIv), false);
  assert.equal(isContradictoryIvReading(noIv, withIv), false);
  assert.equal(
    isContradictoryIvReading({ ivRank: 90, impliedVolatility: 0 }, { ivRank: 5, impliedVolatility: 1 }),
    false,
  );
});

test("isContradictoryIvReading needs BOTH moves to be material", () => {
  const prior = { ivRank: 50, impliedVolatility: 1.0 };
  // Opposite directions, but the rank move is under 20 points.
  assert.equal(isContradictoryIvReading(prior, { ivRank: 31, impliedVolatility: 1.5 }), false);
  // Opposite directions, big rank move, but the IV move is under 15%.
  assert.equal(isContradictoryIvReading(prior, { ivRank: 20, impliedVolatility: 1.14 }), false);
  // Both material and opposite.
  assert.equal(isContradictoryIvReading(prior, { ivRank: 20, impliedVolatility: 1.5 }), true);
});

// ── Stateful screening (anchor behaviour) ───────────────────────────────────

test("the real XXI session: both corrupt reads rejected, the recovery accepted", () => {
  clearUnderlyingIvMetricsState();
  const at = (hhmmss: string): number => {
    const [h, m, s] = hhmmss.split(":").map(Number);
    return new Date(2026, 6, 21, h, m, s).getTime();
  };

  const outcomes = XXI_2026_07_21.map(
    (r) => screenIvMetricsReading("XXI", r.metrics, at(r.at)) !== null,
  );

  // 06:44 accepted (first reading, no anchor), 07:14 + 07:45 rejected,
  // everything from 08:17 on accepted.
  assert.deepEqual(outcomes, [
    true, false, false, true, true, true, true, true, true, true, true, true,
  ]);
});

test("a rejected read never becomes the anchor", () => {
  clearUnderlyingIvMetricsState();
  const t0 = new Date(2026, 6, 21, 6, 44, 26).getTime();
  const good = XXI_2026_07_21[0].metrics;
  const corrupt = XXI_2026_07_21[1].metrics;

  assert.notEqual(screenIvMetricsReading("XXI-ANCHOR", good, t0), null);
  assert.equal(screenIvMetricsReading("XXI-ANCHOR", corrupt, t0 + 30 * MIN), null);

  // If the corrupt read had become the anchor, this next reading (rank 87.3,
  // IV 1.352 — DOWN in IV from the corrupt 1.625, UP 86 points in rank) would
  // itself be flagged as contradictory and the guard would lock onto bad data.
  assert.notEqual(
    screenIvMetricsReading("XXI-ANCHOR", XXI_2026_07_21[3].metrics, t0 + 93 * MIN),
    null,
  );
});

test("healthy production series pass the screen end to end (no false rejections)", () => {
  for (const series of HEALTHY_SERIES) {
    clearUnderlyingIvMetricsState();
    let t = new Date(2026, 6, 20, 7, 0, 0).getTime();
    for (const [i, reading] of series.readings.entries()) {
      const screened = screenIvMetricsReading(
        `HEALTHY-${series.name}`,
        { ...reading, rawIvRank: reading.ivRank / 100 },
        t,
      );
      assert.notEqual(screened, null, `${series.name} reading ${i} must be accepted`);
      t += 31 * MIN;
    }
  }
});

test("a stale anchor stops gating — a genuine regime change re-baselines", () => {
  clearUnderlyingIvMetricsState();
  const t0 = 1_700_000_000_000;
  const prior: UnderlyingIvMetrics = { ivRank: 90, rawIvRank: 0.9, impliedVolatility: 1.0 };
  const opposite: UnderlyingIvMetrics = { ivRank: 10, rawIvRank: 0.1, impliedVolatility: 2.0 };

  assert.notEqual(screenIvMetricsReading("STALE", prior, t0), null);
  // Inside the 2h anchor window: contradictory, rejected.
  assert.equal(screenIvMetricsReading("STALE", opposite, t0 + 119 * MIN), null);

  clearUnderlyingIvMetricsState();
  assert.notEqual(screenIvMetricsReading("STALE", prior, t0), null);
  // Past the 2h window: the anchor no longer has standing.
  assert.notEqual(screenIvMetricsReading("STALE", opposite, t0 + 121 * MIN), null);
});

test("the guard cannot bench a symbol forever — it yields after 3 rejections", () => {
  clearUnderlyingIvMetricsState();
  const t0 = 1_700_000_000_000;
  const prior: UnderlyingIvMetrics = { ivRank: 90, rawIvRank: 0.9, impliedVolatility: 1.0 };
  const opposite: UnderlyingIvMetrics = { ivRank: 10, rawIvRank: 0.1, impliedVolatility: 2.0 };

  assert.notEqual(screenIvMetricsReading("CAP", prior, t0), null);
  assert.equal(screenIvMetricsReading("CAP", opposite, t0 + 1 * MIN), null);
  assert.equal(screenIvMetricsReading("CAP", opposite, t0 + 2 * MIN), null);
  assert.equal(screenIvMetricsReading("CAP", opposite, t0 + 3 * MIN), null);
  // Fourth attempt: the anchor has spent its credibility, accept and re-baseline.
  assert.notEqual(screenIvMetricsReading("CAP", opposite, t0 + 4 * MIN), null);
});

// ── End-to-end through getUnderlyingIvMetrics ───────────────────────────────
// The guards above are only worth anything if getUnderlyingIvMetrics actually
// calls them. These drive the real production function (with the market-metrics
// fetch injected) so unwiring the screen is a test failure, not a silent no-op.

// Rebuilds the API's per-symbol payload from a reading. Field names are the
// wire names the live API uses (see the LIVE_MARA_ENTRY fixture in
// market-metrics.test.ts); rank goes back over the wire as a 0-1 decimal.
function marketMetricsPayload(symbol: string, metrics: UnderlyingIvMetrics): unknown {
  return [
    {
      symbol,
      "implied-volatility-index-rank": String(metrics.ivRank / 100),
      "implied-volatility-index":
        metrics.impliedVolatility == null ? null : String(metrics.impliedVolatility),
    },
  ];
}

test("getUnderlyingIvMetrics screens the XXI sequence end to end", async () => {
  clearUnderlyingIvMetricsState();
  const seen: UnderlyingIvMetrics[] = [];

  for (const reading of XXI_2026_07_21) {
    // Only the response cache is expired between readings — the anchors must
    // carry across, exactly as they do over a real session.
    clearUnderlyingIvMetricsCache();
    const result = await getUnderlyingIvMetrics("xxi", async (symbols) => {
      assert.equal(symbols, "XXI"); // uppercased, comma-separated string form
      return marketMetricsPayload("XXI", reading.metrics);
    });
    seen.push(result as UnderlyingIvMetrics);
  }

  assert.deepEqual(
    seen.map((m) => m !== null),
    [true, false, false, true, true, true, true, true, true, true, true, true],
  );
  // The accepted reads are the real numbers, not a clamped or substituted value.
  assertCloseTo(seen[0]?.ivRank, 35.4833948);
  assertCloseTo(seen[3]?.ivRank, 87.3210332);
});

test("getUnderlyingIvMetrics caches a rejection instead of re-fetching every tick", async () => {
  clearUnderlyingIvMetricsState();
  let fetches = 0;
  const fetcher = async (): Promise<unknown> => {
    fetches += 1;
    return marketMetricsPayload("XXI2", XXI_2026_07_21[fetches === 1 ? 0 : 1].metrics);
  };

  assert.notEqual(await getUnderlyingIvMetrics("XXI2", fetcher), null);
  clearUnderlyingIvMetricsCache();
  assert.equal(await getUnderlyingIvMetrics("XXI2", fetcher), null);
  // Third call is served from the cached rejection — no extra API round-trip.
  assert.equal(await getUnderlyingIvMetrics("XXI2", fetcher), null);
  assert.equal(fetches, 2);
});

test("getUnderlyingIvMetrics returns null for an out-of-range rank", async () => {
  clearUnderlyingIvMetricsState();
  const result = await getUnderlyingIvMetrics("BADRANGE", async () => [
    { symbol: "BADRANGE", "implied-volatility-index-rank": "-3", "implied-volatility-index": "0.5" },
  ]);
  assert.equal(result, null);
});

test("a rejection emits a greppable JSON line so the rate is measurable", () => {
  clearUnderlyingIvMetricsState();
  const lines: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(String(args[0]));
  };
  try {
    const t0 = 1_700_000_000_000;
    screenIvMetricsReading("LOGGED", XXI_2026_07_21[0].metrics, t0);
    screenIvMetricsReading("LOGGED", XXI_2026_07_21[1].metrics, t0 + 30 * MIN);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.scope, "market-metrics-iv-rank-rejected");
  assert.equal(entry.reason, "contradictory-iv-rank-transition");
  assert.equal(entry.symbol, "LOGGED");
  assert.equal(entry.ivRank, XXI_2026_07_21[1].metrics.ivRank);
  assert.equal(entry.anchorIvRank, XXI_2026_07_21[0].metrics.ivRank);
  assert.equal(entry.anchorAgeMs, 30 * MIN);
});
