import { getAccountMarginOrCash, getMarginAccountNumber } from "~/core/default-account";
import { getEffectiveBuyingPowerSummary } from "~/bot/effective-buying-power";
import { getMarginTargetCallDelta } from "~/strategy/entry-filters";
import { getTopOptionCandidateForSymbol } from "./selection";
import { TopOptionCandidateForAccountResult } from "./types";
import type { OptionCandidateSelectionOptions } from "~/bot/option-contracts";

export const CASH_ACCOUNT_SEED_MIN_DTE = 14;
export const CASH_ACCOUNT_SEED_MAX_DTE = 30;

export function getSeedSelectionOptionsForAccountType(
  accountType: "margin" | "cash" | "unknown",
): OptionCandidateSelectionOptions {
  return accountType === "cash"
    ? { minDTE: CASH_ACCOUNT_SEED_MIN_DTE, maxDTE: CASH_ACCOUNT_SEED_MAX_DTE }
    : { strikeTarget: "otm" as const, targetDelta: getMarginTargetCallDelta() };
}

export async function getTopOptionCandidateForAccount(
  symbol: string,
  side: "call" | "put" = "call",
  accountNumber?: string,
): Promise<TopOptionCandidateForAccountResult> {
  const resolvedAccount = accountNumber?.trim() || await getMarginAccountNumber();
  const accountType = await getAccountMarginOrCash(resolvedAccount);
  const selectionOptions = getSeedSelectionOptionsForAccountType(accountType);

  const [candidate, buyingPowerSummary] = await Promise.all([
    getTopOptionCandidateForSymbol(symbol, side, undefined, selectionOptions),
    getEffectiveBuyingPowerSummary(resolvedAccount, new Date(), { bypassCashAccountCap: true }),
  ]);

  const askPrice = candidate?.skippedReason == null ? candidate?.askPrice : undefined;
  const estimatedOrderCost = askPrice != null ? askPrice * 100 : null;
  const wouldPassBuyingPowerCheck = estimatedOrderCost != null
    ? estimatedOrderCost <= buyingPowerSummary.effectiveBuyingPower
    : null;

  return {
    ...candidate,
    accountNumber: resolvedAccount,
    accountType,
    estimatedOrderCost,
    buyingPower: {
      effectiveBuyingPower: buyingPowerSummary.effectiveBuyingPower,
      buyingPowerRemaining: buyingPowerSummary.buyingPowerRemaining,
      exposureHeadroom: buyingPowerSummary.exposureHeadroom,
      targetExposurePct: buyingPowerSummary.targetExposurePct,
      currentExposurePct: buyingPowerSummary.currentExposurePct,
      totalCapital: buyingPowerSummary.totalCapital,
    },
    wouldPassBuyingPowerCheck,
  };
}
