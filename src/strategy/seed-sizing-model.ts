/**
 * %-of-account seed sizing model (LIVE as of 2026-07-21).
 *
 * The seed path used to size every seed at a hard-coded `quantity: 1` contract
 * (see ~/bot/seed-symbol.ts). That meant the dollar size of a seed was an
 * ACCIDENT of the option's price: a $0.30 option → ~2% of a $1,650 account, a
 * $3.00 option → ~18%. Position size ended up a byproduct of option price, not
 * conviction.
 *
 * This module expresses seed size as a target % of account NLV (a notional
 * band) and converts that back to a whole contract count at the current option
 * price. seed-symbol.ts + seed-sizing-live.ts now consume it to drive the REAL
 * order quantity (floored to at least 1 contract, then clamped by concentration
 * + margin-utilization rails).
 *
 * The target % is a configurable FLOOR..CEILING band multiplied by two
 * PLUGGABLE, DEFAULT-NEUTRAL (1.0) inputs so separate work can feed them later
 * without touching this file:
 *   - regimeFavorability     (0..1) — how favorable the market posture is.
 *   - optionLiquidityQuality (0..1) — how tradeable the chosen contract is.
 * Both default to 1.0 (neutral passthrough → target sits at the ceiling), and
 * both are clamped to [0, 1] so a bad feed value can only shrink the target,
 * never inflate it past the ceiling.
 */

import { readEnvFraction } from "~/core/env-utils";

// Standard US equity-option contract multiplier (shares per contract). The
// seed path prices order cost as limitPrice × 100 everywhere else, so the
// %→contracts conversion uses the same unit.
export const OPTION_CONTRACT_MULTIPLIER = 100;

// Target band, as a FRACTION of account NLV (0.12 = 12%). The ceiling is the
// neutral-inputs target; the multipliers fade it down toward — but never below
// — the floor. Env-overridable via the existing SECRET_ prefix pattern.
//
// LIVE band (2026-07-21): floor 12% → ceiling 35%. readEnvFraction accepts the
// value written either way — `12`/`35` (percent) or `0.12`/`0.35` (fraction) —
// so a server .env with integer-looking `12`/`35` resolves correctly instead of
// the latent 1200% bug that a raw reader would produce once sizing goes live.
export function getSeedSizingFloorPct(): number {
  return readEnvFraction("SECRET_SEED_SIZING_FLOOR_PCT", 0.12);
}

export function getSeedSizingCeilingPct(): number {
  return readEnvFraction("SECRET_SEED_SIZING_CEILING_PCT", 0.35);
}

export interface SeedSizingInputs {
  // Account net-liquidating value (dollars) the % band is measured against.
  accountNLV: number;
  // The per-contract option price (dollars, e.g. mid or ask) the target
  // notional is converted into contracts at.
  optionPrice: number;
  // 0..1, default neutral (1.0). Clamped to [0, 1].
  regimeFavorability?: number;
  // 0..1, default neutral (1.0). Clamped to [0, 1].
  optionLiquidityQuality?: number;
  // Add-governor knife factor, 0..1 (default neutral 1.0). Fades the seed toward
  // the floor when the underlying is a falling knife; the account-aware posture
  // (margin hard / cash soft) is resolved by the caller into this single number.
  governorFactor?: number;
  // Optional band overrides (fractions of NLV). Default to the env-configured
  // floor/ceiling — passed explicitly only by tests / callers that already
  // resolved them.
  floorPct?: number;
  ceilingPct?: number;
}

export interface SeedSizingResult {
  // The resolved target as a fraction of NLV, after clamping to [floor, ceiling].
  modelTargetPct: number;
  // The target expressed in dollars (modelTargetPct × accountNLV).
  modelTargetNotional: number;
  // Whole contracts that fit inside modelTargetNotional at optionPrice.
  modelContracts: number;
  // The notional those whole contracts actually consume.
  modelContractsNotional: number;
  // Echoed, post-clamp inputs for the shadow log.
  floorPct: number;
  ceilingPct: number;
  regimeFavorability: number;
  optionLiquidityQuality: number;
}

// Clamp a pluggable 0..1 input to its contract. Out-of-contract values (NaN,
// Infinity, negative, > 1) collapse to the neutral default (1.0) rather than
// throwing or silently zeroing the target — a bad feed value must not be able
// to crush the model to zero contracts, only a genuine in-band value can fade
// it toward the floor.
export function clampFavorabilityInput(raw: number | undefined): number {
  if (raw === undefined) return 1;
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) return 1;
  return raw;
}

/**
 * Compute the %-of-account target and the whole-contract count it converts to.
 *
 * target% = ceiling × regimeFavorability × optionLiquidityQuality, clamped to
 * [floor, ceiling]. With neutral inputs (both 1.0) the target sits exactly at
 * the ceiling; each input fades it down, and the floor clamp guarantees a
 * conviction seed never shrinks below the floor band.
 */
export function computeSeedSizing(inputs: SeedSizingInputs): SeedSizingResult {
  const floorPct = inputs.floorPct ?? getSeedSizingFloorPct();
  // A misconfigured floor > ceiling would invert the band; keep the ceiling as
  // the hard upper bound and let the floor ride up to meet it (never above).
  const rawCeilingPct = inputs.ceilingPct ?? getSeedSizingCeilingPct();
  const ceilingPct = Math.max(rawCeilingPct, floorPct);

  const regimeFavorability = clampFavorabilityInput(inputs.regimeFavorability);
  const optionLiquidityQuality = clampFavorabilityInput(inputs.optionLiquidityQuality);
  const governorFactor = clampFavorabilityInput(inputs.governorFactor);

  const scaledPct = ceilingPct * regimeFavorability * optionLiquidityQuality * governorFactor;
  const modelTargetPct = Math.min(Math.max(scaledPct, floorPct), ceilingPct);

  const accountNLV = Number.isFinite(inputs.accountNLV) && inputs.accountNLV > 0
    ? inputs.accountNLV
    : 0;
  const modelTargetNotional = modelTargetPct * accountNLV;

  const costPerContract = inputs.optionPrice > 0
    ? inputs.optionPrice * OPTION_CONTRACT_MULTIPLIER
    : 0;
  // Whole contracts only — you cannot buy a fraction of a contract. A target
  // notional that cannot afford even one contract floors at 0 (the shadow log
  // then shows the model would also have declined at this price/band).
  const modelContracts = costPerContract > 0
    ? Math.floor(modelTargetNotional / costPerContract)
    : 0;
  const modelContractsNotional = modelContracts * costPerContract;

  return {
    modelTargetPct,
    modelTargetNotional,
    modelContracts,
    modelContractsNotional,
    floorPct,
    ceilingPct,
    regimeFavorability,
    optionLiquidityQuality,
  };
}
