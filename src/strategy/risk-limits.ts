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

// Dip-responsive target boost for margin: press a dip harder by raising the
// group's target exposure as the position falls — but only while signals stay
// good (booleans >= 4), so a falling knife with souring signals gets no boost.
// Off unless STRATEGY_MARGIN_DIP_TARGET_BOOST_MAX_PCT is set (e.g. 0.25 =
// up to +25% target exposure at the deepest boosted loss).
const DIP_BOOST_MIN_LOSS_FRACTION = 0.02;
const DIP_BOOST_MAX_LOSS_FRACTION = 0.12;
const DIP_BOOST_MIN_BOOLEAN_SCORE = 4;

export function getMarginDipTargetBoostPct(
  askReturnFraction: number,
  goodBooleanScore: number | null,
): number {
  const maxBoost = parseEnvFraction("STRATEGY_MARGIN_DIP_TARGET_BOOST_MAX_PCT", 0);
  if (maxBoost <= 0) return 0;
  if (goodBooleanScore == null || goodBooleanScore < DIP_BOOST_MIN_BOOLEAN_SCORE) {
    return 0;
  }

  const lossFraction = -askReturnFraction;
  if (lossFraction <= DIP_BOOST_MIN_LOSS_FRACTION) return 0;

  const depthRatio = Math.min(
    1,
    (lossFraction - DIP_BOOST_MIN_LOSS_FRACTION) /
      (DIP_BOOST_MAX_LOSS_FRACTION - DIP_BOOST_MIN_LOSS_FRACTION),
  );
  return maxBoost * depthRatio;
}
