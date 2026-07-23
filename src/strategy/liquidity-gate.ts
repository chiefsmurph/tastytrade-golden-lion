// Account-aware entry liquidity gating (liquidity rollout step 2 — see
// docs/plans/2026-07-06-monday.md §4 and IMPROVEMENTS.v8 #1/#2/#5). Step 1
// shipped log-only liquidity fields (dayVolume/openInterest/bidSize/askSize/
// spreadPct on every chosen candidate); this module gates new entries on them.
//
// Why account-aware: the margin account is forced to flatten intraday (EOD
// liquidation arms ~12:50 PT), so it pays the spread on entry AND again on the
// forced exit into the bid. An ~18%-spread name (WEN, 2026-07-06, −$160.86) is
// born pre-stopped for margin, while cash can hold overnight and wait for a
// fair exit. Margin therefore gets its own, tighter entry-spread ceiling; cash
// keeps the shared gate.
//
// HARD RULE (do not weaken): unknown data degrades gracefully. A candidate
// whose open interest / volume / quote sizes are null or non-finite PASSES the
// gate, with the missing field recorded in `missingFields` and logged. Treating
// null as zero-liquidity would silently block every entry the moment a feed
// field changes shape — the IV-gate bug (null rank blocked all entries for
// months) in a new costume.
//
// Defaults are non-binding so deploying this changes nothing until opted in:
//   STRATEGY_MIN_OPEN_INTEREST=0                      (floor disabled)
//   STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT=<shared STRATEGY_MAX_OPTION_SPREAD_PCT>
//   STRATEGY_PHANTOM_QUOTE_GUARD_ENABLED=false        (detection still logged)
import { readEnvInt, readEnvPct, toBooleanFlag } from "~/core/env-utils";
import { getMaxOptionSpreadPct } from "~/strategy/entry-filters";
import { getMorningSpreadThresholdPct } from "~/strategy/spread-thresholds";

export type EntryAccountType = "margin" | "cash" | "unknown";

/** Minimum requested-side open interest for a new-entry candidate. 0 = off. */
export function getMinOpenInterest(): number {
  return readEnvInt("STRATEGY_MIN_OPEN_INTEREST", 0, (n) => n >= 0);
}

/**
 * Margin-only entry (buy-side) spread ceiling. Defaults to the shared
 * STRATEGY_MAX_OPTION_SPREAD_PCT so behavior is unchanged until it is set
 * tighter. Blank/zero/invalid values resolve to the shared gate, never NaN.
 */
export function getMarginMaxEntrySpreadPct(): number {
  const sharedMaxSpreadPct = getMaxOptionSpreadPct();
  const marginMaxSpreadPct = readEnvPct(
    "STRATEGY_MARGIN_MAX_ENTRY_SPREAD_PCT",
    sharedMaxSpreadPct,
  );
  return marginMaxSpreadPct > 0 ? marginMaxSpreadPct : sharedMaxSpreadPct;
}

/**
 * When enabled, a quote showing an explicit zero bid or ask size during market
 * hours invalidates that candidate's spread-gate pass for the cycle (the quoted
 * price has no depth behind it, so the spread number can't be trusted).
 * Missing/unknown sizes never trigger the guard — see the hard rule above.
 * Off by default; phantom detection is logged either way.
 */
export function isPhantomQuoteGuardEnabled(): boolean {
  return toBooleanFlag(process.env.STRATEGY_PHANTOM_QUOTE_GUARD_ENABLED);
}

/**
 * Account-aware analog of getMaxOptionSpreadPctForTime: the account's entry
 * ceiling (margin may be tighter) still capped by the morning spread ramp.
 * "cash" and "unknown" use the shared gate — an unknown account type must
 * never tighten behavior.
 */
export function getMaxEntrySpreadPctForAccountType(
  accountType: EntryAccountType,
  currentTime: Date,
): number {
  const accountCeiling =
    accountType === "margin" ? getMarginMaxEntrySpreadPct() : getMaxOptionSpreadPct();
  return Math.min(accountCeiling, getMorningSpreadThresholdPct(currentTime));
}

// Regular equities session by the local wall clock (the box is pinned to
// America/Los_Angeles — see getTimezoneWarning in startup-config): Mon–Fri,
// 6:30 AM to 1:00 PM PT. Used only by the phantom-quote guard, which must not
// fire on the NaN/absent sizes that stream while the market is closed.
const REGULAR_SESSION_OPEN_MINUTE = 6 * 60 + 30;
const REGULAR_SESSION_CLOSE_MINUTE = 13 * 60;

