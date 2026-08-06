import { readEnvFraction, toBooleanFlag } from "~/core/env-utils";
import type { StrategyAccountType } from "./evaluate-trading-strategy";

// Partial take-profit ("scale-out") + breakeven-ratchet runner.
//
// Default behaviour is unchanged: when the profit target is hit the whole
// position is closed all-or-nothing. When scale-out is ENABLED (env flag), the
// first time a group hits the dynamic take-profit target we close only
// `fraction` of it and let the rest ("the runner") ride to a higher target,
// protected at breakeven so a winner can't turn back into a loser. The runner's
// "already scaled" memory lives in the scale-out store (keyed per account +
// UNDERLYING::side); this module only reads config + carries the flag.
//
// v1 is CASH-ONLY: the cash account holds overnight, so "let it run" is real.
// The margin account flattens every day at the 12:50 EOD liquidation, so a
// runner there could only ride until the close — deliberately out of scope for
// v1. Widen `isScaleOutEligibleAccount` when/if we extend it to margin.

export interface ScaleOutConfig {
  enabled: boolean;
  // Fraction of the position closed on the first take-profit trip (rest runs).
  fraction: number;
  // The runner's second target = dynamicTakeProfitTarget * runnerTargetMultiple.
  runnerTargetMultiple: number;
}

export interface ScaleOutContext extends ScaleOutConfig {
  // From the scale-out store: has this group already had its first tranche
  // scaled out (i.e. is it now a runner)?
  alreadyScaled: boolean;
}

function isScaleOutEligibleAccount(accountType: StrategyAccountType): boolean {
  return accountType === "cash";
}

function getRunnerTargetMultiple(fallback: number): number {
  const raw = process.env.STRATEGY_SCALE_OUT_RUNNER_TARGET_MULTIPLE?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  // Must be > 1: the runner's target has to sit ABOVE the base target, or the
  // runner would exit immediately at the same level it just scaled out of.
  return Number.isFinite(parsed) && parsed > 1 ? parsed : fallback;
}

// Turn a strategy `closeFraction` into an absolute contract count to close on a
// partial take-profit, or `undefined` when it's really a full close. Needs ≥ 2
// contracts to leave a runner behind — a 1-lot can't be split, so it closes
// fully. `floor` guarantees the remainder is ≥ 1 whenever fraction < 1.
export function computeScaleOutMaxQuantity(
  closeFraction: number | undefined,
  totalContracts: number,
): number | undefined {
  if (typeof closeFraction !== "number" || closeFraction >= 1) return undefined;
  if (!(totalContracts >= 2)) return undefined;
  return Math.max(1, Math.floor(totalContracts * closeFraction));
}

export function getScaleOutConfig(
  accountType: StrategyAccountType,
): ScaleOutConfig {
  const flagOn = toBooleanFlag(process.env.STRATEGY_PARTIAL_SCALE_OUT_ENABLED);
  const enabled = flagOn && isScaleOutEligibleAccount(accountType);
  // Clamp fraction to (0,1): 0 would scale out nothing, 1 would be a full close.
  const rawFraction = readEnvFraction("STRATEGY_SCALE_OUT_FRACTION", 0.5);
  const fraction = Math.min(0.95, Math.max(0.05, rawFraction));
  return {
    enabled,
    fraction,
    runnerTargetMultiple: getRunnerTargetMultiple(1.5),
  };
}
