import { SecretRegime, SecretSourcePosition } from "~/strategy/secret/types";
import {
  getCashAccountSeedEndMinute,
  getSecretAutoSeedWindowStartMinute,
} from "./seeding-windows";
import { readEnvPct, toBooleanFlag } from "~/core/env-utils";

export interface PositionGateSignals {
  crossAccountYes: boolean;
  basicStockYes: boolean;
  strongStockYes: boolean;
  goodBooleanScore: number;
  allBooleansGood: boolean;
  // Raw stock-yes proxy inputs — surfaced for logging so they can be validated against
  // forward return later (currently unvalidated conviction proxies; see the gate audit).
  // Optional: only computePositionGate populates them; test fixtures may omit them.
  qualityToBuy?: boolean;
  percentOfBalance?: number;
}

export interface PositionGateResult {
  signals: PositionGateSignals;
  maxTargetPct: number;
  // 1 = underlying based (or signal absent), <1 = falling-knife throttle. Always
  // computed for observability; only reduces maxTargetPct when the governor is on.
  governorMult: number;
  strongStockYesPctThreshold: number;
  basicStockYesPctThreshold: number;
}

// STRATEGY_CROSS_ACCOUNT_YES_DOWN_PCT is the late-day (lenient) threshold for the cross-account YES signal.
// At the seed-window start (SECRET_AUTO_SEED_START_TIME, default 6:30am): requires 2× that dip (strict).
// At window end (1pm): requires exactly the configured dip.
function getCrossAccountYesDownPct(currentTime: Date): number {
  const base = readEnvPct("STRATEGY_CROSS_ACCOUNT_YES_DOWN_PCT", 10);
  const minuteOfDay = currentTime.getHours() * 60 + currentTime.getMinutes();
  const startMinute = getSecretAutoSeedWindowStartMinute();
  const endMinute = getCashAccountSeedEndMinute();
  const duration = endMinute - startMinute;
  const t = duration > 0
    ? Math.max(0, Math.min(1, (minuteOfDay - startMinute) / duration))
    : 1;
  // t=0 (window start): 2× base (strict). t=1 (1pm): 1× base (lenient).
  return base * (2 - t);
}

// Reads the preferred env name, falling back to a legacy name so an
// un-migrated .env doesn't silently revert to defaults.
function readEnvPctWithLegacy(key: string, legacyKey: string, fallback: number): number {
  if (process.env[key]?.trim()) return readEnvPct(key, fallback);
  return readEnvPct(legacyKey, fallback);
}

// The stock-yes thresholds form a basic/strong pair. Both are time-scaled from
// half the base at window start to the full base at 1pm (percentOfBalance
// builds through the session), and the basic bar must sit below its strong
// counterpart.
//
// daytradeScore legs REMOVED 2026-07-19: a forward-return backtest (n=2242
// fills, intraday horizon) showed the score's relationship to forward return
// is a valley, not a line — dt -70..-150 is catastrophic (win rate 16-29%,
// avg -5 to -7%). The dt<-100 strong leg granted the strongest sizing tier
// INSIDE that death valley (win 16%). daytradeScore is telemetry-only now.

// percentOfBalance above this qualifies as a basic stock YES on its own.
function getBasicPercentOfBalanceThreshold(): number {
  return readEnvPct("STRATEGY_GATE_BASIC_PERCENT_OF_BALANCE_THRESHOLD", 25);
}

// percentOfBalance above this qualifies (with isQualityToBuy) as a strong stock YES.
function getStrongPercentOfBalanceThreshold(): number {
  return readEnvPctWithLegacy(
    "STRATEGY_GATE_STRONG_PERCENT_OF_BALANCE_THRESHOLD",
    "STRATEGY_GATE_STRONG_STOCK_YES_MAX_PCT",
    30,
  );
}

// Additional maxTargetPct added per "good" boolean signal (isAboveMinSin etc.)
function getBooleanBoostPct(): number {
  return readEnvPct("STRATEGY_GATE_BOOLEAN_BOOST_PCT", 0.03);
}

export function getSingleYesMaxTargetPct(): number {
  return readEnvPct("STRATEGY_GATE_SINGLE_YES_MAX_TARGET_PCT", 0.15);
}

export function getBasicYesMaxTargetPct(): number {
  return readEnvPct("STRATEGY_GATE_BASIC_YES_MAX_TARGET_PCT", 0.10);
}

