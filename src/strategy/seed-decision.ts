import { getCashAccountSeedEndMinute } from "./seeding-windows";
import { shouldSeedMarginFromBooleans } from "./position-gate";
import { getNumDaysToSellOff } from "./overnight-reduction";
import { getUnderlyingIvMetrics } from "~/core/market-metrics";
import { getSecretSocketStatus } from "~/strategy/secret/secret-socket-state";
import type { SecretSourcePosition } from "~/strategy/secret/types";

export interface MarginSeedConfig {
  minDownPct: number;
  maxDownPct: number;
}

export interface SeedDecision {
  shouldSeed: boolean;
  ivRank: number | null;
  reason: string;
}

// Feature is opt-in: disabled if STRATEGY_MARGIN_SEED_FROM_CASH_MIN_DOWN_PCT is unset.
// STRATEGY_MARGIN_SEED_FROM_CASH_MAX_DOWN_PCT caps how deep a loss will still trigger
// a seed — beyond this the position is too close to the bid stop-loss floor.
// Defaults to 18 if unset.
export function getMarginSeedConfig(): MarginSeedConfig | null {
  const rawMin = process.env.STRATEGY_MARGIN_SEED_FROM_CASH_MIN_DOWN_PCT?.trim();
  if (!rawMin) return null;
  const minDownPct = Number(rawMin);
  if (!Number.isFinite(minDownPct) || minDownPct <= 0) return null;

  const rawMax = process.env.STRATEGY_MARGIN_SEED_FROM_CASH_MAX_DOWN_PCT?.trim();
  const parsedMax = rawMax ? Number(rawMax) : NaN;
  const maxDownPct = Number.isFinite(parsedMax) && parsedMax > minDownPct ? parsedMax : 18;

  if (minDownPct >= maxDownPct) return null;
  return { minDownPct, maxDownPct };
}

export function getCashSeedFromMarginConfig(): MarginSeedConfig | null {
  const rawMin = process.env.STRATEGY_CASH_SEED_FROM_MARGIN_MIN_DOWN_PCT?.trim();
  if (!rawMin) return null;
  const minDownPct = Number(rawMin);
  if (!Number.isFinite(minDownPct) || minDownPct <= 0) return null;

  const rawMax = process.env.STRATEGY_CASH_SEED_FROM_MARGIN_MAX_DOWN_PCT?.trim();
  const parsedMax = rawMax ? Number(rawMax) : NaN;
  const maxDownPct = Number.isFinite(parsedMax) && parsedMax > minDownPct ? parsedMax : minDownPct + 10;

  if (minDownPct >= maxDownPct) return null;
  return { minDownPct, maxDownPct };
}

// Time-of-day multiplier: early morning = 1.5 (conservative, bigger loss needed).
// Scales linearly down to 0.7 at the cash seed window end (~1 PM).
export function getTimeOfDaySeedMultiplier(currentTime: Date): number {
  const OPEN_MINUTE = 6 * 60 + 30;
  const endMinute = getCashAccountSeedEndMinute();
  const minuteOfDay = currentTime.getHours() * 60 + currentTime.getMinutes();
  const span = endMinute - OPEN_MINUTE;
  const t = span > 0 ? Math.max(0, Math.min(1, (minuteOfDay - OPEN_MINUTE) / span)) : 1;
  return 1.5 - 0.8 * t;
}

// Age multiplier: new position (day 0) = 1.5 (conservative).
// Scales down to 0.7 at STRATEGY_OVERNIGHT_REDUCTION_DAYS_TO_SELLOFF - 1 days.
export function getPositionAgeSeedMultiplier(positionAgeDays: number | null): number {
  if (positionAgeDays === null) return 1.0;
  const fullAgeDays = Math.max(1, getNumDaysToSellOff() - 1);
  const t = Math.max(0, Math.min(1, positionAgeDays / fullAgeDays));
  return 1.5 - 0.8 * t;
}

// Intraday age multiplier for margin positions (no overnight hold).
// Brand-new (0 min) = 1.5 (conservative). Scales to 0.7 at 120+ minutes.
export function getPositionAgeMinutesSeedMultiplier(positionAgeMinutes: number | null): number {
  if (positionAgeMinutes === null) return 1.0;
  const FULL_AGE_MINUTES = 120;
  const t = Math.max(0, Math.min(1, positionAgeMinutes / FULL_AGE_MINUTES));
  return 1.5 - 0.8 * t;
}

// Position-fill multiplier: how much of its exposure target the margin
// position already occupies (pctOfNetLiq / targetExposurePct). Barely deployed
// (margin can still average down on its own) = 1.5 (conservative — cash holds
// back). At/beyond target (margin fully committed, cash is the only way to
// keep pressing) = 0.7 (aggressive).
export function getPositionFillSeedMultiplier(fillRatio: number | null): number {
  if (fillRatio === null || !Number.isFinite(fillRatio)) return 1.0;
  const t = Math.max(0, Math.min(1, fillRatio));
  return 1.5 - 0.8 * t;
}

