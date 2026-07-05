export interface UnderlyingStabilization {
  sampleCount: number;
  rangePct: number; // (max − min) / mean of the series
  netChangePct: number; // (latest − first) / first
  latestVsRecentLowPct: number; // (latest − min) / min — how far bounced off the low
  // Heuristic "the tape isn't still making new lows" signal — log-only for now,
  // the raw stats are what matter for tuning the eventual gate (v5 strategy #6).
  isStabilizing: boolean;
}

// Descriptive stabilization stats for a recent underlying-price series (oldest →
// newest). Pure. Averaging down into a name still in free-fall is the failure
// mode this measures; a bounce off the recent low is the "stabilizing" tell.
export function computeUnderlyingStabilization(
  prices: number[],
): UnderlyingStabilization {
  const series = prices.filter((price) => Number.isFinite(price) && price > 0);
  if (series.length < 2) {
    return {
      sampleCount: series.length,
      rangePct: 0,
      netChangePct: 0,
      latestVsRecentLowPct: 0,
      isStabilizing: false,
    };
  }

  const min = Math.min(...series);
  const max = Math.max(...series);
  const mean = series.reduce((sum, price) => sum + price, 0) / series.length;
  const first = series[0];
  const latest = series[series.length - 1];

  const rangePct = mean > 0 ? (max - min) / mean : 0;
  const netChangePct = first > 0 ? (latest - first) / first : 0;
  const latestVsRecentLowPct = min > 0 ? (latest - min) / min : 0;

  return {
    sampleCount: series.length,
    rangePct,
    netChangePct,
    latestVsRecentLowPct,
    // ≥3 samples and the latest sits at least 0.5% above the recent low → the
    // underlying has bounced rather than printing a fresh low this window.
    isStabilizing: series.length >= 3 && latestVsRecentLowPct >= 0.005,
  };
}
