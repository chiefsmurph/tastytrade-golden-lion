import {
  applyPositionSizeWeightCaps,
  averageExecutionTargets,
  ExecutionTargets,
  getPositionGroupExecutionTargets,
} from "./evaluate-trading-strategy";
import {
  getSecretBuyWeightForSymbol,
  getSecretExecutionTargetForSymbol,
  getSecretPositionSignalsForSymbol,
  type SecretPositionSignals,
} from "./secret";

function getMaxAskReturnPercForBuy(): number | null {
  const raw = process.env.BOT_MAX_ASK_RETURN_PERC_FOR_BUY?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface GroupExecutionTargetInputs {
  askReturnPerc: number;
  baseExecutionTargets: ExecutionTargets;
  currentExposurePct: number;
  currentTime: Date;
  symbol: string;
  timeSinceLastActionMs: number;
}

export interface GroupExecutionTargetComponents {
  blendedTargets: ExecutionTargets;
  finalPostCapsTargets: ExecutionTargets;
  noBuyGateActive: boolean;
  positionGroupTargets: ExecutionTargets | null;
  secretBuyWeight: number | null;
  secretExecutionTargets: ExecutionTargets | null;
  secretSignals: SecretPositionSignals | null;
}

export function buildGroupExecutionTargets(
  inputs: GroupExecutionTargetInputs,
): GroupExecutionTargetComponents {
  const {
    askReturnPerc,
    baseExecutionTargets,
    currentExposurePct,
    currentTime,
    symbol,
    timeSinceLastActionMs,
  } = inputs;

  const positionGroupTargets = getPositionGroupExecutionTargets(
    askReturnPerc,
    timeSinceLastActionMs,
    currentTime,
  );

  // Resolve secret ticker match early so debug output still shows buyWeight
  // even when the no-buy gate is active.
  const secretBuyWeight = getSecretBuyWeightForSymbol(symbol);
  const secretSignals = getSecretPositionSignalsForSymbol(symbol);
  const secretExecutionTargets = getSecretExecutionTargetForSymbol({
    baseTargets: baseExecutionTargets,
    symbol,
  });

  const hardNoBuyGateActive =
    baseExecutionTargets.targetAccountExposure === 0 &&
    baseExecutionTargets.bidWeight === 0 &&
    baseExecutionTargets.midWeight === 0 &&
    baseExecutionTargets.askWeight === 0;

  if (hardNoBuyGateActive) {
    const zeroTargets: ExecutionTargets = {
      targetDTE: baseExecutionTargets.targetDTE,
      targetAccountExposure: 0,
      bidWeight: 0,
      midWeight: 0,
      askWeight: 0,
    };

    return {
      blendedTargets: zeroTargets,
      finalPostCapsTargets: zeroTargets,
      noBuyGateActive: true,
      positionGroupTargets: null,
      secretBuyWeight,
      secretExecutionTargets,
      secretSignals,
    };
  }

  const maxAskReturnPercForBuy = getMaxAskReturnPercForBuy();
  const highAskReturnNoBuyGateActive =
    maxAskReturnPercForBuy !== null && askReturnPerc > maxAskReturnPercForBuy;

  if (highAskReturnNoBuyGateActive) {
    const zeroTargets: ExecutionTargets = {
      targetDTE: baseExecutionTargets.targetDTE,
      targetAccountExposure: 0,
      bidWeight: 0,
      midWeight: 0,
      askWeight: 0,
    };

    return {
      blendedTargets: zeroTargets,
      finalPostCapsTargets: zeroTargets,
      noBuyGateActive: true,
      positionGroupTargets: null,
      secretBuyWeight,
      secretExecutionTargets,
      secretSignals,
    };
  }

  const hasOpenPosition = currentExposurePct > 0;
  const effectivePositionGroupTargets = hasOpenPosition ? positionGroupTargets : null;

  const blendedTargets = averageExecutionTargets(
    effectivePositionGroupTargets
      ? secretExecutionTargets
        ? [baseExecutionTargets, secretExecutionTargets, effectivePositionGroupTargets]
        : [baseExecutionTargets, effectivePositionGroupTargets]
      : secretExecutionTargets
        ? [baseExecutionTargets, secretExecutionTargets]
        : [baseExecutionTargets],
  );

  const finalPostCapsTargets = applyPositionSizeWeightCaps(
    blendedTargets,
    currentExposurePct,
  );

  return {
    blendedTargets,
    finalPostCapsTargets,
    noBuyGateActive: false,
    positionGroupTargets: effectivePositionGroupTargets,
    secretBuyWeight,
    secretExecutionTargets,
    secretSignals,
  };
}
