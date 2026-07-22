// Option-liquidity-quality score + exit-aware concentration caps
// (IMPROVEMENTS liquidity-aware sizing). A 99-name scan of Alpaca's universe
// found roughly three tiers:
//   - ~44% carry LIQUID WEEKLIES in the 14-30 DTE window (e.g. SG): tight
//     spreads, standing OI, and a fresh expiration every ~7 days so an exit is
//     always a step away. These are the SG-like names we WANT to press.
//   - ~35% are MONTHLY-ONLY (first expiration ~31+ DTE, e.g. XXI): often thin
//     and wide-spread. A big bet here is hard to exit fast; size DOWN.
//   - ~20% carry NO chain at all (handled upstream by NO_OPTION_CHAIN_SKIP).
//
// This module turns those observations into two numbers per candidate:
//   1. optionLiquidityQuality (0..1): higher = SG-like liquid, lower = thin
//      monthly. EXPORTED so the sizing model (separate PR) can consume it as
//      its `optionLiquidityQuality` input.
//   2. exit-aware concentration caps: a per-underlying %-of-account ceiling
//      that scales DOWN with lower quality (a big bet in a thin chain is capped
//      by how fast you could exit), plus a combined cash+margin exposure cap so
//      the two accounts can't quietly stack into one oversized single-name bet.
//
// The caps only REDUCE risk, so they are enforceable, not shadow-only.
//
// Conventions: module vars + exported fns, small surface, env-overridable
// STRATEGY_-prefixed constants that resolve to a safe (behavior-neutral or
// conservative) default when unset/blank/invalid.
import { readEnvFraction, readEnvPct } from "~/core/env-utils";
import { TastytradeExpiration } from "~/core/types";

// ---------------------------------------------------------------------------
// Windows / thresholds (see the scan tiers above).
// ---------------------------------------------------------------------------

// The "liquid weeklies" window: an in-window expiration this close to the
// preferred 14-DTE target is what distinguishes SG (weeklies at 3/10/17/24)
// from a monthly-only name whose nearest expiration is ~31 DTE.
const WEEKLY_WINDOW_MIN_DTE = 14;
const WEEKLY_WINDOW_MAX_DTE = 30;

// A name whose FIRST (nearest) expiration is at/after this DTE is treated as
// monthly-only: there is no near-dated exit ladder, so exits are coarse.
const MONTHLY_ONLY_FIRST_DTE = 31;

// Spread reference points for the spread sub-score. A spread at/below the
// "tight" point scores full marks; at/above the "wide" point it scores zero;
// linear in between. These are score-shaping constants, NOT a gate (the entry
// liquidity gate in ~/strategy/liquidity-gate owns pass/fail).
const SPREAD_TIGHT_PCT = 0.05; // 5% of mid — SG-like
const SPREAD_WIDE_PCT = 0.3; // 30% of mid — the shared entry ceiling

// Open-interest reference points for the OI sub-score. Standing depth below
// the low point scores zero; at/above the high point scores full marks.
const OI_LOW = 50;
const OI_HIGH = 1000;

// Sub-score weights (sum to 1). Weeklies-vs-monthly is the dominant signal
// from the scan (it is the structural exit-ladder property), spread next, OI
// last (OI is frequently unknown from the feed and degrades gracefully).
const WEIGHT_WEEKLIES = 0.5;
const WEIGHT_SPREAD = 0.3;
const WEIGHT_OI = 0.2;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Linear ramp: 1 at/below `best`, 0 at/above `worst`, linear between. */
function rampDown(value: number, best: number, worst: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= best) return 1;
  if (value >= worst) return 0;
  return (worst - value) / (worst - best);
}

/** Linear ramp: 0 at/below `low`, 1 at/above `high`, linear between. */
function rampUp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= low) return 0;
  if (value >= high) return 1;
  return (value - low) / (high - low);
}

