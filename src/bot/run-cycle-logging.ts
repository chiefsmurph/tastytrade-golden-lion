import { PositionGroupEvaluation } from "./evaluate-position";
import { RunGroupReturn, RunStrategyDecision } from "./run-history";
import { buildGroupExecutionTargets } from "~/strategy/group-execution-targets";
import { getSecretSocketStatus } from "./secret";
import type { RunCyclePreview } from "./run-cycle-context";
import { getMaxBuyExposurePctForAccountType } from "~/strategy/risk-limits";
import type { StrategyAccountType } from "~/strategy/evaluate-trading-strategy";

type BaseExecutionTargets = {
  askWeight: number;
  bidWeight: number;
  midWeight: number;
  targetAccountExposure: number;
  targetDTE: number;
};

function formatCurrency(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function logRunSnapshot(preview: RunCyclePreview): void {
  const secretStatus = getSecretSocketStatus();
  const secondsSinceLastPositionsUpdate =
    secretStatus.secondsSinceLastPositionsUpdate === null
      ? "n/a"
      : `${secretStatus.secondsSinceLastPositionsUpdate.toFixed(1)}s`;

  console.log("\n================ RUN SNAPSHOT ================");
  console.log(
    `Current Exposure: ${formatPercent(preview.snapshot.currentExposurePct)} (${formatCurrency(preview.snapshot.currentExposureValue)} of ${formatCurrency(preview.snapshot.totalCapital)})`,
  );
  console.log(
    `Target Exposure:  ${formatPercent(preview.snapshot.targetExposurePct)} (${formatCurrency(preview.snapshot.targetExposureValue)} of ${formatCurrency(preview.snapshot.totalCapital)})`,
  );
  console.log(`Target DTE:       ${preview.snapshot.targetDTE}`);
  console.log(
    `Take Profit:      ${formatPercent(preview.snapshot.dynamicTakeProfitTarget)}`,
  );
  console.log(
    `Route Weights:    bid=${preview.snapshot.routeWeights.bid.toFixed(2)} mid=${preview.snapshot.routeWeights.mid.toFixed(2)} ask=${preview.snapshot.routeWeights.ask.toFixed(2)}`,
  );
  console.log(
    `Secret Socket:    connected=${secretStatus.connected} positions=${secretStatus.cachedPositionsCount} secondsSinceLastPositionsUpdate=${secondsSinceLastPositionsUpdate}`,
  );
  console.log(`Read Only:       ${preview.snapshot.readOnly ? "yes" : "no"}`);
  console.log("===============================================\n");
}

export function logRunPlan(preview: RunCyclePreview): void {
  console.log("\n================= RUN PLAN =================");
  console.log(`Account: ${preview.accountNumber}`);
  console.log(
    `Strategy groups: manage=${preview.strategySummary.manageAllocationCount} close=${preview.strategySummary.closePositionCount}`,
  );

  if (preview.plan.ignoredGroups.length > 0) {
    console.log("Ignored do-not-touch groups:");
    for (const group of preview.plan.ignoredGroups) {
      console.log(
        `- ${group.groupKey} (${group.strategyAction ?? "UNKNOWN"}, currentReturn=${formatPercent(group.currentReturnPct)})`,
      );
    }
  }

  if (preview.plan.rows.length === 0) {
    console.log("No allocation orders planned for this cycle.");

    if (preview.plan.diagnostics.length > 0) {
      console.log("Planning diagnostics:");
      for (const item of preview.plan.diagnostics) {
        console.log(
          `- ${item.underlyingSymbol}: ${item.skippedReason} (currentReturn=${formatPercent(item.currentReturnPct)})`,
        );
      }
    }

    console.log("============================================\n");
    return;
  }

  console.log("symbol                route  qty   limit      estCost");
  console.log("--------------------  -----  ----  ---------  ----------");

  for (const row of preview.plan.rows) {
    const symbol = row.symbol.padEnd(20, " ");
    const route = row.route.padEnd(5, " ");
    const qty = String(row.quantity).padStart(4, " ");
    const limit = row.limitPrice.toFixed(2).padStart(9, " ");
    const estCost = formatCurrency(row.estimatedCost).padStart(10, " ");
    console.log(`${symbol}  ${route}  ${qty}  ${limit}  ${estCost}`);
  }

  console.log("--------------------  -----  ----  ---------  ----------");
  console.log(
    `TOTAL                            ${String(preview.plan.totalContracts).padStart(4, " ")}             ${formatCurrency(preview.plan.totalEstimatedCost).padStart(10, " ")}`,
  );
  console.log("============================================\n");
}

export function logGroupReturns(groupReturns: RunGroupReturn[]): void {
  console.log("\n============== GROUP RETURNS ==============");

  if (groupReturns.length === 0) {
    console.log("No grouped position returns available.");
    console.log("===========================================\n");
    return;
  }

  console.log(
    "underlying            side   bid%      ask%      current%   costBasis     unrlzdBid$   unrlzdAsk$",
  );
  console.log(
    "--------------------  -----  --------  --------  ---------  -----------  -----------  -----------",
  );

  for (const group of groupReturns) {
    const underlying = group.underlyingSymbol.padEnd(20, " ");
    const side = group.side.padEnd(5, " ");
    const bidReturn = formatPercent(group.bidReturnPct).padStart(8, " ");
    const askReturn = formatPercent(group.askReturnPct).padStart(8, " ");
    const currentReturn = formatPercent(group.currentReturnPct).padStart(9, " ");
    const costBasis = formatCurrency(group.totalCostBasis).padStart(11, " ");
    const unrealizedBid = formatCurrency(group.totalUnrealizedReturnBid).padStart(11, " ");
    const unrealizedAsk = formatCurrency(group.totalUnrealizedReturnAsk).padStart(11, " ");
    console.log(
      `${underlying}  ${side}  ${bidReturn}  ${askReturn}  ${currentReturn}  ${costBasis}  ${unrealizedBid}  ${unrealizedAsk}`,
    );
  }

  console.log("===========================================\n");
}

export function logStrategyDecisions(strategyDecisions: RunStrategyDecision[]): void {
  console.log("\n========== STRATEGY DECISIONS ===========");

  if (strategyDecisions.length === 0) {
    console.log("No strategy decisions available.");
    console.log("========================================\n");
    return;
  }

  for (const decision of strategyDecisions) {
    console.log(`\n${decision.underlyingSymbol}`);
    console.log(`  Action: ${decision.strategyAction}`);
    console.log(`  Return: ${formatPercent(decision.currentReturnPct)}`);
    console.log(`  Reason: ${decision.reason}`);
  }

  console.log("\n========================================\n");
}

export function logExecutionTargetsByGroup(
  evaluations: PositionGroupEvaluation[],
  baseExecutionTargets: BaseExecutionTargets,
  currentTime: Date,
  accountType: StrategyAccountType = "unknown",
): void {
  console.log("\n=== EXECUTION TARGETS BY GROUP ===");
  console.log(
    `Time-of-Day Base (shared): exp=${formatPercent(baseExecutionTargets.targetAccountExposure)}, dte=${baseExecutionTargets.targetDTE}, bid=${baseExecutionTargets.bidWeight.toFixed(2)}/mid=${baseExecutionTargets.midWeight.toFixed(2)}/ask=${baseExecutionTargets.askWeight.toFixed(2)}`,
  );
  console.log("Secret Socket: per-group by ticker (configured positions source key)");

  const manageAllocations = evaluations.filter(
    (e) => e.strategy.action === "MANAGE_ALLOCATION",
  );

  if (manageAllocations.length === 0) {
    console.log("No MANAGE_ALLOCATION groups to show.");
    console.log("===================================\n");
    return;
  }

  const { secondsSinceLastPositionsUpdate } = getSecretSocketStatus();
  const secretPositionsAge =
    secondsSinceLastPositionsUpdate === null
      ? "n/a"
      : `${secondsSinceLastPositionsUpdate.toFixed(1)}s`;

  for (const evaluation of manageAllocations) {
    const weightedAverageFill = evaluation.metrics.weightedAverageFill;
    const askReturnPerc =
      weightedAverageFill > 0
        ? (evaluation.metrics.currentAskPrice - weightedAverageFill) / weightedAverageFill
        : 0;
    const timeSinceLastActionMs =
      currentTime.getTime() - evaluation.metrics.lastActionTime.getTime();
    const timeSinceLastActionMinutes = timeSinceLastActionMs / (1000 * 60);

    const groupTargetComponents = buildGroupExecutionTargets({
      askReturnPerc,
      baseExecutionTargets,
      currentExposurePct: 0,
      currentTime,
      symbol: evaluation.underlyingSymbol,
      timeSinceLastActionMs,
    });
    const groupTargets = groupTargetComponents.positionGroupTargets;
    const secretBuyWeight = groupTargetComponents.secretBuyWeight;
    const secretSignals = groupTargetComponents.secretSignals;
    const secretGroupTargets = groupTargetComponents.secretExecutionTargets;
    const blendedTargets = groupTargetComponents.blendedTargets;

    console.log(`\n${evaluation.underlyingSymbol}`);
    console.log(
      `  Position Health: ask_return=${formatPercent(askReturnPerc)}, stale=${timeSinceLastActionMinutes.toFixed(1)}min`,
    );
    if (groupTargetComponents.noBuyGateActive) {
      console.log("  Group Targets (position-based): no-buy gate active");
    } else if (groupTargets) {
      console.log(
        `  Group Targets (position-based): exp=${formatPercent(groupTargets.targetAccountExposure)}, bid=${groupTargets.bidWeight.toFixed(2)}/mid=${groupTargets.midWeight.toFixed(2)}/ask=${groupTargets.askWeight.toFixed(2)}`,
      );
    } else {
      console.log("  Group Targets (position-based): unavailable because no position is open");
    }
    if (secretGroupTargets) {
      console.log(
        `  Secret Targets (ticker match): buyWeight=${secretBuyWeight ?? "n/a"}, daytradeScore=${secretSignals?.daytradeScore ?? "n/a"}, returnPerc=${secretSignals?.returnPerc ?? "n/a"}, superRecScore=${secretSignals?.superRecScore ?? "n/a"}, positionsAge=${secretPositionsAge}, exp=${formatPercent(secretGroupTargets.targetAccountExposure)}, bid=${secretGroupTargets.bidWeight.toFixed(2)}/mid=${secretGroupTargets.midWeight.toFixed(2)}/ask=${secretGroupTargets.askWeight.toFixed(2)}`,
      );
    } else {
      console.log("  Secret Targets (ticker match): unavailable for this symbol");
    }
    console.log(
      `  Blended (averaged): exp=${formatPercent(blendedTargets.targetAccountExposure)}, bid=${blendedTargets.bidWeight.toFixed(2)}/mid=${blendedTargets.midWeight.toFixed(2)}/ask=${blendedTargets.askWeight.toFixed(2)}`,
    );
    if (evaluation.executionTargets) {
      const gate = evaluation.executionTargets.positionGate;
      const surplusPct = evaluation.executionTargets.booleanSurplusPct ?? 0;
      if (gate) {
        const { signals } = gate;
        const surplusStr = surplusPct > 0 ? ` +${(surplusPct * 100).toFixed(0)}% surplus` : "";
        console.log(
          `  Position Gate:      crossAccountYes=${signals.crossAccountYes}, basicYes=${signals.basicStockYes}, strongYes=${signals.strongStockYes}, booleans=${signals.goodBooleanScore}/10${surplusStr}, maxTargetPct=${formatPercent(gate.maxTargetPct)}`,
        );
      }
      const baseBuyPct = getMaxBuyExposurePctForAccountType(accountType === "unknown" ? "cash" : accountType);
      const effectiveBuyPct = baseBuyPct + surplusPct;
      const maxBuyStr = surplusPct > 0
        ? `${formatPercent(baseBuyPct)} base + ${formatPercent(surplusPct)} surplus = ${formatPercent(effectiveBuyPct)}`
        : formatPercent(baseBuyPct);
      console.log(`  Max Buy/Action:     ${maxBuyStr}`);
      console.log(
        `  Final (post-caps):  exp=${formatPercent(evaluation.executionTargets.targetAccountExposure)}, bid=${evaluation.executionTargets.bidWeight.toFixed(2)}/mid=${evaluation.executionTargets.midWeight.toFixed(2)}/ask=${evaluation.executionTargets.askWeight.toFixed(2)}`,
      );
    }
  }

  console.log("\n===================================\n");
}