export function isRegularSessionByLocalClock(currentTime: Date): boolean {
  const dayOfWeek = currentTime.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return false;
  }

  const minuteOfDay = currentTime.getHours() * 60 + currentTime.getMinutes();
  return (
    minuteOfDay >= REGULAR_SESSION_OPEN_MINUTE &&
    minuteOfDay < REGULAR_SESSION_CLOSE_MINUTE
  );
}

export type LiquidityGateCheck = "spread" | "open-interest" | "phantom-quote";

export interface LiquidityGateInput {
  accountType: EntryAccountType;
  askSize: number | null | undefined;
  bidSize: number | null | undefined;
  currentTime?: Date;
  dayVolume?: number | null;
  /** Resolved via getMaxEntrySpreadPctForAccountType by the caller. */
  maxAllowedSpreadPct: number;
  openInterest: number | null | undefined;
  spreadPct: number;
}

export interface LiquidityGateDecision {
  accountType: EntryAccountType;
  askSize: number | null;
  bidSize: number | null;
  dayVolume: number | null;
  failedChecks: LiquidityGateCheck[];
  marketOpenByClock: boolean;
  maxAllowedSpreadPct: number;
  meetsSpreadRequirement: boolean;
  minOpenInterest: number;
  /** Fields that were unknown and therefore passed (graceful degradation). */
  missingFields: string[];
  openInterest: number | null;
  passed: boolean;
  /** Detected regardless of the guard toggle, so log-only observation works. */
  phantomQuote: boolean;
  phantomQuoteGuardEnabled: boolean;
  spreadPct: number;
}

function toFiniteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

export function evaluateLiquidityGate(input: LiquidityGateInput): LiquidityGateDecision {
  const currentTime = input.currentTime ?? new Date();
  const minOpenInterest = getMinOpenInterest();
  const phantomQuoteGuardEnabled = isPhantomQuoteGuardEnabled();
  const marketOpenByClock = isRegularSessionByLocalClock(currentTime);

  const askSize = toFiniteOrNull(input.askSize);
  const bidSize = toFiniteOrNull(input.bidSize);
  const dayVolume = toFiniteOrNull(input.dayVolume);
  const openInterest = toFiniteOrNull(input.openInterest);

  const failedChecks: LiquidityGateCheck[] = [];
  const missingFields: string[] = [];

  // Spread — pre-existing semantics (a no-quote Infinity spread fails, as it
  // always has), now against the account-aware ceiling.
  const meetsSpreadRequirement = input.spreadPct <= input.maxAllowedSpreadPct;
  if (!meetsSpreadRequirement) {
    failedChecks.push("spread");
  }

  // Open-interest floor — unknown OI passes with a note (hard rule).
  if (openInterest == null) {
    missingFields.push("openInterest");
  } else if (openInterest < minOpenInterest) {
    failedChecks.push("open-interest");
  }

  if (bidSize == null) {
    missingFields.push("bidSize");
  }
  if (askSize == null) {
    missingFields.push("askSize");
  }

  // Phantom-quote guard — only an EXPLICIT zero size during market hours counts
  // as sizeless; unknown sizes were already noted above and never trigger it.
  const phantomQuote =
    marketOpenByClock && (bidSize === 0 || askSize === 0);
  if (phantomQuote && phantomQuoteGuardEnabled) {
    failedChecks.push("phantom-quote");
  }

  return {
    accountType: input.accountType,
    askSize,
    bidSize,
    dayVolume,
    failedChecks,
    marketOpenByClock,
    maxAllowedSpreadPct: input.maxAllowedSpreadPct,
    meetsSpreadRequirement,
    minOpenInterest,
    missingFields,
    openInterest,
    passed: failedChecks.length === 0,
    phantomQuote,
    phantomQuoteGuardEnabled,
    spreadPct: input.spreadPct,
  };
}

export interface LiquidityGateLogContext {
  candidateSymbol?: string | null;
  side?: "call" | "put";
  /** Which entry path evaluated the gate, e.g. "chain-candidate". */
  source: string;
  underlyingSymbol?: string;
}

/**
 * One line per FAILED gate decision so the effect is auditable in the day's logs.
 * Passes are suppressed by default (only failures are interesting) — set
 * GL_VERBOSE_LIQUIDITY=1 to log every evaluation.
 */
export function logLiquidityGateDecision(
  context: LiquidityGateLogContext,
  decision: LiquidityGateDecision,
): void {
  if (decision.passed && process.env.GL_VERBOSE_LIQUIDITY !== "1") return;
  console.log(
    JSON.stringify({
      scope: "liquidity-gate",
      ...context,
      ...decision,
      // JSON has no Infinity; a no-quote spread serializes as null otherwise.
      spreadPct: Number.isFinite(decision.spreadPct) ? decision.spreadPct : null,
    }),
  );
}
