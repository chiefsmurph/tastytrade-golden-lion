import { getCurrentAllocationBudget } from "./allocation-budget";
import { getTimeOfDayExecutionTargets } from "~/strategy/evaluate-trading-strategy";
import { getAccountMarginOrCash } from "~/core/default-account";
import { getMaxBuyExposurePctForAccountType } from "~/strategy/risk-limits";

export type EffectiveBuyingPowerLimitingFactor =
  | "per-action-cap"
  | "exposure-headroom"
  | "buying-power-remaining";

export interface EffectiveBuyingPowerSummary {
  buyingPowerRemaining: number;
  currentExposurePct: number;
  currentExposureValue: number;
  effectiveBuyingPower: number;
  exposureHeadroom: number;
  limitingFactor: EffectiveBuyingPowerLimitingFactor;
  maxBuyAmountPerAction: number;
  targetExposurePct: number;
  targetExposureValue: number;
  totalCapital: number;
}

export function describeEffectiveBuyingPowerLimit(
  summary: EffectiveBuyingPowerSummary,
): string {
  const cap = summary.effectiveBuyingPower.toFixed(2);
  switch (summary.limitingFactor) {
    case "per-action-cap":
      return `capped at ${cap} by per-action max buy pct`;
    case "exposure-headroom":
      return `capped at ${cap} by time-of-day exposure headroom`;
    case "buying-power-remaining":
      return `capped at ${cap} by remaining buying power`;
  }
}

export async function getEffectiveBuyingPowerSummary(
  accountNumber: string,
  currentTime = new Date(),
  options?: { bypassCashAccountCap?: boolean },
): Promise<EffectiveBuyingPowerSummary> {
  const budget = await getCurrentAllocationBudget(accountNumber, options);
  const accountType = await getAccountMarginOrCash(accountNumber);
  const executionTargets = getTimeOfDayExecutionTargets(currentTime, accountType);

  const targetExposureValue =
    budget.totalCapital * executionTargets.targetAccountExposure;
  const exposureHeadroom = Math.max(
    0,
    targetExposureValue - budget.portfolioExposure,
  );
  const maxBuyAmountPerAction = Math.max(
    0,
    budget.totalCapital * getMaxBuyExposurePctForAccountType(accountType === "unknown" ? "cash" : accountType),
  );
  const rawEffectiveBuyingPower = Math.min(
    budget.buyingPowerRemaining,
    exposureHeadroom,
    maxBuyAmountPerAction,
  );
  const limitingFactor: EffectiveBuyingPowerLimitingFactor =
    rawEffectiveBuyingPower === maxBuyAmountPerAction
      ? "per-action-cap"
      : rawEffectiveBuyingPower === exposureHeadroom
        ? "exposure-headroom"
        : "buying-power-remaining";
  const effectiveBuyingPower = Math.max(0, rawEffectiveBuyingPower);
  const currentExposurePct =
    budget.totalCapital > 0 ? budget.portfolioExposure / budget.totalCapital : 0;

  return {
    buyingPowerRemaining: budget.buyingPowerRemaining,
    currentExposurePct,
    currentExposureValue: budget.portfolioExposure,
    effectiveBuyingPower,
    exposureHeadroom,
    limitingFactor,
    maxBuyAmountPerAction,
    targetExposurePct: executionTargets.targetAccountExposure,
    targetExposureValue,
    totalCapital: budget.totalCapital,
  };
}