// (b) 2026-07-24 — demote the unvalidated stock-yes proxies (isQualityToBuy / percentOfBalance).
// When on, a stock-yes tier NOT backed by validated thesis (feed full buyFraction>=1.0, or a
// real manual thesis >= GATE_PROXY_DEMOTE_THESIS_MIN) is capped at the basic ceiling — so the
// proxies can't grant a large target on their own. Can ONLY reduce a non-thesis target; never
// raises anything. Off by default. See docs/gl-gate-audit-alpha-vs-risk-2026-07-24.md.
const GATE_PROXY_DEMOTE_THESIS_MIN = 4;
function getGateProxyDemoteEnabled(): boolean {
  return toBooleanFlag(process.env.STRATEGY_GATE_PROXY_DEMOTE_ENABLED);
}

// ── Add-governor (2026-07-24) ────────────────────────────────────────────────
// A knife brake on the buy target, ported from Alpaca's add-governor. GL kept
// averaging option size into a falling-knife underlying (NEXT: -28% to -31% ×4)
// while the thesis rollup, which persists as the price craters, held the target
// high. The full mult (0.35–1.0, from the underlying's slope + plateau + afterFall)
// is computed ONCE on the Alpaca position and sent over the feed as governorMult —
// single source of truth. We read it and scale maxTargetPct: knife → throttle toward
// the floor; based → full target restored ("buy big at the base"). If the feed hasn't
// sent it (old feed / cold start), we fall back to a plateau-only ramp so GL degrades
// gracefully instead of breaking. Dark-launch: computed + logged always, bites the
// target only when STRATEGY_GOVERNOR_ENABLED is on.
const PLATEAU_GOVERNOR_MIN = 35; // ≤ this = full knife (matches the feed's own buy gate)
const PLATEAU_GOVERNOR_STABILIZED = 65; // ≥ this = fully based (matches the Alpaca governor)

function getGovernorEnabled(): boolean {
  return toBooleanFlag(process.env.STRATEGY_GOVERNOR_ENABLED);
}

function getPlateauGovernorKnifeFloor(): number {
  return readEnvPct("STRATEGY_PLATEAU_GOVERNOR_KNIFE_FLOOR", 0.4);
}

// Account-aware application of the knife mult. The mult itself (getGovernorMult) is
// the shared underlying signal; each account applies it with its own risk posture:
//   MARGIN — HARD: leverage + EOD liquidation can't ride a knife to recovery, so
//     block entirely below MARGIN_GOVERNOR_MIN (return 0), taper above it.
//   CASH   — SOFT: ITM + overnight hold CAN ride the knife to the next-day base, so
//     never block; floor the throttle at CASH_GOVERNOR_FLOOR (a probe, not zero).
// Returns a 0..1 factor to multiply the exposure target / seed size by. The ENABLED
// check is the caller's — this is pure account math.
export function getMarginGovernorMin(): number {
  return readEnvPct("STRATEGY_MARGIN_GOVERNOR_MIN", 0.6);
}

export function getCashGovernorFloor(): number {
  return readEnvPct("STRATEGY_CASH_GOVERNOR_FLOOR", 0.35);
}

export function governorFactorFor(
  governorMult: number,
  accountType: "margin" | "cash",
): number {
  if (accountType === "margin") {
    return governorMult >= getMarginGovernorMin() ? governorMult : 0;
  }
  return Math.max(governorMult, getCashGovernorFloor());
}

// governorFactorFor gated by the enable flag: returns 1 (no-op) when the governor
// is off, so callers stay branch-free. This is the form applied to live targets.
export function governorFactorForEnabled(
  governorMult: number,
  accountType: "margin" | "cash",
): number {
  return getGovernorEnabled() ? governorFactorFor(governorMult, accountType) : 1;
}

// The governor mult applied to the target: prefer the FULL mult the Alpaca side
// computed (slope + plateau + afterFall) and sent over the feed; fall back to a
// plateau-only ramp when it's absent. Always ≤ 1 (the governor only ever throttles).
export function getGovernorMult(position: SecretSourcePosition | undefined): number {
  const passed = Number(position?.governorMult);
  if (Number.isFinite(passed) && passed >= 0) return Math.min(passed, 1);
  return getPlateauGovernorMult(position);
}

