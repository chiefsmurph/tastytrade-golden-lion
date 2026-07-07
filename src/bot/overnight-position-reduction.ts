import { PositionGroupEvaluation } from "./evaluate-position";
import { ExecutionTargets } from "~/strategy/evaluate-trading-strategy";
import { closePosition, ClosePositionResult } from "./actions/close-position";
import { isOvernightPosition, getPositionAgeDays } from "./position-registry";
import { computeOvernightReductionTargetPct } from "~/strategy/overnight-reduction";
import { OVERNIGHT_REDUCTION_ORDER_SOURCE } from "./order-sources";

// Cash accumulation cutoff: 1:00 PM PT (same as getNoBuyCutoffMinute("cash")).
// Overnight reductions placed after this time serve no purpose — the window
// closes at 11:30 AM and new buys stop at 1:00 PM, so any remaining exposure
// will be held until the next day regardless.
const CASH_ACCUMULATION_CUTOFF_MINUTE = 13 * 60;

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
  liveOvernightReductionSymbols: ReadonlySet<string> = new Set(),
): Promise<OvernightReductionOrder[]> {
  // Skip overnight reductions entirely after the cash accumulation cutoff
  // (1:00 PM PT). The reduction window closes at 11:30 AM; placing orders
  // beyond 1:00 PM just generates noise that will never fill.
  const minuteOfDay = currentTime.getHours() * 60 + currentTime.getMinutes();
  if (minuteOfDay >= CASH_ACCUMULATION_CUTOFF_MINUTE) {
    return [];
  }

  const results: OvernightReductionOrder[] = [];

  for (const evaluation of evaluations) {
    const symbol = String(evaluation.underlyingSymbol ?? "").toUpperCase();
    if (!symbol) continue;

    if (alreadyClosingSymbols.has(symbol)) continue;

    // A live overnight-reduction order for this symbol is already working —
    // skip placing a duplicate. The order was placed in a prior cycle and
    // protected from the cancel sweep; let it fill or expire naturally.
    if (liveOvernightReductionSymbols.has(symbol)) {
      console.log(
        JSON.stringify({
          scope: "overnight-position-reduction",
          symbol,
          accountNumber,
          message: "skipped — live overnight reduction order already working",
          currentTime: currentTime.toISOString(),
        }),
      );
      continue;
    }

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

    const closeResults = await closePosition(accountNumber, evaluation, {
      maxQuantityToClose: contractsToClose,
      orderSource: OVERNIGHT_REDUCTION_ORDER_SOURCE,
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