function toFiniteDte(exp: TastytradeExpiration): number {
  const dte = Number(exp["days-to-expiration"]);
  return Number.isFinite(dte) ? dte : Number.POSITIVE_INFINITY;
}

// ---------------------------------------------------------------------------
// Chain-structure classification (weeklies-in-window vs monthly-only).
// ---------------------------------------------------------------------------

export interface ChainStructureSummary {
  /** Whether any expiration falls in the 14-30 DTE weekly window. */
  hasWeekliesInWindow: boolean;
  /** DTE of the nearest expiration (Infinity when the chain is empty). */
  firstExpirationDte: number;
  /** No near-dated ladder: nearest expiration is at/after the monthly cutoff. */
  monthlyOnly: boolean;
  /** Count of expirations inside the weekly window (exit-ladder depth). */
  weeklyWindowCount: number;
}

/**
 * Classify a chain's expiration structure. `expirations` is the chain's full
 * expiration list (any shape carrying `days-to-expiration`); order does not
 * matter. An empty/absent list resolves to the worst case (no ladder), which
 * upstream no-chain handling should have already skipped.
 */
export function summarizeChainStructure(
  expirations: readonly TastytradeExpiration[] | undefined,
): ChainStructureSummary {
  const dtes = (expirations ?? [])
    .map(toFiniteDte)
    .filter((dte) => Number.isFinite(dte));

  const weeklyWindowCount = dtes.filter(
    (dte) => dte >= WEEKLY_WINDOW_MIN_DTE && dte <= WEEKLY_WINDOW_MAX_DTE,
  ).length;
  const firstExpirationDte = dtes.length ? Math.min(...dtes) : Number.POSITIVE_INFINITY;

  return {
    hasWeekliesInWindow: weeklyWindowCount > 0,
    firstExpirationDte,
    monthlyOnly: firstExpirationDte >= MONTHLY_ONLY_FIRST_DTE,
    weeklyWindowCount,
  };
}

// ---------------------------------------------------------------------------
// optionLiquidityQuality score (0..1).
// ---------------------------------------------------------------------------

export interface OptionLiquidityQualityInput {
  /** The candidate underlying's full expiration list. */
  expirations?: readonly TastytradeExpiration[];
  /** Pre-computed structure summary (overrides `expirations` when supplied). */
  chainStructure?: ChainStructureSummary;
  /** Entry spread as a fraction of mid (the chosen candidate's spreadPct). */
  spreadPct?: number | null;
  /** Requested-side open interest (standing depth). Unknown degrades softly. */
  openInterest?: number | null;
}

export interface OptionLiquidityQualityResult {
  /** 0..1: higher = SG-like liquid weekly, lower = thin monthly. */
  score: number;
  weekliesSubScore: number;
  spreadSubScore: number;
  oiSubScore: number;
  chainStructure: ChainStructureSummary;
  /** Sub-inputs that were unknown and defaulted (transparency, not a gate). */
  missingFields: string[];
}

/**
 * Compute the option-liquidity-quality score for a candidate. Blends three
 * sub-scores:
 *   - weeklies: full marks when the chain carries in-window weeklies (SG),
 *     zero when monthly-only (nearest exp >= 31 DTE), partial in between.
 *   - spread: ramps from 1 at a tight (<=5%) spread to 0 at a wide (>=30%) one.
 *   - OI: ramps from 0 below 50 to 1 at/above 1000.
 *
 * Unknown spread / OI default to a NEUTRAL sub-score (not zero) so a missing
 * feed field can't collapse an otherwise-liquid weekly name to "thin" — the
 * same graceful-degradation rule the entry liquidity gate follows.
 */
