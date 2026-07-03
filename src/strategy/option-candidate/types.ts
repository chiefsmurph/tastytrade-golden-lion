import { ProgrammaticAction } from "~/strategy/evaluate-trading-strategy";
export type { OptionMarketSnapshotCacheStats } from "~/core/market-snapshot";

export interface TopOptionCandidateForSymbolResult {
  askPrice?: number;
  askSize?: number;
  bidPrice?: number;
  bidSize?: number;
  openInterest?: number; // requested side's OI (standing depth, distinct from day volume)
  "call-streamer-symbol"?: string;
  call?: string;
  dte?: number;
  ivRank?: number;
  ivx?: number;
  maxAllowedSpreadPct?: number;
  maxDTE?: number;
  meetsSpreadRequirement?: boolean;
  meetsVolumeRequirement?: boolean;
  minDTE?: number;
  preferredDTE?: number;
  "put-streamer-symbol"?: string;
  put?: string;
  quoteSymbol?: string;
  requestedSide?: "call" | "put";
  skippedByIvGate?: boolean;
  skippedReason?: string;
  spread?: number;
  spreadPct?: number;
  strategy?: ProgrammaticAction;
  streamerSymbol?: string;
  symbol?: string;
  usedDteFallback?: boolean;
}

export interface OptionHealthCandidateResult {
  candidate?: TopOptionCandidateForSymbolResult;
  targetDTE: number;
}

export interface OptionHealthSummary {
  fallbackTargets: number[];
  healthyTargets: number[];
  missingTargets: number[];
  wideSpreadTargets: number[];
}

export interface OptionHealthGateDecision {
  missingRequiredTargets: number[];
  passed: boolean;
  requiredHealthyTargets: number[];
  targetDTE: number;
}

export interface OptionHealthForSymbolResult {
  canOpenNewPosition: boolean;
  eligibility: OptionHealthGateDecision;
  requestedSide: "call" | "put";
  symbol: string;
  summary: OptionHealthSummary;
  targetDTE: number;
  targets: Record<string, TopOptionCandidateForSymbolResult | undefined>;
}

export interface TopOptionCandidateForAccountResult extends TopOptionCandidateForSymbolResult {
  accountNumber: string;
  accountType: "margin" | "cash" | "unknown";
  estimatedOrderCost: number | null;
  buyingPower: {
    effectiveBuyingPower: number;
    buyingPowerRemaining: number;
    exposureHeadroom: number;
    targetExposurePct: number;
    currentExposurePct: number;
    totalCapital: number;
  };
  wouldPassBuyingPowerCheck: boolean | null;
}
