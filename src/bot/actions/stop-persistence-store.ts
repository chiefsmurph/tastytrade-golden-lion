import * as fs from "fs/promises";
import * as path from "path";

import { readEnvInt } from "~/core/env-utils";
import type { StrategyAccountType } from "~/strategy/evaluate-trading-strategy";

// Persistent "how many consecutive cycles has this group's stop trigger held?"
// memory for the stop-loss persistence gate (see src/strategy/stop-persistence.ts).
// The strategy engine is stateless per cycle, so without this every stop looks
// like a first sighting and the gate could never advance.
//
// One row per account + UNDERLYING::side, mirroring scale-out-store. The account
// prefix is not cosmetic: cash and margin routinely hold the same underlying, and
// a symbol-only key would let one book's quote noise arm the other book's stop.
//
// A streak is only meaningful if it came from the IMMEDIATELY PRECEDING cycle and
// from the SAME position, so a row is ignored when:
//   - it is older than the streak window (bot restart, market closed, group closed
//     and re-opened later) — see getStreakWindowMs;
//   - the live cost basis has drifted from the recorded one (the group was closed
//     and re-entered, or averaged into) — see WAF_DRIFT_TOLERANCE.
//
// Best-effort and NEVER throws. A store failure degrades to "no history", which
// defers the stop by one cycle rather than firing one early — the safe direction
// for a gate whose whole purpose is to not sell on a single noisy print.

interface StopStreakRow {
  accountType: StrategyAccountType;
  groupKey: string;
  streak: number;
  waf: number;
  at: string;
  atMs: number;
}

type StopStreakData = Record<string, StopStreakRow>;

// Same 5% tolerance as scale-out-store: a re-entry or a real add moves the cost
// basis well past this, while quote-driven WAF jitter does not move it at all.
// Persistence deferrals suppress adds, so a streak in progress should see a
// perfectly static WAF anyway; this is the re-entry guard, not a tuning knob.
const WAF_DRIFT_TOLERANCE = 0.05;

const DEFAULT_RUN_INTERVAL_MS = 4 * 60 * 1000;

function getRunIntervalMs(): number {
  return readEnvInt("BOT_RUN_INTERVAL_MS", DEFAULT_RUN_INTERVAL_MS, (n) => n > 0);
}

/**
 * How stale a row may be and still count as "the previous cycle". Generous
 * enough (2.5 intervals) that a slow cycle does not reset a legitimate streak,
 * tight enough that an overnight gap or a restart does.
 */
function getStreakWindowMs(): number {
  return Math.max(2.5 * getRunIntervalMs(), 5 * 60 * 1000);
}

/**
 * Minimum spacing between two observations that may ADVANCE the streak.
 *
 * getPositionEvaluations is called 5-6 times inside one cycle (run-cycle context
 * x3, the seeding pass x2, the allocation budget), and each call re-evaluates
 * every group. Without this, a single cycle would satisfy a 2-cycle requirement
 * on its own and the gate would be a no-op. Repeat observations inside the window
 * re-affirm the existing streak without incrementing it.
 */
function getStreakAdvanceMinMs(): number {
  return getRunIntervalMs() / 2;
}

/**
 * Does `row` already record the cycle being evaluated right now, rather than an
 * earlier one?
 *
 * This is the ONE definition of "same cycle", and it is deliberately shared by
 * both sides of the counter:
 *   - the WRITE (nextRow) must not advance the streak for a repeat observation;
 *   - the READ (getObservedStopCycles) must not count this cycle a second time.
 *
 * They were allowed to disagree once already, and it cost the whole feature: the
 * write debounced correctly and held the streak at 1, while the consumer added 1
 * unconditionally, so evaluation #2 of the very same cycle reached "2 of 2" and
 * the stop fired on the single quote persistence exists to reject. The gate
 * delayed by one EVALUATION, not by one CYCLE. Keep both callers on this one
 * predicate.
 */
function isSameCycleAsRow(row: StopStreakRow, now: number): boolean {
  return now - row.atMs < getStreakAdvanceMinMs();
}

function keyFor(accountType: StrategyAccountType, groupKey: string): string {
  return `${accountType}::${String(groupKey).trim().toUpperCase()}`;
}

function getStorePath(): string {
  const dataDir = process.env.BOT_DATA_DIR?.trim() || undefined;
  return path.join(
    dataDir ?? path.join(process.cwd(), "data"),
    "runs",
    "stop-persistence-state.json",
  );
}

async function readStore(): Promise<StopStreakData> {
  try {
    const raw = await fs.readFile(getStorePath(), "utf8");
    return JSON.parse(raw) as StopStreakData;
  } catch {
    return {};
  }
}

