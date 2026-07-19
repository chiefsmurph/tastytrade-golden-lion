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
  // Intraday PAIN score (negative = down hard). TELEMETRY-ONLY: removed from
  // every decision path 2026-07-19 after a forward-return backtest (n=2242)
  // showed a valley, not a line — dt -70..-150 is catastrophic (win 16-29%),
  // dt <= -200 has a fat left tail, and only dt > 40 is positive-avg. Still
  // recorded (run history, gate logs, SecretPositionSignals) for re-evaluation.
  daytradeScore?: number;
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
  // Upstream computes willBuy = isBuyEligible && …, always concrete. Read by
  // the sticky margin trigger (full thesis observed today + willBuy now) and
  // the margin willBuy hard gate.
  willBuy?: boolean;

  // ── AVAILABLE (not read yet) ──────────────────────────────────────────────
  // The automated thesis composition — these four ARE the thesisCount flags:
  isHighConviction?: boolean;
  isWordEdgePositive?: boolean;
  isGateMultFavorable?: boolean;
  isInBssRange?: boolean;
  // Buy state (willBuy itself is READ above):
  isBuyEligible?: boolean;
  observedAboveMinToday?: boolean; // buyWeight cleared today's benchmark at some point today — sticky
  isClearedToBuy?: boolean; // willBuy || observedAboveMinToday
  shouldNotify?: boolean; // feed's conviction-alert boolean
  // NOTE: the feed's selling/departure signals (isSelling, currentAction,
  // percToSell) are deliberately NOT consumed. Our selling is feed-independent
  // by design — stops, take-profit, EOD, and overnight age-reduction own it.
  // The feed drives buying only.
  // Hold signal — cash account gate (wired 2026-07-13; use for cash per-account gate):
  holdScore?: number; // 0–1.3 overnight conviction; cash hard gate ≥ 0.45
  holdTier?: number; // 1–4 projected EOD tier
  isOvernightEligible?: boolean; // price≥5.35 & liquid & marginable
  // Buy signal extras — margin account sizing (wired 2026-07-13):
  buyMult?: number; // base rec strength, pre-concentration crush; reliably emitted top-level as of the feed's matching branch
  gateMult?: number; // gate favorability (full = 2.0)
  failsDayHighGate?: boolean; // true = blocked by extended-pump guard
  plateauScore?: number; // 0-100 "how flat", entry-quality; feed gates its own buys at >= 35
  // Scan-computed — strike anchors + entry quality (wired 2026-07-13, OBSERVE-ONLY):
  trueLow?: number; // liquid-bar intraday low — ITM strike floor
  trueHigh?: number; // liquid-bar intraday high — OTM strike cap
  rangePos?: number; // 0=at low, 100=at high (unvalidated — tiebreaker weight only)
  tsc?: number; // % vs prev close
  highToBid?: number; // % from intraday high to current bid
  fiveMinuteRSI?: number; // momo overbought guard
  // Price/quality context:
  currentPrice?: number;
  avgEntry?: number;
  returnBidPerc?: number; // realizable (bid-side) return vs returnPerc's mid
  bidDaytradeScore?: number; // bid-side conservative daytradeScore
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

// Top-level regime context added 2026-07-13 — one per server:data-update tick, NOT per-position.
export interface SecretRegime {
  min?: number; // minutes from 9:30am ET open (0=open, 390=close)
  scannedTotalZ?: number; // market-down breadth z-score (restart-persisted)
  crashRegime?: boolean; // sustained-decline guard
  currentMinBuyWeight?: number; // live buy-gate threshold
  buyPressure?: number; // feed's book-level deployment pressure
  marketReturnPerc?: number; // market return vs prev close, negative = down
}

export interface SecretDataUpdatePayload {
  positions?: {
    [key: string]: SecretSourcePosition[] | unknown;
  };
  tickerRecs?: SecretTickerRecsUpdate | unknown;
  regime?: SecretRegime; // wired 2026-07-13
  [key: string]: unknown;
}
