import seedSymbol from "~/bot/seed-symbol";
import { SECRET_AUTO_SEED_ORDER_SOURCE } from "~/bot/order-sources";
import { isWithinSecretAutoSeedWindow } from "~/strategy/seeding-windows";
import { getCashAccountNumber, getMarginAccountNumber } from "~/core/default-account";
import { SecretRegime, SecretSourcePosition, SecretTickerRecPick } from "./types";
import { shouldSeedMarginFromBooleans, countGoodBooleans, getBooleanSurplusPct } from "~/strategy/position-gate";
import {
  CASH_ACCOUNT_SEED_MIN_DTE,
  CASH_ACCOUNT_SEED_MAX_DTE,
  NO_OPTION_CHAIN_SKIP_REASON,
} from "~/strategy/option-candidate";
import { recordPositionOpened } from "~/bot/position-registry";
import { recordSeedAttempt, recordSeedSkip } from "~/bot/seed-rejection-scoreboard";
import { readEnvPct, toBooleanFlag } from "~/core/env-utils";

const lastCashAutoSeedAtBySymbol = new Map<string, number>();
const lastMarginAllSignalsSeedAtBySymbol = new Map<string, number>();

// ── Outcome-aware cooldowns ─────────────────────────────────────────────────
// One flat post-attempt cooldown treated every outcome the same: a transient
// buying-power skip blocked retries for 10 min, while optionless names got a
// fresh chain walk every 10 min forever. Split by outcome instead:
//   placed       → the existing per-path cooldown map (10 min default).
//   no-chain     → very long, symbol-keyed. The underlying is not optionable at
//                  all (zero expirations anywhere) — a permanent property, so
//                  re-probing burns a full chain fetch for a name that can NEVER
//                  seed. Account-independent.
//   no-candidate → long, symbol-keyed (a chain exists but has no usable
//                  candidate — including DTE-window misses — account-independent
//                  and rarely changing intraday).
//   retry        → short, account+symbol-keyed (buying power, dry-run… are
//                  transient and account-specific).
const noChainSeedAtBySymbol = new Map<string, number>();
const noCandidateSeedAtBySymbol = new Map<string, number>();
const retrySeedAtByAccountSymbol = new Map<string, number>();

export type SeedOutcomeCooldownKind = "placed" | "no-chain" | "no-candidate" | "retry";

// Skip reasons from seed-symbol.ts meaning the underlying has no usable chain
// or candidate at all. These strings are matched verbatim.
//
// The two DTE-window reasons are here (long cooldown) rather than retry: since
// the DTE fallback shipped, a DTE miss means the widened 7-60 window ALSO
// failed — expirations don't appear intraday, so a 3-min retry just burns
// selection API calls. Built from the same constants seed-symbol interpolates
// so the verbatim match tracks any window change.
const NO_CANDIDATE_SKIP_REASONS = new Set([
  "no option candidate found",
  "candidate quote symbol unavailable",
  "candidate ask quote unavailable",
  "candidate mid quote unavailable",
  `no candidate found in cash seed DTE window ${CASH_ACCOUNT_SEED_MIN_DTE}-${CASH_ACCOUNT_SEED_MAX_DTE}`,
  `cash seed candidate DTE must be within ${CASH_ACCOUNT_SEED_MIN_DTE}-${CASH_ACCOUNT_SEED_MAX_DTE}`,
]);

// Pure classification of a seed attempt into which cooldown applies. The
// no-chain check precedes no-candidate: an underlying with zero expirations
// anywhere is permanently un-seedable (a distinct, longer bench) rather than a
// name whose chain merely lacks a candidate today.
export function classifySeedOutcomeCooldown(result: {
  placedOrder: boolean;
  skippedReason?: string | null;
}): SeedOutcomeCooldownKind {
  if (result.placedOrder) {
    return "placed";
  }
  if (result.skippedReason === NO_OPTION_CHAIN_SKIP_REASON) {
    return "no-chain";
  }
  if (NO_CANDIDATE_SKIP_REASONS.has(result.skippedReason ?? "")) {
    return "no-candidate";
  }
  return "retry";
}

