/**
 * LIVE seed-sizing orchestration (2026-07-21).
 *
 * The %-of-account model (~/strategy/seed-sizing-model) turns a floor..ceiling
 * NLV band + optionLiquidityQuality into a target contract count. This module
 * turns that model output into the REAL order quantity a seed places, applying
 * — in order — the safety rails that all only ever REDUCE size:
 *
 *   1. model contracts (band × liquidity, floored to whole contracts)
 *   2. per-underlying concentration cap (quality-scaled, this account)
 *   3. combined cross-account concentration cap (cash + margin)
 *   4. total-margin-utilization ceiling (leverage rail, MARGIN account only)
 *   5. min-1 anti-regression floor: a seed that already passed its gate never
 *      places FEWER than 1 contract (never sizes DOWN vs the old quantity: 1),
 *      UNLESS a hard rail (margin ceiling / combined cap already breached) says
 *      it must place 0.
 *
 * EVERY limit is expressed as a PERCENT OF NLV — there is NO dollar/notional
 * knob anywhere in the seed path (the old BOT_MAX_SEED_ORDER_COST dollar clip
 * was retired 2026-07-21; the %-of-NLV ceiling + the %-of-account concentration
 * caps govern the size entirely). The only dollar figure that still bounds a
 * seed is the broker's real effective buying power, which is a hard constraint,
 * not a tunable knob.
 *
 * The seed GATES are untouched — this only sizes a seed that already qualified.
 * Regime favorability is intentionally left neutral (1.0): regime is Stage 2's
 * growth lever, not the seed. The only pluggable input threaded here is
 * optionLiquidityQuality.
 *
 * Conventions: module vars + exported fns, no classes / `this`; env via the
 * STRATEGY_ prefix pattern; the orchestration fn is PURE (exposures + NLV are
 * passed in) so it is unit-testable without the broker.
 */
import {
  computeSeedSizing,
  OPTION_CONTRACT_MULTIPLIER,
} from "~/strategy/seed-sizing-model";
import { evaluateConcentrationCaps } from "~/strategy/option-liquidity-quality";

// ---------------------------------------------------------------------------
// Env knobs.
// ---------------------------------------------------------------------------

// Total-margin-utilization ceiling (LEVERAGE RAIL). The summed market value of
// ALL open margin option positions may not exceed this multiple of margin NLV.
// Default 1.5 and ENFORCED BY DEFAULT — this is the 7/7 margin-call lesson
// (total leverage stacking, not one name). readEnvFraction is NOT used here:
// this is a leverage MULTIPLE (1.5×), not a percent-of-account, so it is read
// raw and only sanity-floored. The cash account is unlevered, so this rail
// applies to the margin account only.
export const DEFAULT_MARGIN_MAX_TOTAL_UTILIZATION = 1.5;

export function getMarginMaxTotalUtilization(): number {
  const raw = process.env.STRATEGY_MARGIN_MAX_TOTAL_UTILIZATION?.trim();
  if (!raw) return DEFAULT_MARGIN_MAX_TOTAL_UTILIZATION;
  const parsed = Number(raw);
  // A non-positive / non-finite value would disable the rail; refuse it and
  // fall back to the safe default so the rail is never accidentally off.
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MARGIN_MAX_TOTAL_UTILIZATION;
  return parsed;
}

// ---------------------------------------------------------------------------
// Orchestration (pure).
// ---------------------------------------------------------------------------

export interface ResolveSeedQuantityInput {
  /** Account net-liquidating value (NLV) the % band is measured against. */
  accountNLV: number;
  /** Per-contract option price (dollars) the target notional converts at. */
  optionPrice: number;
  /** optionLiquidityQuality (0..1) of the chosen candidate; undefined → neutral. */
  optionLiquidityQuality?: number;
  /** "margin" | "cash" — the margin-utilization rail applies to margin only. */
  accountType: "margin" | "cash" | "unknown";
  /** Concentration-cap basis (dollars) both %-caps are measured against. */
  concentrationBasis: number;
  /** Market value of THIS underlying already held in THIS account. */
  existingAccountExposure: number;
  /** Market value of THIS underlying held across BOTH accounts. */
  existingCombinedExposure: number;
  /**
   * MARGIN ONLY: summed market value of ALL open margin option positions
   * (the current total margin utilization, in dollars). Ignored for cash.
   */
  marginTotalOptionExposure?: number;
}

