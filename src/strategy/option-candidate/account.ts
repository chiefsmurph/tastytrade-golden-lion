import { getAccountMarginOrCash, getMarginAccountNumber } from "~/core/default-account";
import { getEffectiveBuyingPowerSummary } from "~/bot/effective-buying-power";
import { getMarginTargetCallDelta } from "~/strategy/entry-filters";
import { readEnvInt } from "~/core/env-utils";
import { getRecentSeedOutcome } from "~/bot/actions/seed-outcome-store";
import { getTopOptionCandidateForSymbol } from "./selection";
import { TopOptionCandidateForAccountResult } from "./types";
import type { OptionCandidateSelectionOptions } from "~/bot/option-contracts";

// How long a recorded seed-spray abort keeps overriding the pre-trade
// "✅ buying power" candidate status on the dashboard. After this, revert to the
// live candidate view; a newer seed attempt overwrites the outcome sooner.
function getSeedOutcomeOverlayMaxAgeMs(): number {
  return readEnvInt("BOT_SEED_OUTCOME_OVERLAY_MAX_AGE_MS", 45 * 60 * 1000, (n) => n > 0);
}

export const CASH_ACCOUNT_SEED_MIN_DTE = 14;
export const CASH_ACCOUNT_SEED_MAX_DTE = 30;

// Widened retry window for cash seeds when nothing lands in the primary
// 14-30 window. Small caps often carry only monthly expirations, so whole
// calendar stretches have no candidate in-window; the fallback lets a seed
// take the nearest monthly instead of skipping for weeks at a time.
export function getCashSeedDteFallbackWindow(): { minDTE: number; maxDTE: number } {
  return {
    minDTE: readEnvInt("STRATEGY_CASH_SEED_DTE_FALLBACK_MIN_DTE", 7, (n) => n >= 0),
    maxDTE: readEnvInt("STRATEGY_CASH_SEED_DTE_FALLBACK_MAX_DTE", 60, (n) => n > 0),
  };
}

export function getSeedSelectionOptionsForAccountType(
  accountType: "margin" | "cash" | "unknown",
): OptionCandidateSelectionOptions {
  // accountType rides along so candidate selection applies the account-aware
  // entry liquidity gate (see ~/strategy/liquidity-gate).
  return accountType === "cash"
    ? { accountType, minDTE: CASH_ACCOUNT_SEED_MIN_DTE, maxDTE: CASH_ACCOUNT_SEED_MAX_DTE }
    : { accountType, strikeTarget: "otm" as const, targetDelta: getMarginTargetCallDelta() };
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

  // Execution-state overlay: when the candidate itself isn't skipped (would
  // otherwise render "✅ buying power"), but the most recent seed spray for this
  // account+symbol+side actually placed and aborted with ZERO fills, surface
  // that as a skippedReason so the dashboard shows the truth instead of a green
  // check for something that bought nothing. A partial fill (observedFilled > 0)
  // becomes a real position group and is intentionally left alone.
  let skippedReason = candidate?.skippedReason;
  if (skippedReason == null) {
    const outcome = await getRecentSeedOutcome(
      accountType,
      symbol,
      side,
      getSeedOutcomeOverlayMaxAgeMs(),
    );
    if (outcome && outcome.state === "aborted" && outcome.observedFilled === 0) {
      skippedReason = `last spray aborted: ${outcome.reason ?? "unknown"} (0/${outcome.totalContracts})`;
    }
  }

  return {
    ...candidate,
    skippedReason,
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
