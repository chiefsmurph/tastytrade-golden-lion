import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getUnderlyingIvMetricsForIpc,
  parseUnderlyingIvMetricsEntry,
} from "~/core/market-metrics";

// Captured live 2026-07-03 via src/tools/probe-iv-rank.ts — do not hand-edit.
const LIVE_MARA_ENTRY = {
  symbol: "MARA",
  "implied-volatility-index-rank": "0.355173693",
  "tw-implied-volatility-index-rank": "0.296121178",
  "tos-implied-volatility-index-rank": "0.355173693",
  "implied-volatility-percentile": "0.289372758",
  "implied-volatility-index": "0.90302945",
};

test("live market-metrics entry: 0-1 rank string scales to 0-100", () => {
  const metrics = parseUnderlyingIvMetricsEntry(LIVE_MARA_ENTRY);
  assert.ok(metrics);
  assert.ok(Math.abs(metrics.ivRank - 35.5173693) < 1e-9);
  assert.ok(Math.abs((metrics.impliedVolatility ?? 0) - 0.90302945) < 1e-9);
});

test("a rank already on the 0-100 scale passes through unchanged", () => {
  const metrics = parseUnderlyingIvMetricsEntry({
    "implied-volatility-index-rank": "35.5",
  });
  assert.equal(metrics?.ivRank, 35.5);
});

test("rank of exactly 1 is treated as 0-1 scale (100)", () => {
  const metrics = parseUnderlyingIvMetricsEntry({
    "implied-volatility-index-rank": 1,
  });
  assert.equal(metrics?.ivRank, 100);
});

test("missing, non-numeric, or absent entries yield null", () => {
  assert.equal(parseUnderlyingIvMetricsEntry({}), null);
  assert.equal(
    parseUnderlyingIvMetricsEntry({ "implied-volatility-index-rank": "n/a" }),
    null,
  );
  assert.equal(parseUnderlyingIvMetricsEntry(null), null);
  assert.equal(parseUnderlyingIvMetricsEntry(undefined), null);
});

test("missing implied-volatility-index still returns rank with null IV", () => {
  const metrics = parseUnderlyingIvMetricsEntry({
    "implied-volatility-index-rank": "0.5",
  });
  assert.equal(metrics?.ivRank, 50);
  assert.equal(metrics?.impliedVolatility, null);
});

// strategy:getUnderlyingIvMetrics IPC boundary — the feed depends on a clean
// null for any unavailable case; an error must never cross the socket.

test("IPC wrapper: trims and uppercases the symbol before lookup", async () => {
  const seenSymbols: string[] = [];
  const metrics = await getUnderlyingIvMetricsForIpc("  mara ", async (symbol) => {
    seenSymbols.push(symbol);
    return { ivRank: 35.5, impliedVolatility: 0.9 };
  });

  assert.deepEqual(seenSymbols, ["MARA"]);
  assert.equal(metrics?.ivRank, 35.5);
});

test("IPC wrapper: missing or blank symbol yields null without calling the fetcher", async () => {
  const fetchMetrics = async (): Promise<null> => {
    throw new Error("fetcher must not be called for an empty symbol");
  };

  assert.equal(await getUnderlyingIvMetricsForIpc(undefined, fetchMetrics), null);
  assert.equal(await getUnderlyingIvMetricsForIpc("", fetchMetrics), null);
  assert.equal(await getUnderlyingIvMetricsForIpc("   ", fetchMetrics), null);
});

test("IPC wrapper: a throwing lookup resolves to null instead of propagating", async () => {
  const metrics = await getUnderlyingIvMetricsForIpc("MARA", async () => {
    throw new Error("market-metrics API unavailable");
  });

  assert.equal(metrics, null);
});

test("IPC wrapper: null and undefined lookup results normalize to null", async () => {
  assert.equal(await getUnderlyingIvMetricsForIpc("MARA", async () => null), null);
  assert.equal(
    await getUnderlyingIvMetricsForIpc(
      "MARA",
      (async () => undefined) as unknown as () => Promise<null>,
    ),
    null,
  );
});
