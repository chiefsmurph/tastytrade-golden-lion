import { getTimeOfDayExecutionTargets } from "../evaluate-trading-strategy";
import { getOptionMarketSnapshot } from "./market-snapshot";
import { buildTopOptionCandidateResult } from "./selection";
import {
  OptionHealthForSymbolResult,
  OptionHealthGateDecision,
  OptionHealthSummary,
  TopOptionCandidateForSymbolResult,
} from "./types";

const DEFAULT_OPTION_HEALTH_DTES = [7, 14, 30] as const;

export async function getOptionHealthForSymbol(
  symbol: string,
  side: "call" | "put" = "call",
  targetDTEs: readonly number[] = DEFAULT_OPTION_HEALTH_DTES,
  targetDTEForEligibility?: number,
): Promise<OptionHealthForSymbolResult> {
  const marketSnapshot = await getOptionMarketSnapshot(symbol);
  const resolvedUnderlyingPrice = marketSnapshot.underlyingPrice;
  const normalizedSymbol = symbol.toUpperCase();

  const targetEntries = await Promise.all(
    targetDTEs.map(async (targetDTE) => [
      String(targetDTE),
      await buildTopOptionCandidateResult(
        normalizedSymbol,
        side,
        marketSnapshot.optionChain,
        resolvedUnderlyingPrice,
        targetDTE,
      ),
    ] as const),
  );

  const targets = Object.fromEntries(targetEntries) as Record<
    string,
    TopOptionCandidateForSymbolResult | undefined
  >;
  const summary = targetDTEs.reduce<OptionHealthSummary>(
    (result, targetDTE) => {
      const candidate = targets[String(targetDTE)];

      if (!candidate?.symbol || candidate.meetsSpreadRequirement === false) {
        result.missingTargets.push(targetDTE);

        if (candidate?.meetsSpreadRequirement === false) {
          result.wideSpreadTargets.push(targetDTE);
        }

        return result;
      }

      if (candidate.usedDteFallback) {
        result.fallbackTargets.push(targetDTE);
        return result;
      }

      result.healthyTargets.push(targetDTE);

      return result;
    },
    {
      fallbackTargets: [],
      healthyTargets: [],
      missingTargets: [],
      wideSpreadTargets: [],
    },
  );

  const resolvedTargetDTE =
    targetDTEForEligibility ?? getTimeOfDayExecutionTargets(new Date()).targetDTE;
  const eligibility = evaluateOptionHealthForTargetDTE(summary, resolvedTargetDTE, targetDTEs);

  console.log(
    JSON.stringify({
      canOpenNewPosition: eligibility.passed,
      eligibility,
      requestedSide: side,
      scope: "option-health",
      summary,
      symbol: normalizedSymbol,
      targetDTE: resolvedTargetDTE,
      targets,
    }),
  );

  return {
    canOpenNewPosition: eligibility.passed,
    eligibility,
    requestedSide: side,
    summary,
    symbol: normalizedSymbol,
    targetDTE: resolvedTargetDTE,
    targets,
  };
}

export function evaluateOptionHealthForTargetDTE(
  summary: OptionHealthSummary,
  targetDTE: number,
  healthCheckDTEs: readonly number[] = DEFAULT_OPTION_HEALTH_DTES,
): OptionHealthGateDecision {
  const normalizedCheckpoints = [...new Set(healthCheckDTEs)]
    .filter((dte) => Number.isFinite(dte) && dte > 0)
    .sort((left, right) => left - right);

  const requiredHealthyTargets = normalizedCheckpoints.filter(
    (checkpointDTE) => checkpointDTE <= targetDTE,
  );

  const effectiveRequiredTargets =
    requiredHealthyTargets.length > 0
      ? requiredHealthyTargets
      : normalizedCheckpoints.slice(0, 1);

  const healthyTargetSet = new Set(summary.healthyTargets);
  const missingRequiredTargets = effectiveRequiredTargets.filter(
    (requiredDTE) => !healthyTargetSet.has(requiredDTE),
  );

  return {
    missingRequiredTargets,
    passed: missingRequiredTargets.length === 0,
    requiredHealthyTargets: effectiveRequiredTargets,
    targetDTE,
  };
}