// Boolean multiplier: good signals lower thresholds so seeding fires on smaller losses.
// Score = thesis 0–9 + willBuy icing (+2): <3=neutral (1.0×), 3-4=slight boost (0.95×),
// 5-6=good (0.85×), 7+=great (0.7×). Every tier is reachable by thesis alone.
export function getBooleanSeedMultiplier(goodBooleanScore: number | null): number {
  if (goodBooleanScore === null) return 1.0;
  if (goodBooleanScore >= 7) return 0.7;
  if (goodBooleanScore >= 5) return 0.85;
  if (goodBooleanScore >= 3) return 0.95;
  return 1.0;
}

// Returns effective thresholds after applying time-of-day, position-age, boolean,
// and position-fill scaling.
// maxDownPct is capped at the configured max — scaling can only lower it, never raise it.
export function getScaledThresholds(
  config: MarginSeedConfig,
  timeFactor: number,
  ageFactor: number,
  booleanFactor: number,
  fillFactor = 1,
): MarginSeedConfig {
  const combined = timeFactor * ageFactor * booleanFactor * fillFactor;
  const maxDownPct = Math.min(config.maxDownPct * combined, config.maxDownPct);
  // Stacked conservative multipliers can reach ~3.4× (early + brand-new +
  // margin barely deployed), which would push a scaled min above the capped
  // max and silently empty the seed window (min > max ⇒ never seed). Clamp the
  // min just below the max so the window stays valid — the most conservative
  // case is a narrow window at the top of the band, not a nonexistent one.
  const rawMin = Math.max(config.minDownPct * combined, 1);
  const minDownPct = Math.min(rawMin, maxDownPct - 0.01);
  return { minDownPct, maxDownPct };
}

// Two zones split at the midpoint of [minDownPct, maxDownPct]:
//   Early zone  (loss < mid): seed if booleans ≥ 4/5  OR  IV rank ≥ 50
//   Deep zone   (loss ≥ mid): seed if booleans ≥ 6/9 OR  IV rank ≥ 70 (willBuy icing can exceed 9)
// Boolean score takes precedence to avoid an extra API call when data is present.
// When neither source is available, don't seed — unknown thesis = no action.
export async function getSeedDecision(
  symbol: string,
  lossDepth: number,
  goodBooleanScore: number | null,
  secretPosition: SecretSourcePosition | undefined,
  thresholds: MarginSeedConfig,
): Promise<SeedDecision> {
  const midDownPct = (thresholds.minDownPct + thresholds.maxDownPct) / 2;
  const isDeepLoss = lossDepth >= midDownPct;

  if (goodBooleanScore !== null) {
    if (isDeepLoss) {
      const passes = goodBooleanScore >= 6;
      return {
        shouldSeed: passes,
        ivRank: null,
        reason: passes
          ? `boolean ${goodBooleanScore}/9 passes deep-loss threshold (6)`
          : `boolean ${goodBooleanScore}/9 below deep-loss threshold (6)`,
      };
    } else {
      const passes = shouldSeedMarginFromBooleans(secretPosition);
      return {
        shouldSeed: passes,
        ivRank: null,
        reason: passes
          ? `boolean ${goodBooleanScore}/9 passes early-loss threshold (4/5 signals)`
          : `boolean ${goodBooleanScore}/9 below early-loss threshold (4/5 signals)`,
      };
    }
  }

  const ivMetrics = await getUnderlyingIvMetrics(symbol);
  const ivRank = ivMetrics?.ivRank ?? null;

  if (ivRank === null) {
    // Distinguish "feed never sent this symbol" from "we just restarted and the
    // cache is still cold" — the staleness tells which one it was.
    const staleness = getSecretSocketStatus().secondsSinceLastPositionsUpdate;
    const feedDetail =
      staleness == null
        ? "no positions update received since boot"
        : `last positions update ${Math.round(staleness)}s ago`;
    return {
      shouldSeed: false,
      ivRank: null,
      reason: `no boolean data and IV rank unavailable (${feedDetail})`,
    };
  }

  const requiredIvRank = isDeepLoss ? 70 : 50;
  const passes = ivRank >= requiredIvRank;
  return {
    shouldSeed: passes,
    ivRank,
    reason: passes
      ? `IV rank ${ivRank.toFixed(0)} passes ${isDeepLoss ? "deep" : "early"}-loss threshold (${requiredIvRank})`
      : `IV rank ${ivRank.toFixed(0)} below ${isDeepLoss ? "deep" : "early"}-loss threshold (${requiredIvRank})`,
  };
}