export interface ResolveSeedQuantityResult {
  /** Final whole-contract quantity to place (>= 0). */
  quantity: number;
  /** The model's pre-clamp contract count (band × liquidity). */
  modelContracts: number;
  /** Model target as a fraction of NLV, after the floor/ceiling clamp. */
  modelTargetPct: number;
  /** Per-order cost of the final quantity (price × 100 × quantity). */
  orderCost: number;
  /** Whether the min-1 anti-regression floor lifted the quantity to 1. */
  flooredToOne: boolean;
  /** Which rail (if any) bound the final quantity below the model. */
  bindingRail:
    | "model"
    | "per-underlying-cap"
    | "combined-cap"
    | "margin-utilization"
    | "blocked";
  /** Human-readable skip reason when quantity resolves to 0 (else undefined). */
  blockedReason?: string;
  // Echoed diagnostics for the live telemetry line.
  optionLiquidityQuality: number;
  perUnderlyingCapContracts: number;
  combinedCapContracts: number;
  marginUtilizationContracts: number;
}

// Whole contracts that fit inside a dollar headroom at this option price.
// A non-finite headroom (cap off) yields Infinity (no constraint).
function contractsForHeadroom(headroomDollars: number, costPerContract: number): number {
  if (!Number.isFinite(headroomDollars)) return Number.POSITIVE_INFINITY;
  if (!(costPerContract > 0)) return 0;
  return Math.max(0, Math.floor(headroomDollars / costPerContract));
}

// Contracts the total-margin-utilization ceiling permits (margin account only;
// Infinity — no constraint — for cash, which is unlevered).
function marginUtilizationContractsFor(
  input: ResolveSeedQuantityInput,
  costPerContract: number,
): number {
  if (input.accountType !== "margin") return Number.POSITIVE_INFINITY;
  const nlv =
    Number.isFinite(input.accountNLV) && input.accountNLV > 0 ? input.accountNLV : 0;
  const ceilingDollars = getMarginMaxTotalUtilization() * nlv;
  const rawUtil = input.marginTotalOptionExposure ?? 0;
  const currentUtil = Number.isFinite(rawUtil) && rawUtil > 0 ? rawUtil : 0;
  return contractsForHeadroom(Math.max(0, ceilingDollars - currentUtil), costPerContract);
}

type RailContracts = Array<[ResolveSeedQuantityResult["bindingRail"], number]>;

// The most-binding rail (lowest contract count) sets the pre-floor quantity.
function pickBindingRail(
  railContracts: RailContracts,
  modelContracts: number,
): { clamped: number; bindingRail: ResolveSeedQuantityResult["bindingRail"] } {
  let clamped = Number.POSITIVE_INFINITY;
  let bindingRail: ResolveSeedQuantityResult["bindingRail"] = "model";
  for (const [rail, contracts] of railContracts) {
    if (contracts < clamped) {
      clamped = contracts;
      bindingRail = rail;
    }
  }
  // Every rail off / unbounded (model is finite so this shouldn't happen) —
  // fall back to the model count.
  if (!Number.isFinite(clamped)) return { clamped: modelContracts, bindingRail: "model" };
  return { clamped, bindingRail };
}

interface FloorResult {
  quantity: number;
  flooredToOne: boolean;
  bindingRail: ResolveSeedQuantityResult["bindingRail"];
  blockedReason?: string;
}

