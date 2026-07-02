import { PositionGroupEvaluation } from "./evaluate-position";
import { ExecutionTargets } from "~/strategy/evaluate-trading-strategy";
import { closePosition, ClosePositionResult } from "./actions/close-position";
import { isOvernightPosition, getPositionAgeDays } from "./position-registry";
import { computeOvernightReductionTargetPct } from "~/strategy/overnight-reduction";

function computePartialCloseContracts(
  currentExposurePct: number,
  targetExposurePct: number,
  totalCapital: number,
  avgAskPrice: number,
): number {
  if (avgAskPrice <= 0 || totalCapital <= 0) return 0;
  const valueToSell = (currentExposurePct - targetExposurePct) * totalCapital;
  if (valueToSell <= 0) return 0;
  return Math.ceil(valueToSell / (avgAskPrice * 100));
}

export interface OvernightReductionOrder extends ClosePositionResult {
  reductionTargetPct: number;
  reductionContractsToClose: number;
}

export async function executeOvernightReductions(
  accountNumber: string,
  evaluations: readonly PositionGroupEvaluation[],
  sharedTargets: ExecutionTargets,
  totalCapital: number,
  alreadyClosingSymbols: ReadonlySet<string>,
  currentTime: Date,
): Promise<OvernightReductionOrder[]> {
  const results: OvernightReductionOrder[] = [];

  for (const evaluation of evaluations) {
    const symbol = String(evaluation.underlyingSymbol ?? "").toUpperCase();
    if (!symbol) continue;

    if (alreadyClosingSymbols.has(symbol)) continue;

    const overnight = await isOvernightPosition(accountNumber, symbol);
    if (!overnight) continue;

    const ageDays = await getPositionAgeDays(accountNumber, symbol);

    const totalQuantityWeight = evaluation.positionSnapshots.reduce(
      (sum, s) => sum + s.quantityWeight,
      0,
    );
    if (totalQuantityWeight <= 0) continue;

    const groupAskValue = evaluation.positionSnapshots.reduce(
      (sum, s) => sum + s.currentAskPrice * s.quantityWeight,
      0,
    );
    const currentExposurePct = totalCapital > 0 ? groupAskValue / totalCapital : 0;

    const signals = evaluation.executionTargets?.positionGate?.signals;
    const targetPct = computeOvernightReductionTargetPct(
      currentTime,
      currentExposurePct,
      signals,
      ageDays,
    );

    if (targetPct === null || currentExposurePct <= targetPct) continue;

    const avgAskPrice =
      totalQuantityWeight > 0 ? groupAskValue / totalQuantityWeight : 0;
    const contractsToClose = computePartialCloseContracts(
      currentExposurePct,
      targetPct,
      totalCapital,
      avgAskPrice,
    );

    if (contractsToClose <= 0) continue;

    console.log(
      JSON.stringify({
        scope: "overnight-position-reduction",
        symbol,
        accountNumber,
        ageDays,
        currentExposurePct: Number((currentExposurePct * 100).toFixed(2)),
        targetPct: Number((targetPct * 100).toFixed(2)),
        contractsToClose,
        signalOverride: signals?.crossAccountYes || signals?.strongStockYes || false,
        currentTime: currentTime.toISOString(),
      }),
    );

    const targets = evaluation.executionTargets ?? sharedTargets;
    const closeResults = await closePosition(accountNumber, evaluation, targets, {
      maxQuantityToClose: contractsToClose,
    });

    for (const r of closeResults) {
      results.push({
        ...r,
        reductionTargetPct: targetPct,
        reductionContractsToClose: contractsToClose,
      });
    }
  }

  return results;
}