// Exported for tests: true while ANY of the four cooldowns (placed / no-chain /
// no-candidate / retry) is still active for this symbol+account.
export function isAutoSeedCooldownActive(
  cooldownMap: Map<string, number>,
  symbol: string,
  accountNumber: string,
  now: number,
): boolean {
  const lastSeedAt = cooldownMap.get(symbol) ?? 0;
  if (now - lastSeedAt < getAutoSeedCooldownMs()) {
    return true;
  }
  const lastNoChainAt = noChainSeedAtBySymbol.get(symbol) ?? 0;
  if (now - lastNoChainAt < getNoChainCooldownMs()) {
    return true;
  }
  const lastNoCandidateAt = noCandidateSeedAtBySymbol.get(symbol) ?? 0;
  if (now - lastNoCandidateAt < getNoCandidateCooldownMs()) {
    return true;
  }
  const lastRetryAt = retrySeedAtByAccountSymbol.get(`${accountNumber}:${symbol}`) ?? 0;
  return now - lastRetryAt < getRetryCooldownMs();
}

// Exported for tests: stamps the map matching the classified outcome.
export function recordSeedOutcomeCooldown(
  kind: SeedOutcomeCooldownKind,
  cooldownMap: Map<string, number>,
  symbol: string,
  accountNumber: string,
  now: number,
): void {
  if (kind === "placed") {
    cooldownMap.set(symbol, now);
  } else if (kind === "no-chain") {
    noChainSeedAtBySymbol.set(symbol, now);
  } else if (kind === "no-candidate") {
    noCandidateSeedAtBySymbol.set(symbol, now);
  } else {
    retrySeedAtByAccountSymbol.set(`${accountNumber}:${symbol}`, now);
  }
}

// ── Sticky "full thesis observed today" memory ──────────────────────────────
// The feed's thesis flags flicker tick-to-tick, so requiring full thesis at
// the exact tick the margin branch runs almost never fires (~1×/day) even
// though several tickers reach full thesis at SOME point each day. Instead:
// remember every ticker that hit full thesis at any point today, and seed
// margin when the feed is actively buying (willBuy) a remembered name. The
// quality bar is unchanged — full thesis must still have been genuinely
// observed today. Rolls over on calendar-date change (stored date string, no
// timers).
const fullThesisObservedTickers = new Set<string>();
let fullThesisObservedDateStr: string | null = null;

function normalizeTicker(ticker: unknown): string {
  return String(ticker ?? "")
    .trim()
    .toUpperCase();
}

// Records every position currently at full thesis (thesisCount/thesisMax >= 1,
// same bar as shouldSeedMarginFromBooleans). Clears the memory first when
// dateStr differs from the stored day — yesterday's conviction doesn't carry.
export function recordFullThesisObservations(
  positions: SecretSourcePosition[],
  dateStr: string,
): void {
  if (fullThesisObservedDateStr !== dateStr) {
    fullThesisObservedTickers.clear();
    fullThesisObservedDateStr = dateStr;
  }

  for (const position of positions) {
    if (!shouldSeedMarginFromBooleans(position)) {
      continue;
    }
    const symbol = normalizeTicker(position.ticker);
    if (symbol) {
      fullThesisObservedTickers.add(symbol);
    }
  }
}

// Read-only query: true only when the memory is for the same day AND the
// ticker was recorded at full thesis.
export function wasFullThesisObservedToday(
  ticker: string,
  dateStr: string,
): boolean {
  return (
    fullThesisObservedDateStr === dateStr &&
    fullThesisObservedTickers.has(normalizeTicker(ticker))
  );
}

// The margin seed condition: full thesis observed today (sticky) AND the feed
// is actively buying this name right now (willBuy at the current tick).
export function shouldSeedMarginSticky(
  position: SecretSourcePosition,
  dateStr: string,
): boolean {
  return (
    position.willBuy === true &&
    wasFullThesisObservedToday(normalizeTicker(position.ticker), dateStr)
  );
}

