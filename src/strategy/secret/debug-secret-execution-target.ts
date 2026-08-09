import { getTimeOfDayExecutionTargetsForPstTime as getTargetsForPstTime } from "~/strategy/evaluate-trading-strategy";
import { buildGroupExecutionTargets } from "~/strategy/group-execution-targets";
import {
  computePositionGate,
  countGoodBooleans,
  getBooleanSurplusPct,
  shouldSeedMarginFromBooleans,
  THESIS_MAX,
  type PositionGateResult,
} from "~/strategy/position-gate";
import { getCachedSecretSourcePositions } from "./secret-socket-state";
import type { SecretSourcePosition } from "./types";

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
  // The juicy part: the raw cached feed position and everything derived from it.
  secretPosition: SecretSourcePosition | null;
  derived: {
    goodBooleanScore: number;
    thesisMax: number;
    booleanSurplusPct: number;
    // Renamed from `wouldSeedMargin` 2026-08-08: the full-feed-thesis predicate
    // stopped being the margin auto-seed decision when that gate was removed
    // (see evaluateMarginSeedThesisGate), and a debug surface that answers a
    // question it is no longer being asked is worse than no answer.
    fullFeedThesis: boolean;
    positionGate: PositionGateResult;
  } | null;
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

  const normalizedSymbol = inputs.symbol.trim().toUpperCase();
  const secretPosition =
    getCachedSecretSourcePositions().find(
      (position) => String(position.ticker ?? "").trim().toUpperCase() === normalizedSymbol,
    ) ?? null;

  const derived = secretPosition
    ? {
        goodBooleanScore: countGoodBooleans(secretPosition),
        thesisMax: THESIS_MAX,
        booleanSurplusPct: getBooleanSurplusPct(countGoodBooleans(secretPosition)),
        fullFeedThesis: shouldSeedMarginFromBooleans(secretPosition),
        positionGate: computePositionGate({
          crossAccountAskReturnFraction: null,
          secretPosition,
          currentTime,
        }),
      }
    : null;

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
    secretPosition,
    derived,
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