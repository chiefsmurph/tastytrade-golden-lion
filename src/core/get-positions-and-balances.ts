import tastytradeApi from "./tastytrade-client";
import { getDefaultAccountNumber } from "./default-account";
import { getTopOptionCandidateForSymbol } from "~/bot/option-candidate";
import { getEffectiveBuyingPowerSummary } from "~/bot/effective-buying-power";
import { getRunCyclePreview } from "~/bot/run-cycle";

export async function getPositionsAndBalances(accountNumber?: string) {
  const resolvedAccountNumber = accountNumber ?? (await getDefaultAccountNumber());
  const [balances, positions, preview, balanceSummary] = await Promise.all([
    tastytradeApi.balancesAndPositionsService.getAccountBalanceValues(
      resolvedAccountNumber,
    ),
    tastytradeApi.balancesAndPositionsService.getPositionsList(
      resolvedAccountNumber,
    ),
    getRunCyclePreview(resolvedAccountNumber),
    getEffectiveBuyingPowerSummary(resolvedAccountNumber),
  ]);

  const symbolsFromGroups = preview.groups
    .map((group) => String(group.underlyingSymbol ?? "").trim().toUpperCase())
    .filter((symbol) => symbol.length > 0);
  const symbolsFromPositions = positions
    .map((position) => {
      const underlying = String(position["underlying-symbol"] ?? "").trim();
      const fallback = String(position.symbol ?? "").trim();
      return (underlying || fallback).toUpperCase();
    })
    .filter((symbol) => symbol.length > 0);
  const activeSymbols = Array.from(
    new Set([...symbolsFromGroups, ...symbolsFromPositions]),
  );

  const topOptionCandidatesBySymbol = Object.fromEntries(
    await Promise.all(
      activeSymbols.map(async (symbol) => {
        try {
          const [call, put] = await Promise.all([
            getTopOptionCandidateForSymbol(symbol, "call"),
            getTopOptionCandidateForSymbol(symbol, "put"),
          ]);

          return [symbol, { call, put }] as const;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return [
            symbol,
            {
              call: {
                requestedSide: "call" as const,
                skippedReason: `candidate lookup failed: ${message}`,
              },
              put: {
                requestedSide: "put" as const,
                skippedReason: `candidate lookup failed: ${message}`,
              },
            },
          ] as const;
        }
      }),
    ),
  );

  return {
    accountNumber: resolvedAccountNumber,
    analysis: {
      groups: preview.groups,
      plan: preview.plan,
      snapshot: preview.snapshot,
      strategySummary: preview.strategySummary,
    },
    balances,
    balanceSummary,
    topOptionCandidatesBySymbol,
    positions,
  };
}