// Fallback ramp when the feed omits governorMult: 1.0 when based OR plateau absent
// (never penalize on missing data), down to the knife floor at the knife line.
export function getPlateauGovernorMult(position: SecretSourcePosition | undefined): number {
  const plateau = Number(position?.plateauScore);
  if (!Number.isFinite(plateau)) return 1;
  const floor = getPlateauGovernorKnifeFloor();
  const span = Math.max(1, PLATEAU_GOVERNOR_STABILIZED - PLATEAU_GOVERNOR_MIN);
  const stabilization = Math.max(0, Math.min(1, (plateau - PLATEAU_GOVERNOR_MIN) / span));
  return floor + (1 - floor) * stabilization;
}

export function getBothYesMaxTargetPct(): number {
  return readEnvPct("STRATEGY_GATE_BOTH_YES_MAX_TARGET_PCT", 0.25);
}

export function getStrongYesMaxTargetPct(): number {
  return readEnvPct("STRATEGY_GATE_STRONG_YES_MAX_TARGET_PCT", 0.35);
}

export function getMarginTargetMultiplier(): number {
  return readEnvPct("STRATEGY_MARGIN_MAX_TARGET_MULTIPLIER", 1.33);
}

export function getCrossAccountThresholdMultiplier(): number {
  return readEnvPct("STRATEGY_MARGIN_CROSS_ACCOUNT_THRESHOLD_MULTIPLIER", 2);
}

// 0 at the gate window start → 1 at window end (1pm).
function getGateWindowProgress(currentTime: Date): number {
  const minuteOfDay = currentTime.getHours() * 60 + currentTime.getMinutes();
  const startMinute = getSecretAutoSeedWindowStartMinute();
  const endMinute = getCashAccountSeedEndMinute();
  const duration = endMinute - startMinute;

  return duration > 0
    ? Math.max(0, Math.min(1, (minuteOfDay - startMinute) / duration))
    : 1;
}

// percentOfBalance: base/2 at window start → base at window end. Basic and
// strong scale over the same window with the same shape — both tighten
// through the day because percentOfBalance builds through the session.
function getTimeScaledPctThreshold(basePct: number, currentTime: Date): number {
  const t = getGateWindowProgress(currentTime);
  return (basePct / 2) * (1 + t);
}

// The thesis scale is the feed's manually-curated thesis: manualThesisMax is
// always 10, so scores run 0–10 with the willBuy icing (+2) on top. Every
// downstream bar (dip boost ≥4, seed multiplier 3/5/7, deep-loss ≥6, boost
// ×0.03/pt, surplus cap at full) and log denominator is tuned to this scale.
// The pre-2026-07-13 legacy per-flag counting (THESIS_FLAGS) is gone — the
// feed sends its rollup on every position.
export const THESIS_MAX = 10;

// The feed's consolidated thesis rollup: 0→1.0 spans its thesis flags, and only
// willBuy pushes it above 1.0 (to 1.25) — the icing signal.
const BUY_FRACTION_ICING_MAX = 1.25;

function getFeedBuyFraction(position: SecretSourcePosition | undefined): number | null {
  const raw = Number(position?.buyFraction);
  if (!Number.isFinite(raw) || raw < 0) return null;
  return Math.min(raw, BUY_FRACTION_ICING_MAX);
}

// The feed's manually-curated thesis — the preferred score source (richer
// granularity than the 4-flag buyFraction). manualThesisMax is always 10 =
// THESIS_MAX, so this is the raw count; the ratio form guards against the
// feed ever changing its max.
function getManualThesisScore(position: SecretSourcePosition): number | null {
  // NaN (missing/garbage fields), Infinity (max 0), and negatives all fail the
  // finite-and-non-negative check in one expression.
  const fractionOfMax = Number(position.manualThesisCount) / Number(position.manualThesisMax);
  if (!Number.isFinite(fractionOfMax) || fractionOfMax < 0) {
    return null;
  }
  return Math.round(Math.min(fractionOfMax, 1) * THESIS_MAX);
}

// The gate score, 0–THESIS_MAX(+2). Sources in preference order:
//   1. Manual thesis (manualThesisCount/manualThesisMax) — the richer,
//      manually-curated 0–10 score.
//   2. buyFraction alone — the coarse 4-flag rollup, spread across the scale.
// willBuy icing (+2) comes from buyFraction > 1 on both paths — the feed only
// pushes past 1.0 when willBuy is true, and it computes willBuy false during
// its own liquidation windows (isBuyEligible), so buy-intent noise is already
// handled upstream. No rollup at all = no thesis = 0: unknown scores nothing.
export function countGoodBooleans(position: SecretSourcePosition | undefined): number {
  if (!position) return 0;

  const feedFraction = getFeedBuyFraction(position);
  const feedIcing = feedFraction !== null && feedFraction > 1 ? 2 : 0;

  const manualThesisScore = getManualThesisScore(position);
  if (manualThesisScore !== null) {
    return manualThesisScore + feedIcing;
  }

  if (feedFraction !== null) {
    return Math.round(Math.min(feedFraction, 1) * THESIS_MAX) + feedIcing;
  }

  return 0;
}

