// Typed subset of the feed's internal Position model (interface shared by the
// feed team 2026-07-13; the wire payload derives from it and may add
// emit-time-computed fields, e.g. isInZScoreRange). Two tiers below:
//   READ — consumed by our gate/seed/sizing code today.
//   AVAILABLE — confirmed in the feed's model, typed for upcoming work
//   (signal-departure exits, options-mirror evaluation); not read yet.
// Everything else the feed sends flows through the index signature unread.
export interface SecretSourcePosition {
  // ── READ ──────────────────────────────────────────────────────────────────
  ticker?: string;
  buyWeight?: number;
  daytradeScore?: number; // drives basic/strong stock-yes tiers + aggressiveness boost
  isQualityToBuy?: boolean | string | number; // drives basic/strong stock-yes tiers
  returnPerc?: number;
  superRecScore?: number;
  percentOfBalance?: number; // drives basic/strong stock-yes tiers
  // Feed-consolidated thesis rollup (2026-07-12) — the score source.
  buyFraction?: number; // 0→1.25; exceeds 1.0 only when willBuy on top of all flags
  thesisCount?: number; // feed-side automated thesis flags passing
  thesisMax?: number; // feed-side flag count (currently 4)
  manualThesisCount?: number; // manually-curated thesis — the preferred score source
  manualThesisMax?: number; // always 10

  // ── AVAILABLE (not read yet) ──────────────────────────────────────────────
  // The automated thesis composition — these four ARE the thesisCount flags:
  isHighConviction?: boolean;
  isWordEdgePositive?: boolean;
  isGateMultFavorable?: boolean;
  isInBssRange?: boolean;
  // Buy state — upstream computes willBuy = isBuyEligible && …, always concrete:
  isBuyEligible?: boolean;
  willBuy?: boolean;
  // Departure/selling signals — the feed flattening a name is a real exit
  // signal for our cash overnight holds (see docs/secret-bot-options-mirror-proposal.md):
  isSelling?: boolean;
  currentAction?: "buying" | "selling";
  percToSell?: number;
  recommendation?: string;
  // Price/quality context:
  currentPrice?: number;
  avgEntry?: number;
  returnBidPerc?: number; // realizable (bid-side) return vs returnPerc's mid
  wideSpread?: boolean;
  bounceStabilizationScore?: number;
  minOld?: number; // minutes since the position was picked
  daysOld?: number;
  alpacaStatus?: number;

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