async function writeStore(data: StopStreakData): Promise<void> {
  const filePath = getStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function pruneExpired(data: StopStreakData, now: number): StopStreakData {
  const windowMs = getStreakWindowMs();
  const next: StopStreakData = {};
  for (const [key, row] of Object.entries(data)) {
    if (now - row.atMs <= windowMs) next[key] = row;
  }
  return next;
}

// Every group in the account is recorded in the same cycle, from a Promise.all.
// Read-modify-write on one JSON file races under that fan-out and would silently
// drop streaks, so all mutations run through a single chain.
let writeChain: Promise<unknown> = Promise.resolve();

function withStoreLock<T>(run: () => Promise<T>): Promise<T> {
  const next = writeChain.then(run, run);
  writeChain = next.catch(() => undefined);
  return next;
}

function isUsableRow(
  row: StopStreakRow | undefined,
  currentWaf: number,
  now: number,
): row is StopStreakRow {
  if (!row) return false;
  if (now - row.atMs > getStreakWindowMs()) return false;
  if (!(currentWaf > 0) || !(row.waf > 0)) return false;
  return Math.abs(row.waf - currentWaf) / currentWaf <= WAF_DRIFT_TOLERANCE;
}

/**
 * How many consecutive DISTINCT cycles this group's stop trigger will have held
 * once the evaluation happening at `now` is counted — i.e. the answer is already
 * INCLUSIVE of the current cycle, and is never less than 1.
 *
 * The inclusiveness is the whole point of the signature. Handing the caller a
 * "prior" count invites `prior + 1`, and that is only correct on the FIRST
 * evaluation of a cycle; on the 2nd through 6th it counts the same cycle twice.
 * Only the store knows which of those it is (it holds `atMs`), so the store does
 * the arithmetic and the consumer does none.
 *
 * Returns 1 when there is no usable history — a fresh group, a re-entry at a new
 * cost basis, a row from before a gap, or an unreadable store. That is the safe
 * direction: 1 defers a 2-cycle stop rather than firing it early.
 */
export async function getObservedStopCycles(
  accountType: StrategyAccountType,
  groupKey: string,
  currentWaf: number,
  now: number = Date.now(),
): Promise<number> {
  try {
    const data = await readStore();
    const row = data[keyFor(accountType, groupKey)];
    if (!isUsableRow(row, currentWaf, now)) return 1;
    const recordedCycles = Math.max(0, Math.trunc(Number(row.streak)) || 0);
    // Already counted this cycle (a repeat evaluation) => the recorded count IS
    // the observed count. A genuinely earlier cycle => this one is the next.
    return Math.max(
      1,
      isSameCycleAsRow(row, now) ? recordedCycles : recordedCycles + 1,
    );
  } catch {
    return 1;
  }
}

function nextRow(
  prior: StopStreakRow | undefined,
  accountType: StrategyAccountType,
  groupKey: string,
  waf: number,
  now: number,
): StopStreakRow {
  // Re-affirmation inside the same cycle keeps BOTH the streak and its timestamp,
  // so the next real cycle is still measured from the first sighting.
  if (prior && isSameCycleAsRow(prior, now)) {
    return { ...prior, waf };
  }
  return {
    accountType,
    groupKey,
    streak: (prior?.streak ?? 0) + 1,
    waf,
    at: new Date(now).toISOString(),
    atMs: now,
  };
}

async function applyStopTrigger(
  accountType: StrategyAccountType,
  groupKey: string,
  held: boolean,
  waf: number,
  now: number,
): Promise<void> {
  const data = await readStore();
  const key = keyFor(accountType, groupKey);
  const prior = data[key];

  if (!held) {
    if (!prior) return;
    delete data[key];
  } else {
    const usablePrior = isUsableRow(prior, waf, now) ? prior : undefined;
    data[key] = nextRow(usablePrior, accountType, groupKey, waf, now);
  }

  await writeStore(pruneExpired(data, now));
}

/**
 * Record this evaluation's verdict for the group. `held` true extends the streak
 * (subject to the intra-cycle debounce); `held` false drops the row entirely, so
 * a trigger that stops holding starts over from zero next time.
 */
export async function recordStopTrigger(
  accountType: StrategyAccountType,
  groupKey: string,
  held: boolean,
  waf: number,
  now: number = Date.now(),
): Promise<void> {
  await withStoreLock(async () => {
    try {
      await applyStopTrigger(accountType, groupKey, held, waf, now);
    } catch {
      // best-effort: a persist failure just means the next cycle sees no history
      // and defers the stop once more.
    }
  });
}

/** Drop a group's streak outright (position closed, or a deliberate reset). */
export async function clearStopStreak(
  accountType: StrategyAccountType,
  groupKey: string,
): Promise<void> {
  await withStoreLock(async () => {
    try {
      const data = await readStore();
      const key = keyFor(accountType, groupKey);
      if (!(key in data)) return;
      delete data[key];
      await writeStore(data);
    } catch {
      // best-effort
    }
  });
}