// "Everything passing" on the FEED's automated rollup: thesisCount >= thesisMax
// (thesisMax is in the payload for exactly this; today that's 4/4, and the bar
// tracks the feed if it grows its flag set). Missing/invalid rollup = false —
// unknown thesis is not conviction.
//
// NOTE (2026-08-08): this is no longer a *block* on the feed-driven margin
// auto-seed — that gate measured backwards and was removed (see
// evaluateMarginSeedThesisGate in ~/strategy/secret/secret-auto-seed). Two live
// consumers remain, and neither hard-blocks on it alone: getSeedDecision uses
// it as the FULL-thesis leg of an OR (`fullFeedThesis || manualScore >= bar`),
// and the auto-seed path records it into the sticky day memory that now only
// classifies the new relief/pass log lines.
export function shouldSeedMarginFromBooleans(
  position: SecretSourcePosition | undefined,
): boolean {
  // NaN (missing fields) and Infinity (max 0) both fail the finite check.
  const ratio = Number(position?.thesisCount) / Number(position?.thesisMax);
  return Number.isFinite(ratio) && ratio >= 1;
}

// Per-action buy exposure surplus added on top of the account-type base for both
// accounts. Linear instead of a step ladder — one formula, no stale tiers; caps
// at 0.30 once the thesis scale is full (willBuy icing can't push it further).
export function getBooleanSurplusPct(goodBooleanScore: number): number {
  return Math.round(Math.min(goodBooleanScore / THESIS_MAX, 1) * 0.30 * 100) / 100;
}

function isQualityToBuy(position: SecretSourcePosition | undefined): boolean {
  return position != null && toBooleanFlag(position.isQualityToBuy);
}

// ── Regime posture multiplier (wired 2026-07-19) ────────────────────────────
// The feed's envelope-level market-posture multipliers, combined into one
// factor for the MARGIN account (the account that rides the feed's buy signal
// intraday). The feed is the single source of truth — we obey, not re-derive.
// Backdrop: market-return is the feed's dominant deploy signal (down days
// +1.46% forward vs -0.33% on up-big days).
//
// Out-of-contract values (negative, NaN, Infinity) are treated as ABSENT
// (factor 1) rather than clamped, so a feed glitch can't silently zero or
// crush the margin book.

// Lean-in band for dipBuyDeployMult. The >1 side is capped (default 1.5)
// because on the days the lean-in fires, IV is elevated — options pay more
// for the same signal, so the stock-side lean is attenuated, not compounded.
function getRegimeDipMultMin(): number {
  return readEnvPct("STRATEGY_REGIME_DIP_MULT_MIN", 0.5);
}

function getRegimeDipMultMax(): number {
  return readEnvPct("STRATEGY_REGIME_DIP_MULT_MAX", 1.5);
}

// Combined market-posture factor for margin sizing:
//   clampedThrottle — regimeMarginMult clamped to [0, 1] (down-only by contract)
//   clampedLean     — dipBuyDeployMult clamped to the env-tunable band above
// Kill switch STRATEGY_REGIME_POSTURE_MULT_DISABLED (truthy → always 1).
export function getRegimePostureMult(regime: SecretRegime | null | undefined): number {
  if (toBooleanFlag(process.env.STRATEGY_REGIME_POSTURE_MULT_DISABLED)) {
    return 1;
  }

  const throttleRaw = regime?.regimeMarginMult;
  const clampedThrottle =
    typeof throttleRaw === "number" && Number.isFinite(throttleRaw) && throttleRaw >= 0
      ? Math.min(throttleRaw, 1)
      : 1;

  const leanRaw = regime?.dipBuyDeployMult;
  const clampedLean =
    typeof leanRaw === "number" && Number.isFinite(leanRaw) && leanRaw >= 0
      ? Math.min(Math.max(leanRaw, getRegimeDipMultMin()), getRegimeDipMultMax())
      : 1;

  return clampedThrottle * clampedLean;
}