export function computeOptionLiquidityQuality(
  input: OptionLiquidityQualityInput,
): OptionLiquidityQualityResult {
  const chainStructure =
    input.chainStructure ?? summarizeChainStructure(input.expirations);
  const missingFields: string[] = [];

  // Weeklies sub-score is structural and always known once we have a chain.
  // Full marks for in-window weeklies, zero for monthly-only, and a partial
  // credit for chains that have neither (near-dated non-weekly ladder).
  let weekliesSubScore: number;
  if (chainStructure.hasWeekliesInWindow) {
    weekliesSubScore = 1;
  } else if (chainStructure.monthlyOnly) {
    weekliesSubScore = 0;
  } else {
    weekliesSubScore = 0.5;
  }

  const spreadPct =
    input.spreadPct != null && Number.isFinite(input.spreadPct) ? input.spreadPct : null;
  let spreadSubScore: number;
  if (spreadPct == null) {
    missingFields.push("spreadPct");
    spreadSubScore = 0.5; // neutral when unknown
  } else {
    spreadSubScore = rampDown(spreadPct, SPREAD_TIGHT_PCT, SPREAD_WIDE_PCT);
  }

  const openInterest =
    input.openInterest != null && Number.isFinite(input.openInterest)
      ? input.openInterest
      : null;
  let oiSubScore: number;
  if (openInterest == null) {
    missingFields.push("openInterest");
    oiSubScore = 0.5; // neutral when unknown
  } else {
    oiSubScore = rampUp(openInterest, OI_LOW, OI_HIGH);
  }

  const score = clamp01(
    WEIGHT_WEEKLIES * weekliesSubScore +
      WEIGHT_SPREAD * spreadSubScore +
      WEIGHT_OI * oiSubScore,
  );

  return {
    score,
    weekliesSubScore,
    spreadSubScore,
    oiSubScore,
    chainStructure,
    missingFields,
  };
}

// ---------------------------------------------------------------------------
// Exit-aware concentration caps (enforceable — they only REDUCE risk).
// ---------------------------------------------------------------------------

/**
 * Per-underlying max %-of-account for a TOP-quality (score == 1) name. This is
 * the ceiling a fully liquid SG-like name may reach in a single account; lower
 * quality scales DOWN from here (see getPerUnderlyingCapPctForQuality). Off
 * (Infinity) when unset/blank/zero/invalid, so deploying is behavior-neutral
 * until opted in.
 */
