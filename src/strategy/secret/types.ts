export interface SecretSourcePosition {
  ticker?: string;
  buyWeight?: number;
  daytradeScore?: number;
  isBuyEligible?: boolean | string | number;
  isQualityToBuy?: boolean | string | number;
  returnPerc?: number;
  superRecScore?: number;
  distanceToAsk?: number;
  percentOfBalance?: number;
  isAboveMinSin?: boolean | string | number;
  isAboveMinSis?: boolean | string | number;
  isAboveMinStab?: boolean | string | number;
  isInBssRange?: boolean | string | number;
  isAboveMinPsWordPerc?: boolean | string | number;
  isInZScoreRange?: boolean | string | number;
  // Feed-consolidated thesis (2026-07-12): the feed computes its own thesis and
  // exposes the rollup on every position. When present these supersede the
  // individual legacy flags above (still emitted during the transition).
  buyFraction?: number; // 0→1.25; exceeds 1.0 only when willBuy on top of all flags
  thesisCount?: number; // feed-side thesis flags passing
  thesisMax?: number; // feed-side flag count (currently 4)
  manualThesisCount?: number; // second, manually-curated thesis — flags passing; preferred score source
  manualThesisMax?: number; // always 10
  isGateMultFavorable?: boolean | string | number; // collapses isAboveMinSis/Sin/Stab
  isHighConviction?: boolean | string | number; // supersedes isAboveMinBuyWeight (stricter)
  isClearedToBuy?: boolean | string | number;
  isAboveMinBuyWeight?: boolean | string | number;
  willBuy?: boolean | string | number;
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
