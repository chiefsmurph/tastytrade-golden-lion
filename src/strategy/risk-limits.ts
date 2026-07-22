import { readEnvInt } from "~/core/env-utils";
import { getIntradayStopLossFloor } from "~/strategy/evaluate-trading-strategy";

function parseEnvFraction(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getMarginMaxBuyExposurePct(): number {
  return parseEnvFraction("STRATEGY_MARGIN_MAX_BUY_EXPOSURE_PCT", 0.12);
}

export function getCashMaxBuyExposurePct(): number {
  return parseEnvFraction("STRATEGY_CASH_MAX_BUY_EXPOSURE_PCT", 0.05);
}

export function getMaxBuyExposurePctForAccountType(
  accountType: "margin" | "cash",
): number {
  return accountType === "margin" ? getMarginMaxBuyExposurePct() : getCashMaxBuyExposurePct();
}

// Absolute per-underlying accumulation ceilings (IMPROVEMENTS.v8 #4). The
// buy-position multiple caps each add relative to the group's *current* value,
// so a fast series of adds compounds (3x of an ever-growing base reached a
// 15-lot WEN position in ~70 minutes on 2026-07-06). These cap the TOTAL a
// group may reach. Both are stateless — headroom is recomputed every cycle
// from live broker positions — so an intraday restart cannot reset them.
// Off (Infinity) when unset, blank, zero, or invalid.

/** Max option contracts held per position group (`UNDERLYING::side`). */
export function getMaxUnderlyingContracts(): number {
  const parsed = readEnvInt("STRATEGY_MAX_UNDERLYING_CONTRACTS", 0);
  return parsed > 0 ? parsed : Infinity;
}

/**
 * RETIRED 2026-07-21 — dollar-denominated position caps are gone; every seed /
 * position limit is now a PERCENT of account NLV. This per-group NOTIONAL cap is
 * redundant with the %-based per-underlying concentration cap
 * (STRATEGY_MAX_UNDERLYING_ACCOUNT_PCT) plus the per-group CONTRACT cap
 * (STRATEGY_MAX_UNDERLYING_CONTRACTS), so it is permanently OFF (Infinity). The
 * STRATEGY_MAX_UNDERLYING_NOTIONAL env var is now ignored (flagged obsolete at
 * boot). Kept as a stable Infinity so the allocation-lane clamp math that reads
 * it stays a no-op without a wider refactor.
 */
export function getMaxUnderlyingNotional(): number {
  return Infinity;
}

// Dip-responsive target boost for margin: press a dip harder by raising the
// group's target exposure as the position falls — but only while signals stay
// good (booleans >= 4), so a falling knife with souring signals gets no boost.
// Off unless STRATEGY_MARGIN_DIP_TARGET_BOOST_MAX_PCT is set (e.g. 0.25 =
// up to +25% target exposure at the deepest boosted loss).
//
// Dip is measured on MID return, NOT ask — the ask is blind to bid-side spread
// pain (see IMPROVEMENTS.v8 #3). On 2026-07-06 WEN's ask sat +1% to +7% all day
// while its bid ran −9% to −18% (a ~18% spread); the pain was entirely on the
// bid, so the ask-based trigger never fired despite a boolean score of 6. The
// mid is the fair-value proxy: it moves down when the market re-marks the
// position lower, but does not over-trigger purely on a widening spread the way
// the bid alone would.
const DIP_BOOST_MIN_LOSS_FRACTION = 0.02;
const DIP_BOOST_MAX_LOSS_FRACTION = 0.12;
const DIP_BOOST_MIN_BOOLEAN_SCORE = 4;

// Bid-safety gate: do not press a "dip" when the bid return is already within
// DIP_BOOST_BID_SAFETY_MARGIN of the intraday stop-loss floor. If the bid is
// already at e.g. −20% with a −30% floor and a 10-point margin, the boost is
// suppressed to avoid averaging into what is about to be a forced close.
// The 2026-07-07 TE case: mid was −3% (just enough to trigger), but bid was
// already −27%; the boost added exposure and the position hit −33% bid stop
// about an hour later. The safety margin of 0.10 means: if bid ≤ −20% with a
// 30% floor, no boost.
const DIP_BOOST_BID_SAFETY_MARGIN = 0.10;

// Wide-spread suppression: leaning INTO a "dip" that is really just a widening
// spread is backwards (you would average down into a name you cannot get out
// of). When the position's current bid/ask spread (fraction of mid) exceeds
// this threshold, suppress the boost. Default is non-binding (off) so the only
// behavior change on deploy is the ask→mid basis; opt in via
// STRATEGY_MARGIN_DIP_TARGET_BOOST_MAX_SPREAD_PCT (e.g. 0.15 = suppress when the
// spread is wider than 15% of mid).
export function getMarginDipTargetBoostMaxSpreadPct(): number {
  // Off (non-binding) unless explicitly set to a positive fraction. parseEnvFraction
  // resolves absent/blank/non-positive to the fallback, so a blank env var stays off.
  return parseEnvFraction("STRATEGY_MARGIN_DIP_TARGET_BOOST_MAX_SPREAD_PCT", Infinity);
}

// Wide-spread suppression predicate (default off): true only when a KNOWN,
// finite spread exceeds the configured ceiling. An unknown/absent spread, or an
// unset ceiling, returns false — the boost degrades gracefully rather than
// being silently killed by a missing quote.
export function isDipBoostSuppressedByWideSpread(
  spreadFraction: number | null | undefined,
): boolean {
  const maxSpread = getMarginDipTargetBoostMaxSpreadPct();
  if (!Number.isFinite(maxSpread)) return false;
  if (spreadFraction == null || !Number.isFinite(spreadFraction)) return false;
  return spreadFraction > maxSpread;
}

export function getMarginDipTargetBoostPct(
  midReturnFraction: number,
  goodBooleanScore: number | null,
  spreadFraction?: number | null,
  bidReturnFraction?: number | null,
): number {
  const maxBoost = parseEnvFraction("STRATEGY_MARGIN_DIP_TARGET_BOOST_MAX_PCT", 0);
  if (maxBoost <= 0) return 0;
  if (goodBooleanScore == null || goodBooleanScore < DIP_BOOST_MIN_BOOLEAN_SCORE) {
    return 0;
  }
  // Don't press a "dip" that is really a blown-out spread (see comment above).
  if (isDipBoostSuppressedByWideSpread(spreadFraction)) return 0;

  // Bid-safety gate: if the bid return is already within DIP_BOOST_BID_SAFETY_MARGIN
  // of the intraday stop-loss floor, the boost is suppressed. Averaging into a
  // position that is approaching a forced close only makes the forced-close loss
  // larger. See 2026-07-07 TE case for why this gate is needed.
  if (bidReturnFraction != null && Number.isFinite(bidReturnFraction)) {
    const stopLossFloor = getIntradayStopLossFloor();
    const bidSafetyThreshold = -(stopLossFloor - DIP_BOOST_BID_SAFETY_MARGIN);
    if (bidReturnFraction <= bidSafetyThreshold) {
      console.log(
        JSON.stringify({
          scope: "dip-boost-bid-safety-gate",
          reason: "bid-too-close-to-stop-floor",
          bidReturnFraction,
          bidSafetyThreshold,
          stopLossFloor,
          safetyMargin: DIP_BOOST_BID_SAFETY_MARGIN,
        }),
      );
      return 0;
    }
  }

  const lossFraction = -midReturnFraction;
  if (lossFraction <= DIP_BOOST_MIN_LOSS_FRACTION) return 0;

  const depthRatio = Math.min(
    1,
    (lossFraction - DIP_BOOST_MIN_LOSS_FRACTION) /
      (DIP_BOOST_MAX_LOSS_FRACTION - DIP_BOOST_MIN_LOSS_FRACTION),
  );
  return maxBoost * depthRatio;
}
