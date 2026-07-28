import { getPstDateString } from "./day-report-store";

// Daily seed-rejection scoreboard.
//
// silver-lynx's cash & margin seed logic rejects seed attempts for many reasons
// (DTE-window-empty, no-chain, liquidity, cost, cooldown, gate) but the raw
// skippedReason strings only surface in per-cycle pm2 logs — there was no
// aggregate visibility, so a systematic rejection (e.g. both XXI and NXTC cash
// seeds skipped on "cash seed candidate DTE must be within 14-30" on 2026-07-21)
// was only discovered by grepping logs. This module buckets every seed attempt
// by a NORMALIZED rejection reason, per day per account, so the EOD day-report
// can show whether fixes actually convert rejections into fills.
//
// Follows the closing-only-cache pattern: module-level state + exported
// functions, no classes/`this`.

export type SeedRejectionBucket =
  | "placed"
  | "dte-empty"
  | "no-chain"
  | "liquidity"
  | "cost"
  | "cooldown"
  | "gate"
  | "other";

export type SeedRejectionScoreboard = Record<SeedRejectionBucket, number>;

const ALL_BUCKETS: readonly SeedRejectionBucket[] = [
  "placed",
  "dte-empty",
  "no-chain",
  "liquidity",
  "cost",
  "cooldown",
  "gate",
  "other",
];

function emptyScoreboard(): SeedRejectionScoreboard {
  return {
    placed: 0,
    "dte-empty": 0,
    "no-chain": 0,
    liquidity: 0,
    cost: 0,
    cooldown: 0,
    gate: 0,
    other: 0,
  };
}

// Ordered substring -> bucket rules. First match wins, so more specific
// buckets (dte-empty, no-chain) precede the broad ones (gate). The raw strings
// (from seed-symbol.ts and the seed-decision gate) change wording over time, so
// all matching lives here in this one table and the buckets stay stable even as
// messages are reworded.
const REJECTION_RULES: ReadonlyArray<readonly [string, SeedRejectionBucket]> = [
  // DTE-window misses: no candidate fit the cash seed DTE window.
  ["dte window", "dte-empty"],
  ["dte must be within", "dte-empty"],
  // No usable chain / candidate / quote on the underlying at all.
  ["no option candidate", "no-chain"],
  ["quote symbol unavailable", "no-chain"],
  ["quote unavailable", "no-chain"],
  ["no candidate", "no-chain"],
  // Spread / liquidity gate.
  ["spread", "liquidity"],
  ["liquid", "liquidity"], // also matches "illiquid"
  // Cost / buying-power / unfavorable-entry caps.
  ["seed order cost", "cost"],
  ["buying power", "cost"],
  ["unfavorable entry", "cost"],
  // Post-attempt cooldown suppressed the seed (recorded by the caller).
  ["cooldown", "cooldown"],
  // Upstream gate / entry filter rejected the seed before it was placed:
  // thesis / IV / plateau / crash-regime / hold gate / time-of-day strategy /
  // closing-only, existing position, etc.
  ["gate", "gate"],
  ["thesis", "gate"],
  ["plateau", "gate"],
  ["crash", "gate"],
  ["closing-only", "gate"],
  ["already has an open position", "gate"],
  ["strategy is not allowing", "gate"],
];

// Normalize a raw seed skippedReason / gate reason string into a stable bucket.
export function classifySeedRejection(reason: string | null | undefined): SeedRejectionBucket {
  const text = String(reason ?? "").toLowerCase();
  if (!text) {
    return "other";
  }
  for (const [needle, bucket] of REJECTION_RULES) {
    if (text.includes(needle)) {
      return bucket;
    }
  }
  return "other";
}

// account -> date (PST "YYYY-MM-DD") -> scoreboard.
const scoreboardByAccountDate = new Map<string, Map<string, SeedRejectionScoreboard>>();

function getOrCreateScoreboard(
  accountNumber: string,
  date: string,
): SeedRejectionScoreboard {
  const key = String(accountNumber ?? "").trim();
  let byDate = scoreboardByAccountDate.get(key);
  if (!byDate) {
    byDate = new Map();
    scoreboardByAccountDate.set(key, byDate);
  }
  let board = byDate.get(date);
  if (!board) {
    board = emptyScoreboard();
    byDate.set(date, board);
  }
  return board;
}

// Record one seed attempt against today's per-account scoreboard.
// - A placed order increments `placed`.
// - Otherwise the skippedReason is normalized into a rejection bucket.
export function recordSeedAttempt(
  accountNumber: string,
  result: { placedOrder?: boolean; skippedReason?: string | null },
  date: string = getPstDateString(),
): void {
  const board = getOrCreateScoreboard(accountNumber, date);
  if (result.placedOrder) {
    board.placed += 1;
    return;
  }
  board[classifySeedRejection(result.skippedReason)] += 1;
}

// Record a seed that was suppressed BEFORE seedSymbol ran (cooldown or gate),
// where there is no SeedSymbolResult — just a normalized reason string.
export function recordSeedSkip(
  accountNumber: string,
  reason: string,
  date: string = getPstDateString(),
): void {
  const board = getOrCreateScoreboard(accountNumber, date);
  board[classifySeedRejection(reason)] += 1;
}

// Snapshot today's (or a given date's) scoreboard for an account. Always
// returns a fresh, fully-populated object (zeros when nothing was recorded) so
// the day-report shape is stable.
export function getSeedRejectionScoreboard(
  accountNumber: string,
  date: string = getPstDateString(),
): SeedRejectionScoreboard {
  const board = scoreboardByAccountDate.get(String(accountNumber ?? "").trim())?.get(date);
  const snapshot = emptyScoreboard();
  if (board) {
    for (const bucket of ALL_BUCKETS) {
      snapshot[bucket] = board[bucket];
    }
  }
  return snapshot;
}

// Test hook: reset the module-level scoreboard between cases.
export function clearSeedRejectionScoreboard(): void {
  scoreboardByAccountDate.clear();
}
