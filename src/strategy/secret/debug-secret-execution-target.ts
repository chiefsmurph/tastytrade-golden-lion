import { getTimeOfDayExecutionTargetsForPstTime as getTargetsForPstTime } from "~/strategy/evaluate-trading-strategy";
import { buildGroupExecutionTargets } from "~/strategy/group-execution-targets";

export interface DebugSecretExecutionTargetInputs {
  askReturnPerc?: number;
  currentExposurePct?: number;
  currentTime?: Date;
  symbol: string;
  timeSinceLastActionMinutes?: number;
}

export interface DebugSecretExecutionTargetPayload {
  blendedTargets: ReturnType<typeof buildGroupExecutionTargets>["blendedTargets"];
  currentTime: string;
  debugInputs: {
    askReturnPerc: number;
    currentExposurePct: number;
    timeSinceLastActionMinutes: number;
  };
  finalPostCapsTargets: ReturnType<typeof buildGroupExecutionTargets>["finalPostCapsTargets"];
  noBuyGateActive: boolean;
  positionGroupTargets: ReturnType<typeof buildGroupExecutionTargets>["positionGroupTargets"];
  secretBuyWeight: number | null;
  secretExecutionTargets: ReturnType<typeof buildGroupExecutionTargets>["secretExecutionTargets"];
  symbol: string;
  timeOfDayTargets: ReturnType<typeof getTargetsForPstTime>;
}

function parseOptionalNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value ?? NaN) ? (value as number) : fallback;
}

export function buildDebugSecretExecutionTargetPayload(
  inputs: DebugSecretExecutionTargetInputs,
): DebugSecretExecutionTargetPayload {
  const currentTime = inputs.currentTime ?? new Date();
  const timeOfDayTargets = getTargetsForPstTime();
  const askReturnPerc = parseOptionalNumber(inputs.askReturnPerc, 0);
  const timeSinceLastActionMinutes = parseOptionalNumber(
    inputs.timeSinceLastActionMinutes,
    20,
  );
  const currentExposurePct = parseOptionalNumber(inputs.currentExposurePct, 0);
  const timeSinceLastActionMs = timeSinceLastActionMinutes * 60 * 1000;

  const groupTargetComponents = buildGroupExecutionTargets({
    askReturnPerc,
    baseExecutionTargets: timeOfDayTargets,
    currentExposurePct,
    currentTime,
    symbol: inputs.symbol,
    timeSinceLastActionMs,
  });

  return {
    blendedTargets: groupTargetComponents.blendedTargets,
    currentTime: currentTime.toISOString(),
    debugInputs: {
      askReturnPerc,
      currentExposurePct,
      timeSinceLastActionMinutes,
    },
    finalPostCapsTargets: groupTargetComponents.finalPostCapsTargets,
    noBuyGateActive: groupTargetComponents.noBuyGateActive,
    positionGroupTargets: groupTargetComponents.positionGroupTargets,
    secretBuyWeight: groupTargetComponents.secretBuyWeight,
    secretExecutionTargets: groupTargetComponents.secretExecutionTargets,
    symbol: inputs.symbol,
    timeOfDayTargets,
  };
}

export function logDebugSecretExecutionTargetPayload(
  payload: DebugSecretExecutionTargetPayload,
): void {
  console.log(
    JSON.stringify(
      {
        scope: "secret-execution-debug",
        ...payload,
      },
      null,
      2,
    ),
  );
}