// fallow-ignore-next-line complexity
export function computePositionGate(options: {
  crossAccountAskReturnFraction: number | null;
  secretPosition: SecretSourcePosition | undefined;
  currentTime: Date;
  crossAccountThresholdMultiplier?: number;
}): PositionGateResult {
  const multiplier = options.crossAccountThresholdMultiplier ?? 1;
  const crossAccountYesThreshold = (getCrossAccountYesDownPct(options.currentTime) / 100) * multiplier;
  const crossAccountYes =
    options.crossAccountAskReturnFraction !== null &&
    options.crossAccountAskReturnFraction < -crossAccountYesThreshold;

  const qualityToBuy = isQualityToBuy(options.secretPosition);
  const percentOfBalance = Number(options.secretPosition?.percentOfBalance ?? 0);

  const strongPctThreshold = getTimeScaledPctThreshold(
    getStrongPercentOfBalanceThreshold(),
    options.currentTime,
  );

  const goodBooleanScore = countGoodBooleans(options.secretPosition);
  // Full thesis = buyFraction >= 1.0 (only willBuy can push past it). No
  // rollup = false.
  const gateFeedFraction = getFeedBuyFraction(options.secretPosition);
  const allBooleansGood = gateFeedFraction !== null && gateFeedFraction >= 1.0;

  // daytradeScore legs removed 2026-07-19: dip polarity ("bullish" = down
  // hard) GRANTED tiers inside the backtested -70..-150 death valley — the
  // dt<-100 strong leg awarded the strongest tier at a 16% win rate.

  // basic: isQualityToBuy, or percentOfBalance above the time-scaled threshold
  const basicPctThreshold = getTimeScaledPctThreshold(
    getBasicPercentOfBalanceThreshold(),
    options.currentTime,
  );
  const basicStockYes = qualityToBuy || percentOfBalance > basicPctThreshold;

  // strong: isQualityToBuy + percentOfBalance above the time-scaled threshold
  const strongStockYes = qualityToBuy && percentOfBalance > strongPctThreshold;

  const signals: PositionGateSignals = {
    crossAccountYes,
    basicStockYes,
    strongStockYes,
    goodBooleanScore,
    allBooleansGood,
    qualityToBuy,
    percentOfBalance,
  };

  let maxTargetPct = 0;
  if (crossAccountYes && strongStockYes) {
    maxTargetPct = getStrongYesMaxTargetPct();
  } else if (crossAccountYes && basicStockYes) {
    maxTargetPct = getBothYesMaxTargetPct();
  } else if (strongStockYes) {
    maxTargetPct = getSingleYesMaxTargetPct();
  } else if (crossAccountYes) {
    maxTargetPct = getSingleYesMaxTargetPct();
  } else if (basicStockYes) {
    maxTargetPct = getBasicYesMaxTargetPct();
  }

  // (b) 2026-07-24 — demote the unvalidated stock-yes proxies: a tier not backed by
  // validated thesis (feed full buyFraction>=1.0, or manual thesis >= the bar) is capped
  // at the basic ceiling, so isQualityToBuy / percentOfBalance can't grant a large target
  // on their own. Thesis-backed names are untouched; this only ever reduces. Off by default.
  const thesisBacked =
    allBooleansGood || goodBooleanScore >= GATE_PROXY_DEMOTE_THESIS_MIN;
  if (getGateProxyDemoteEnabled() && !thesisBacked) {
    maxTargetPct = Math.min(maxTargetPct, getBasicYesMaxTargetPct());
  }

  // Each good boolean adds a fixed boost on top of the signal tier
  maxTargetPct = Math.min(maxTargetPct + goodBooleanScore * getBooleanBoostPct(), 1.0);

  // Add-governor (2026-07-24): surface the shared knife mult (full mult from the
  // Alpaca position, plateau-only fallback). NOT applied here — this gate is shared
  // by both accounts, and the governor is account-aware (margin hard / cash soft), so
  // it's applied downstream per account (run-cycle-context allocation, seed paths)
  // via governorFactorFor. maxTargetPct stays raw. See getGovernorMult.
  const governorMult = getGovernorMult(options.secretPosition);

  return {
    signals,
    maxTargetPct,
    governorMult,
    strongStockYesPctThreshold: strongPctThreshold,
    basicStockYesPctThreshold: basicPctThreshold,
  };
}
