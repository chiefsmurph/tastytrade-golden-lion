import {
  getConservativeSpendableFunds,
  getEffectiveTotalCapital,
  getSpendableFundsForAccountType,
} from "~/core/account-balance";
import { getAccountMarginOrCash } from "~/core/default-account";
import tastytradeApi from "~/core/tastytrade-client";
import { getPositionEvaluations } from "./get-position-evaluations";
import { PositionGroupEvaluation } from "./evaluate-position";
import { getGroupMarketValue } from "./actions/order-utils";

export interface AllocationBudget {
  buyingPowerRemaining: number;
  portfolioExposure: number;
  totalCapital: number;
}

export function buildInitialBudget(
  buyingPower: number,
  totalCapital: number,
  evaluations: PositionGroupEvaluation[],
): AllocationBudget {
  return {
    buyingPowerRemaining: buyingPower,
    portfolioExposure: evaluations.reduce(
      (sum, evaluation) => sum + getGroupMarketValue(evaluation.positionSnapshots),
      0,
    ),
    totalCapital,
  };
}

export async function getCurrentAllocationBudget(
  accountNumber: string,
  options?: { bypassCashAccountCap?: boolean },
): Promise<AllocationBudget> {
  const [accountBalance, evaluations] = await Promise.all([
    tastytradeApi.balancesAndPositionsService.getAccountBalanceValues(
      accountNumber,
    ),
    getPositionEvaluations(accountNumber),
  ]);
  const accountMarginOrCash = await getAccountMarginOrCash(accountNumber);

  const buyingPower =
    options?.bypassCashAccountCap && accountMarginOrCash === "cash"
      ? getConservativeSpendableFunds(accountBalance)
      : getSpendableFundsForAccountType(accountBalance, accountMarginOrCash);

  return buildInitialBudget(
    buyingPower,
    getEffectiveTotalCapital(accountBalance),
    evaluations,
  );
}