function shouldAutoSeedOnSecretPositionsUpdate(): boolean {
  const raw =
    process.env.SECRET_AUTO_SEED_ON_POSITIONS_UPDATE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function shouldAutoSeedOnTickerRecsUpdate(): boolean {
  const raw =
    process.env.SECRET_AUTO_SEED_ON_TICKER_RECS_UPDATE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function isAnySecretAutoSeedEnabled(): boolean {
  return (
    shouldAutoSeedOnSecretPositionsUpdate() ||
    shouldAutoSeedOnTickerRecsUpdate()
  );
}

function readCooldownMs(key: string, fallbackMs: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) {
    return fallbackMs;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallbackMs;
  }

  return parsed;
}

function getAutoSeedCooldownMs(): number {
  return readCooldownMs("SECRET_AUTO_SEED_COOLDOWN_MS", 10 * 60 * 1000);
}

// Underlying has NO option chain at all (zero expirations anywhere) — it is not
// optionable, a property that effectively never changes intraday and rarely
// changes at all. Default 6h, which covers the whole 6:30am-1pm PT seed window
// so a name confirmed optionless once is probed at most once per session.
//
// Chosen 6h rather than "permanent" deliberately (conservative): the empty
// chain COULD, in principle, be a transient upstream fetch failure that
// returned `expirations: []` instead of a real "not optionable" answer. A 6h
// bench that resets across restarts (module-level map) errs toward re-probing a
// name that might become seedable, over permanently starving it — while still
// eliminating the per-tick re-fetch this was built to stop.
function getNoChainCooldownMs(): number {
  return readCooldownMs("SECRET_AUTO_SEED_NO_CHAIN_COOLDOWN_MS", 6 * 60 * 60 * 1000);
}

// A chain exists but has no usable candidate (spread/quote/DTE-window miss).
// Default 2h, not all-day: the seeding window is only 6:30am-1pm PT and
// small-cap option spreads/liquidity tighten as the session builds, so a
// morning "no candidate" deserves ~3 retries within the window rather than 1.
function getNoCandidateCooldownMs(): number {
  return readCooldownMs("SECRET_AUTO_SEED_NO_CANDIDATE_COOLDOWN_MS", 2 * 60 * 60 * 1000);
}

// Transient failures (buying power, closing-only, dry-run rejection).
function getRetryCooldownMs(): number {
  return readCooldownMs("SECRET_AUTO_SEED_RETRY_COOLDOWN_MS", 3 * 60 * 1000);
}

// Thesis floor for cash auto-seeds: isQualityToBuy alone fires on hundreds of
// feed ticks/day, so once seeding economics actually place orders that volume
// is real money. Require a minimum countGoodBooleans score on top — the scale
// is 0-10 manual thesis + 2 willBuy icing (see ~/strategy/position-gate).
function getCashSeedMinScore(): number {
  return readEnvPct("STRATEGY_CASH_SEED_MIN_SCORE", 3);
}

// Hold-conviction floor for cash auto-seeds: the cash account is the
// hold-conviction account — it owns names worth holding overnight (the feed
// itself goes flat at close; cash harvests the overnight edge the feed gave
// up). The run-cycle already hard-gates cash GROWTH on holdScore >= 0.45 +
// isOvernightEligible + no crashRegime, but seeds only checked isQualityToBuy
// + the thesis floor — a low-hold-conviction name could be seeded and then
// never grown (orphaned seed).
function getCashSeedMinHoldScore(): number {
  return readEnvPct("STRATEGY_CASH_SEED_MIN_HOLD_SCORE", 0.45);
}

// UNLIKE run-cycle's permissive-when-missing growth gate, a missing or
// non-numeric holdScore BLOCKS the seed — seeds are new money, and unknown
// hold conviction shouldn't tie up overnight capital (the feed emits holdScore
// on all positions, including stubs). isOvernightEligible blocks only when
// explicitly false; crashRegime blocks when explicitly true. The regime is
// passed in by the caller (secret-socket-state) rather than imported from it —
// that import would be a cycle (secret-socket-state already imports this file).
export function isCashSeedBlockedByHoldGate(
  position: Pick<SecretSourcePosition, "holdScore" | "isOvernightEligible" | "quantity">,
  regime: SecretRegime | null,
  minHoldScore: number = getCashSeedMinHoldScore(),
): boolean {
  // The feed's positions list includes zero-quantity CANDIDATE stubs (names it
  // is merely watching, and may never buy). Cash = "own what the feed actually
  // holds overnight" — a stub's holdScore is hypothetical, so cash requires the
  // feed to have real skin (quantity > 0). Margin deliberately does NOT require
  // this: its willBuy condition means the feed is buying the name this instant.
  if (!(Number(position.quantity) > 0)) {
    return true;
  }
  const holdScore = position.holdScore;
  if (typeof holdScore !== "number" || !Number.isFinite(holdScore) || holdScore < minHoldScore) {
    return true;
  }
  if (position.isOvernightEligible === false) {
    return true;
  }
  return regime?.crashRegime === true;
}

// Plateau entry gate for margin auto-seeds: plateauScore is the feed's 0-100
// "how flat" entry-quality metric, and the feed gates its own STOCK buys at
// >= 35 — buying calls into a vertical spike is strictly worse than buying
// stock into one.
function getMinPlateauScore(): number {
  return readEnvPct("SECRET_SEED_MIN_PLATEAU", 35);
}

// Crash-regime coherence for MARGIN auto-seeds (wired 2026-07-19): the cash
// seed path already blocks on crashRegime (inside isCashSeedBlockedByHoldGate),
// but margin seeds — new leverage into a sustained decline — had no crash
// check. Blocks only when the feed explicitly says crashRegime: true;
// missing/null regime passes.
export function isMarginSeedBlockedByCrashRegime(
  regime: SecretRegime | null,
): boolean {
  return regime?.crashRegime === true;
}

// Missing/non-numeric plateauScore is allowed — the field is not on every
// position the feed emits. (NaN also passes: NaN < threshold is false.)
export function isMarginSeedBlockedByPlateau(
  position: Pick<SecretSourcePosition, "plateauScore">,
  minPlateauScore: number = getMinPlateauScore(),
): boolean {
  return (
    typeof position.plateauScore === "number" &&
    position.plateauScore < minPlateauScore
  );
}

async function maybeAutoSeedSymbol(options: {
  symbol: string;
  side: "call" | "put";
  scope: string;
  accountNumber: string;
  cooldownMap: Map<string, number>;
  triggerReason?: string;
  goodBooleanScore?: number;
  booleanSurplusPct?: number;
}): Promise<void> {
  const now = Date.now();
  if (isAutoSeedCooldownActive(options.cooldownMap, options.symbol, options.accountNumber, now)) {
    recordSeedSkip(options.accountNumber, "seed suppressed by cooldown");
    return;
  }

  try {
    const result = await seedSymbol(options.symbol, options.side, options.accountNumber, {
      orderSource: SECRET_AUTO_SEED_ORDER_SOURCE,
      priceMode: "mid",
    });
    recordSeedAttempt(options.accountNumber, result);
    const cooldownKind = classifySeedOutcomeCooldown(result);
    recordSeedOutcomeCooldown(
      cooldownKind,
      options.cooldownMap,
      options.symbol,
      options.accountNumber,
      now,
    );
    if (cooldownKind === "placed") {
      await recordPositionOpened(options.accountNumber, options.symbol, options.side);
    }
    console.log(
      JSON.stringify({
        scope: options.scope,
        symbol: options.symbol,
        side: options.side,
        accountNumber: options.accountNumber,
        triggerReason: options.triggerReason ?? null,
        goodBooleanScore: options.goodBooleanScore ?? null,
        booleanSurplusPct: options.booleanSurplusPct ?? null,
        placedOrder: result.placedOrder,
        skippedReason: result.skippedReason ?? null,
        cooldownKind,
        candidateSymbol: result.candidateSymbol ?? null,
        usedItmFallback: result.usedItmFallback ?? false,
        limitPrice: result.limitPrice ?? null,
        estimatedOrderCost: result.estimatedOrderCost ?? null,
        timestamp: new Date(now).toISOString(),
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[${options.scope}] failed for ${options.symbol}: ${message}`);
  }
}

// Margin-side seed attempt for one position: sticky full-thesis trigger, then
// the plateau entry gate, then the seed itself.
async function maybeAutoSeedMarginForPosition(options: {
  position: SecretSourcePosition;
  symbol: string;
  side: "call" | "put";
  marginAccountNumber: string;
  observationDateStr: string;
  goodBooleanScore: number;
  booleanSurplusPct: number;
}): Promise<void> {
  if (!shouldSeedMarginSticky(options.position, options.observationDateStr)) {
    // Observe-only: surface the interesting near-miss — a name the feed is
    // actively buying (willBuy) that margin still won't seed because the full
    // 4/4 thesis was never observed today. Gated on willBuy so it stays quiet:
    // the sticky check runs for every position every tick, but only actively-
    // bought names are worth auditing (this is exactly the XXI-on-2026-07-21
    // case). fullThesisObservedToday is necessarily false here (sticky =
    // willBuy && thesisObserved), logged explicitly to make the reason obvious.
    if (options.position.willBuy === true) {
      console.log(
        JSON.stringify({
          scope: "secret-auto-seed-margin-sticky-block",
          symbol: options.symbol,
          willBuy: true,
          fullThesisObservedToday: wasFullThesisObservedToday(
            options.symbol,
            options.observationDateStr,
          ),
          plateauScore: options.position.plateauScore,
        }),
      );
    }
    return;
  }
  if (isMarginSeedBlockedByPlateau(options.position)) {
    console.log(
      JSON.stringify({
        scope: "secret-auto-seed-margin-plateau-block",
        symbol: options.symbol,
        plateauScore: options.position.plateauScore,
        minPlateauScore: getMinPlateauScore(),
      }),
    );
    return;
  }
  await maybeAutoSeedSymbol({
    symbol: options.symbol,
    side: options.side,
    scope: "secret-auto-seed-margin-all-signals",
    accountNumber: options.marginAccountNumber,
    cooldownMap: lastMarginAllSignalsSeedAtBySymbol,
    triggerReason: "secret-positions-update: full thesis observed today + willBuy",
    goodBooleanScore: options.goodBooleanScore,
    booleanSurplusPct: options.booleanSurplusPct,
  });
}

export async function maybeAutoSeedFromSecretPositions(
  sourcePositions: SecretSourcePosition[],
  regime: SecretRegime | null,
): Promise<void> {
  if (!shouldAutoSeedOnSecretPositionsUpdate()) {
    return;
  }

  // Record full-thesis observations on EVERY update tick, before any
  // filtering (including the seed window) — a flicker outside the window
  // still counts as "observed today" once the window opens.
  const observationDateStr = new Date().toDateString();
  recordFullThesisObservations(sourcePositions, observationDateStr);

  if (!isWithinSecretAutoSeedWindow(new Date())) {
    return;
  }

  const [cashAccountNumber, marginAccountNumber] = await Promise.all([
    getCashAccountNumber(),
    getMarginAccountNumber(),
  ]);
  const hasSeparateMarginAccount = marginAccountNumber !== cashAccountNumber;
  // Envelope-level, so computed once. Silent skip — this fires every tick
  // while the crash guard is up.
  const marginCrashBlocked = isMarginSeedBlockedByCrashRegime(regime);

  for (const position of sourcePositions) {
    const symbol = String(position.ticker ?? "")
      .trim()
      .toUpperCase();
    if (!symbol) {
      continue;
    }

    // The feed's `side` field is its broker's EQUITY side ("long"/"short"),
    // never "call"/"put" — the old normalizeSideForSeed read of it could not
    // match, so calls are what this path has always seeded.
    const side = "call" as const;
    const goodBooleanScore = countGoodBooleans(position);
    const booleanSurplusPct = getBooleanSurplusPct(goodBooleanScore);

    // Below-floor scores and hold-gate blocks skip silently — this fires
    // hundreds of times a day.
    if (
      toBooleanFlag(position.isQualityToBuy) &&
      goodBooleanScore >= getCashSeedMinScore() &&
      !isCashSeedBlockedByHoldGate(position, regime)
    ) {
      await maybeAutoSeedSymbol({
        symbol,
        side,
        scope: "secret-auto-seed-cash",
        accountNumber: cashAccountNumber,
        cooldownMap: lastCashAutoSeedAtBySymbol,
        triggerReason: "secret-positions-update: isQualityToBuy",
        goodBooleanScore,
        booleanSurplusPct,
      });
    }

    // Margin path is evaluated for every position (not gated on
    // isQualityToBuy): crash-regime block first, then sticky full-thesis
    // observation + current willBuy, then the plateau entry gate.
    if (hasSeparateMarginAccount && !marginCrashBlocked) {
      await maybeAutoSeedMarginForPosition({
        position,
        symbol,
        side,
        marginAccountNumber,
        observationDateStr,
        goodBooleanScore,
        booleanSurplusPct,
      });
    }
  }
}

export async function maybeAutoSeedFromTickerRecs(
  picks: SecretTickerRecPick[],
): Promise<void> {
  if (!shouldAutoSeedOnTickerRecsUpdate()) {
    return;
  }

  if (!isWithinSecretAutoSeedWindow(new Date())) {
    return;
  }

  const cashAccountNumber = await getCashAccountNumber();

  for (const pick of picks) {
    const symbol = String(pick.ticker ?? "")
      .trim()
      .toUpperCase();
    if (!symbol) {
      continue;
    }

    if (!toBooleanFlag(pick.shouldBuy)) {
      continue;
    }

    await maybeAutoSeedSymbol({
      symbol,
      side: "call",
      scope: "secret-auto-seed-ticker-recs",
      accountNumber: cashAccountNumber,
      cooldownMap: lastCashAutoSeedAtBySymbol,
    });
  }
}
