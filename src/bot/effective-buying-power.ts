import { getCurrentAllocationBudget } from "./actions/manage-allocation";
import { getTimeOfDayExecutionTargets } from "./evaluate-trading-strategy";
import { getAccountMarginOrCash } from "~/core/default-account";
import { getMaxBuyExposurePctForAccountType } from "./risk-limits";

export interface EffectiveBuyingPowerSummary {
  buyingPowerRemaining: number;
  currentExposurePct: number;
  currentExposureValue: number;
  effectiveBuyingPower: number;
  exposureHeadroom: number;
  targetExposurePct: number;
  targetExposureValue: number;
  totalCapital: number;
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
  const effectiveBuyingPower = Math.max(
    0,
    Math.min(
      budget.buyingPowerRemaining,
      exposureHeadroom,
      maxBuyAmountPerAction,
    ),
  );
  const currentExposurePct =
    budget.totalCapital > 0 ? budget.portfolioExposure / budget.totalCapital : 0;

  return {
    buyingPowerRemaining: budget.buyingPowerRemaining,
    currentExposurePct,
    currentExposureValue: budget.portfolioExposure,
    effectiveBuyingPower,
    exposureHeadroom,
    targetExposurePct: executionTargets.targetAccountExposure,
    targetExposureValue,
    totalCapital: budget.totalCapital,
  };
}