// min-1 anti-regression floor. A qualified seed never places fewer than 1
// contract (never sizes DOWN vs the old quantity: 1) UNLESS a HARD rail demands
// 0 — a concentration cap already breached, the margin leverage ceiling already
// breached, or a per-order clip too small for even one contract. Those genuinely
// mean "do not add", so we honor the 0.
function applyMinOneFloor(
  clamped: number,
  bindingRail: ResolveSeedQuantityResult["bindingRail"],
  costPerContract: number,
  railContracts: RailContracts,
): FloorResult {
  if (clamped >= 1) return { quantity: clamped, flooredToOne: false, bindingRail };

  const hardZeroRail =
    bindingRail === "per-underlying-cap" ||
    bindingRail === "combined-cap" ||
    bindingRail === "margin-utilization";
  if (hardZeroRail && clamped === 0) {
    return {
      quantity: 0,
      flooredToOne: false,
      bindingRail: "blocked",
      blockedReason: describeBlock(bindingRail, railContracts),
    };
  }
  if (costPerContract <= 0) {
    return {
      quantity: 0,
      flooredToOne: false,
      bindingRail: "blocked",
      blockedReason: "no valid option price for seed sizing",
    };
  }
  // Model floored to 0 (band can't afford one at this price) but no hard rail
  // blocks a single contract → honor the anti-regression floor if every HARD
  // rail (caps / margin; not the model itself) has room for at least one.
  const canAffordOne = railContracts.every(
    ([rail, n]) => rail === "model" || n >= 1,
  );
  if (canAffordOne) {
    return { quantity: 1, flooredToOne: true, bindingRail: "model" };
  }
  return {
    quantity: 0,
    flooredToOne: false,
    bindingRail: "blocked",
    blockedReason: describeBlock("blocked", railContracts),
  };
}

/**
 * Resolve the final live seed quantity. Pure: all account state (NLV,
 * exposures, margin utilization) is passed in. Runs the model, then clamps by
 * each rail in turn, then applies the min-1 anti-regression floor.
 */
export function resolveSeedQuantity(
  input: ResolveSeedQuantityInput,
): ResolveSeedQuantityResult {
  const costPerContract =
    input.optionPrice > 0 ? input.optionPrice * OPTION_CONTRACT_MULTIPLIER : 0;

  // 1. Model contracts (regime neutral 1.0; only liquidity threaded).
  const sizing = computeSeedSizing({
    accountNLV: input.accountNLV,
    optionPrice: input.optionPrice,
    optionLiquidityQuality: input.optionLiquidityQuality,
  });
  const optionLiquidityQuality = sizing.optionLiquidityQuality;
  const modelContracts = sizing.modelContracts;

  // 2 + 3. Concentration caps (per-underlying + combined). Both only reduce.
  const caps = evaluateConcentrationCaps({
    quality: optionLiquidityQuality,
    accountBasis: input.concentrationBasis,
    existingAccountExposure: input.existingAccountExposure,
    existingCombinedExposure: input.existingCombinedExposure,
  });
  const perUnderlyingCapContracts = contractsForHeadroom(
    caps.perUnderlyingHeadroom,
    costPerContract,
  );
  const combinedCapContracts = contractsForHeadroom(
    caps.combinedHeadroom,
    costPerContract,
  );

  // 4. Total-margin-utilization ceiling (leverage rail; margin account only).
  const marginUtilizationContracts = marginUtilizationContractsFor(input, costPerContract);

  const railContracts: RailContracts = [
    ["model", modelContracts],
    ["per-underlying-cap", perUnderlyingCapContracts],
    ["combined-cap", combinedCapContracts],
    ["margin-utilization", marginUtilizationContracts],
  ];
  const { clamped, bindingRail } = pickBindingRail(railContracts, modelContracts);

  // 5. min-1 anti-regression floor.
  const floored = applyMinOneFloor(clamped, bindingRail, costPerContract, railContracts);

  return {
    quantity: floored.quantity,
    modelContracts,
    modelTargetPct: sizing.modelTargetPct,
    orderCost: floored.quantity * costPerContract,
    flooredToOne: floored.flooredToOne,
    bindingRail: floored.bindingRail,
    blockedReason: floored.blockedReason,
    optionLiquidityQuality,
    perUnderlyingCapContracts,
    combinedCapContracts,
    marginUtilizationContracts,
  };
}

function describeBlock(
  rail: ResolveSeedQuantityResult["bindingRail"],
  railContracts: Array<[ResolveSeedQuantityResult["bindingRail"], number]>,
): string {
  const zeroed = railContracts
    .filter(([, n]) => n < 1)
    .map(([name]) => name);
  switch (rail) {
    case "per-underlying-cap":
      return "seed blocked: per-underlying concentration cap leaves no room for 1 contract";
    case "combined-cap":
      return "seed blocked: combined cross-account concentration cap leaves no room for 1 contract";
    case "margin-utilization":
      return "seed blocked: total-margin-utilization ceiling leaves no room for 1 contract";
    default:
      return `seed blocked: no room for 1 contract (rails at 0: ${zeroed.join(", ") || "none"})`;
  }
}
