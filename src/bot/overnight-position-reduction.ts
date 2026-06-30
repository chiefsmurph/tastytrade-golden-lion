import { PositionGroupEvaluation } from "./evaluate-position";
import { ExecutionTargets } from "./evaluate-trading-strategy";
import { PositionGateSignals } from "./cash-position-gate";
import { closePosition, ClosePositionResult } from "./actions/close-position";
import { isOvernightPosition } from "./position-registry";

// 7:30am PT – 11:30am PT (minutes from midnight)
const REDUCTION_START_MINUTE = 7 * 60 + 30;
const REDUCTION_END_MINUTE = 11 * 60 + 30;

function getReductionFloorPct(): number {
  const raw = process.env.BOT_CASH_OVERNIGHT_REDUCTION_FLOOR_PCT?.trim();
  if (!raw) return 0.08;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0.08;
}

// Returns forced max exposure pct, or null if no reduction applies.
// Signals with crossAccountYes or strongStockYes override and pause reduction.
export function computeOvernightReductionTargetPct(
  currentTime: Date,
  currentExposurePct: number,
  signals: PositionGateSignals | undefined,
): number | null {
  if (signals?.crossAccountYes || signals?.strongStockYes) return null;

  const minuteOfDay = currentTime.getHours() * 60 + currentTime.getMinutes();
  if (minuteOfDay < REDUCTION_START_MINUTE) return null;

  const floor = getReductionFloorPct();
  if (currentExposurePct <= floor) return null;

  const t = Math.min(
    1,
    (minuteOfDay - REDUCTION_START_MINUTE) /
      (REDUCTION_END_MINUTE - REDUCTION_START_MINUTE),
  );

  // Linear ramp: at t=0 target equals current (no immediate sell), at t=1 target=floor
  const target = currentExposurePct * (1 - t) + floor * t;
  return Math.max(floor, target);
}

// Contracts needed to reduce exposure from current to target.
// Uses 100 multiplier (standard equity options).
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

    // Skip if already being closed this cycle
    if (alreadyClosingSymbols.has(symbol)) continue;

    // Only reduce overnight positions (opened before today)
    const overnight = await isOvernightPosition(accountNumber, symbol);
    if (!overnight) continue;

    // Compute current exposure
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
