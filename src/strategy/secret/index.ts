export {
	getCachedSecretSourcePositions,
	getCachedSecretRegime,
	getSecretSocketStatus,
	startSecretSocketConnection,
	getSecretPositionsSourceKey,
	emitSecretLog,
	flushPendingSecretLogs,
} from "./secret-socket-state";
export {
	getSecretBuyWeightForSymbol,
	getSecretPositionSignalsForSymbol,
	getSecretExecutionTargetForSymbol,
	getSecretExecutionTargetForRun,
} from "./secret-execution-target";
export {
	buildDebugSecretExecutionTargetPayload,
	logDebugSecretExecutionTargetPayload,
} from "./debug-secret-execution-target";
export {
	isAnySecretAutoSeedEnabled,
	maybeAutoSeedFromSecretPositions,
	maybeAutoSeedFromTickerRecs,
} from "./secret-auto-seed";
export type {
	DebugSecretExecutionTargetInputs,
	DebugSecretExecutionTargetPayload,
} from "./debug-secret-execution-target";
export type {
	SecretDataUpdatePayload,
	// fallow-ignore-next-line unused-type
	SecretRegime,
	SecretSourcePosition,
	SecretTickerRecPick,
	SecretTickerRecsUpdate,
} from "./types";
export type { SecretPositionSignals } from "./secret-execution-target";
