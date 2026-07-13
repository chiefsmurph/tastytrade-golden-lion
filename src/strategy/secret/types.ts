// Only the fields the bot reads are typed. The feed sends more (per-flag
// booleans, willBuy, isGateMultFavorable, …) — those flow through the index
// signature and are deliberately unread: since 2026-07-13 the thesis rollup
// below is the sole score source.
export interface SecretSourcePosition {
  ticker?: string;
  buyWeight?: number;
  daytradeScore?: number; // drives basic/strong stock-yes tiers + aggressiveness boost
  isQualityToBuy?: boolean | string | number; // drives basic/strong stock-yes tiers
  returnPerc?: number;
  superRecScore?: number;
  percentOfBalance?: number; // drives basic/strong stock-yes tiers
  // Feed-consolidated thesis rollup (2026-07-12) — the score source.
  buyFraction?: number; // 0→1.25; exceeds 1.0 only when willBuy on top of all flags
  thesisCount?: number; // feed-side thesis flags passing
  thesisMax?: number; // feed-side flag count (currently 4)
  manualThesisCount?: number; // manually-curated thesis — the preferred score source
  manualThesisMax?: number; // always 10
  [key: string]: unknown;
}

export interface SecretTickerRecPick {
  ticker?: string;
  shouldBuy?: boolean | string | number;
  [key: string]: unknown;
}

export interface SecretTickerRecsUpdate {
  picks?: SecretTickerRecPick[] | unknown;
  [key: string]: unknown;
}

export interface SecretDataUpdatePayload {
  positions?: {
    [key: string]: SecretSourcePosition[] | unknown;
  };
  tickerRecs?: SecretTickerRecsUpdate | unknown;
  [key: string]: unknown;
}