export function getMaxUnderlyingAccountPct(): number {
  // readEnvFraction accepts `60` (percent) or `0.60` (fraction) → 0.60.
  const parsed = readEnvFraction("STRATEGY_MAX_UNDERLYING_ACCOUNT_PCT", 0);
  return parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * Floor multiplier applied to the per-underlying cap at the WORST quality
 * (score == 0). At 0.4 a thin monthly name may reach only 40% of what a fully
 * liquid name may — the "how fast could you exit" haircut. The multiplier
 * ramps linearly with quality from this floor (score 0) to 1 (score 1).
 * Clamped to [0, 1]; an unset/invalid value resolves to the default.
 */
export function getMinLiquidityCapMultiplier(): number {
  // A raw multiplier (0..1), NOT a percent-of-account — a value like `2` means
  // "clamp to 1", so it must be read raw and NOT normalized as a percent.
  const parsed = readEnvPct("STRATEGY_MIN_LIQUIDITY_CAP_MULTIPLIER", 0.4);
  if (!Number.isFinite(parsed) || parsed < 0) return 0.4;
  return Math.min(1, parsed);
}

/**
 * Combined cash+margin max %-of-account per underlying (measured against the
 * shared account-size basis the caller passes). Prevents the two accounts from
 * each seeding the same name until it quietly becomes one oversized single-name
 * bet. Off (Infinity) when unset/blank/zero/invalid.
 */
export function getCombinedUnderlyingCapPct(): number {
  // readEnvFraction accepts `70` (percent) or `0.70` (fraction) → 0.70.
  const parsed = readEnvFraction("STRATEGY_COMBINED_UNDERLYING_CAP_PCT", 0);
  return parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * The per-underlying %-of-account cap for a given liquidity quality. Scales the
 * top-quality ceiling DOWN by a quality-driven multiplier that ramps from
 * getMinLiquidityCapMultiplier() at score 0 to 1 at score 1. When the base cap
 * is off (Infinity) this returns Infinity regardless of quality.
 */
export function getPerUnderlyingCapPctForQuality(quality: number): number {
  const baseCapPct = getMaxUnderlyingAccountPct();
  if (!Number.isFinite(baseCapPct)) return Number.POSITIVE_INFINITY;

  const q = clamp01(quality);
  const minMult = getMinLiquidityCapMultiplier();
  const multiplier = minMult + (1 - minMult) * q;
  return baseCapPct * multiplier;
}

export interface ConcentrationCapInput {
  /** optionLiquidityQuality (0..1) for the candidate/underlying. */
  quality: number;
  /** Total account-size basis (dollars) the %-caps are measured against. */
  accountBasis: number;
  /** Current market value of this underlying already held in THIS account. */
  existingAccountExposure: number;
  /**
   * Current market value of this underlying held ACROSS both accounts
   * (cash + margin). Used by the combined cap. Should be >= existingAccountExposure.
   */
  existingCombinedExposure: number;
}

export interface ConcentrationCapResult {
  /** Dollars of new exposure this account may add for this underlying. */
  allowedAdditionalExposure: number;
  /** The per-underlying account cap in dollars after the quality haircut. */
  perUnderlyingCapDollars: number;
  /** The combined cross-account cap in dollars. */
  combinedCapDollars: number;
  /** Headroom left under the per-underlying (this-account) cap. */
  perUnderlyingHeadroom: number;
  /** Headroom left under the combined cross-account cap. */
  combinedHeadroom: number;
  /** Which cap bound the result (or "none" when neither is active). */
  bindingCap: "per-underlying" | "combined" | "none";
  perUnderlyingCapPct: number;
  combinedCapPct: number;
}

/**
 * Exit-aware concentration headroom for a prospective add. Returns the dollars
 * of NEW exposure allowed after applying BOTH the quality-scaled per-underlying
 * (this-account) cap AND the combined cross-account cap. The result is the min
 * of the two headrooms and is never negative. Both caps default off (Infinity),
 * in which case the corresponding headroom is unbounded.
 */
export function evaluateConcentrationCaps(
  input: ConcentrationCapInput,
): ConcentrationCapResult {
  const basis = Number.isFinite(input.accountBasis) && input.accountBasis > 0
    ? input.accountBasis
    : 0;

  const perUnderlyingCapPct = getPerUnderlyingCapPctForQuality(input.quality);
  const combinedCapPct = getCombinedUnderlyingCapPct();

  const perUnderlyingCapDollars = Number.isFinite(perUnderlyingCapPct)
    ? basis * perUnderlyingCapPct
    : Number.POSITIVE_INFINITY;
  const combinedCapDollars = Number.isFinite(combinedCapPct)
    ? basis * combinedCapPct
    : Number.POSITIVE_INFINITY;

  const perUnderlyingHeadroom = Number.isFinite(perUnderlyingCapDollars)
    ? Math.max(0, perUnderlyingCapDollars - Math.max(0, input.existingAccountExposure))
    : Number.POSITIVE_INFINITY;
  const combinedHeadroom = Number.isFinite(combinedCapDollars)
    ? Math.max(0, combinedCapDollars - Math.max(0, input.existingCombinedExposure))
    : Number.POSITIVE_INFINITY;

  const allowedAdditionalExposure = Math.min(perUnderlyingHeadroom, combinedHeadroom);

  let bindingCap: ConcentrationCapResult["bindingCap"] = "none";
  if (Number.isFinite(allowedAdditionalExposure)) {
    bindingCap =
      combinedHeadroom < perUnderlyingHeadroom ? "combined" : "per-underlying";
  }

  return {
    allowedAdditionalExposure,
    perUnderlyingCapDollars,
    combinedCapDollars,
    perUnderlyingHeadroom,
    combinedHeadroom,
    bindingCap,
    perUnderlyingCapPct,
    combinedCapPct,
  };
}
