import fs from "node:fs";
import path from "node:path";
import { readEnvInt } from "./env-utils";
import {
  closeQuoteStreamerSession,
  reconnectQuoteStreamerSession,
} from "./quote-streamer-session";

// Recovery for fatal quote-streamer conditions, in two stages.
//
// Stage 1 (in-process): attempt reconnect-with-backoff via
// quote-streamer-session — close the old dxLink session cleanly, re-auth with
// a fresh quote token, rebuild the feed. A process exit is the wrong hammer
// for a session-limit fault: each restart opened a NEW dxLink session before
// the old one expired server-side, so restarts piled up sessions and
// re-triggered the "user sessions exceeded" kick (2026-07-06: 23 restarts).
// Attempts are capped (CORE_QUOTE_STREAMER_MAX_RECONNECT_ATTEMPTS, 0 disables)
// and reconnect rounds are rate-limited per window, so this can never become
// an infinite reconnect loop.
//
// Stage 2 (fallback, unchanged from before): exit for a PM2 restart. Each
// fatal within the window doubles the delay before exiting, and the
// timestamps persist to disk so the backoff survives the restart itself
// (2026-07-02: 38 restarts in one trading day without it). The session is now
// closed right before the exit so the restart doesn't inherit an orphaned
// server-side session.
const RESTART_WINDOW_MS = 30 * 60 * 1000;
const FIRST_RETRY_EXIT_DELAY_MS = 30_000;
const MAX_EXIT_DELAY_MS = 10 * 60 * 1000;
const PRE_EXIT_SESSION_CLOSE_FLUSH_MS = 250;

const FIRST_RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
// In-memory rate limit on reconnect rounds. If fatal conditions keep recurring
// right after "successful" reconnects (e.g. an external consumer saturates the
// session limit), stop reconnecting and fall back to the exit path, whose
// disk-persisted backoff takes over.
const MAX_RECONNECT_ROUNDS_PER_WINDOW = 3;
// Hard ceiling regardless of config — a huge attempt count would otherwise
// turn the round into an effectively infinite in-process reconnect loop.
const MAX_RECONNECT_ATTEMPTS_CEILING = 10;

let restartScheduled = false;
let reconnectRoundInProgress = false;
const recentReconnectRoundsAt: number[] = [];

export function getMaxQuoteStreamerReconnectAttempts(): number {
  const configured = readEnvInt(
    "CORE_QUOTE_STREAMER_MAX_RECONNECT_ATTEMPTS",
    3,
    (n) => n >= 0,
  );
  return Math.min(configured, MAX_RECONNECT_ATTEMPTS_CEILING);
}

function getRestartStateFilePath(): string {
  const dataDir = process.env.BOT_DATA_DIR?.trim() || path.join(process.cwd(), "data");
  return path.join(dataDir, "quote-streamer-restarts.json");
}

function readRecentRestartTimestamps(now: number): number[] {
  try {
    const raw = fs.readFileSync(getRestartStateFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && now - value <= RESTART_WINDOW_MS);
  } catch {
    return [];
  }
}

function recordRestartTimestamp(now: number, recent: number[]): void {
  try {
    const filePath = getRestartStateFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([...recent, now]), "utf8");
  } catch {
    // Backoff state is best-effort — never let bookkeeping block the restart.
  }
}

export function getExitDelayMs(recentRestartCount: number): number {
  if (recentRestartCount === 0) {
    return 250;
  }
  return Math.min(
    MAX_EXIT_DELAY_MS,
    FIRST_RETRY_EXIT_DELAY_MS * 2 ** (recentRestartCount - 1),
  );
}

export function getReconnectAttemptDelayMs(attempt: number): number {
  return Math.min(
    MAX_RECONNECT_DELAY_MS,
    FIRST_RECONNECT_DELAY_MS * 2 ** (Math.max(1, attempt) - 1),
  );
}

export function shouldAttemptInProcessReconnect(
  maxAttempts: number,
  recentRoundCount: number,
): boolean {
  return maxAttempts > 0 && recentRoundCount < MAX_RECONNECT_ROUNDS_PER_WINDOW;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Broad matcher for explicit call sites (market-data / option-service catch
// blocks), where we already know the error came from the quote streamer.
export function isFatalQuoteStreamerMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("unhandled dxlink error") ||
    normalized.includes("unauthorized") ||
    normalized.includes("number of user sessions has exceeded the configured limit") ||
    normalized.includes("message: 'bye'") ||
    normalized.includes('message: "bye"')
  );
}

// Strict matcher for the console guard, which sees every console.warn/error in
// the process. "unauthorized" alone must not kill the process here — a REST
// 401 logged by any other subsystem would otherwise trigger a restart. Require
// dxLink context unless the message is the unmistakable session-limit error.
export function isFatalQuoteStreamerConsoleMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  if (normalized.includes("number of user sessions has exceeded the configured limit")) {
    return true;
  }
  return normalized.includes("dxlink") && isFatalQuoteStreamerMessage(normalized);
}

/**
 * One reconnect round: up to maxAttempts in-process reconnects, each preceded
 * by an exponentially growing delay (gives the server time to reap the
 * cleanly-closed previous session). Returns true as soon as one succeeds.
 * The reconnect/sleep parameters are injection seams for tests.
 */
export async function runQuoteStreamerReconnectRound(
  reason: string,
  maxAttempts: number,
  reconnect: (reason: string) => Promise<boolean> = reconnectQuoteStreamerSession,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const delayMs = getReconnectAttemptDelayMs(attempt);
    console.warn(
      `[quote-streamer] in-process reconnect attempt ${attempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s (${reason})`,
    );
    await sleep(delayMs);

    try {
      if (await reconnect(reason)) {
        return true;
      }
    } catch (error) {
      console.warn(
        `[quote-streamer] reconnect attempt ${attempt}/${maxAttempts} threw: ${stringifyUnknown(error)}`,
      );
    }
  }

  return false;
}

function scheduleQuoteStreamerExitRestart(reason: string, details?: unknown): void {
  if (restartScheduled) {
    return;
  }

  restartScheduled = true;
  const now = Date.now();
  const recentRestarts = readRecentRestartTimestamps(now);
  const exitDelayMs = getExitDelayMs(recentRestarts.length);
  recordRestartTimestamp(now, recentRestarts);

  const extra = details == null ? "" : ` details=${stringifyUnknown(details)}`;
  console.error(
    `[quote-streamer] Fatal condition detected (${reason}). Exiting for PM2 restart in ${Math.round(exitDelayMs / 1000)}s (${recentRestarts.length} restarts in last ${RESTART_WINDOW_MS / 60000} min).${extra}`,
  );

  setTimeout(() => {
    // Close the dxLink session before exiting so the PM2 restart doesn't
    // inherit an orphaned server-side session; the brief pause lets the
    // WebSocket close frame flush.
    closeQuoteStreamerSession("pre-restart process exit");
    setTimeout(() => {
      process.exit(1);
    }, PRE_EXIT_SESSION_CLOSE_FLUSH_MS);
  }, exitDelayMs);
}

// fallow-ignore-next-line complexity
export function triggerQuoteStreamerRestart(reason: string, details?: unknown): void {
  if (restartScheduled || reconnectRoundInProgress) {
    return;
  }

  const now = Date.now();
  while (recentReconnectRoundsAt.length > 0 && now - recentReconnectRoundsAt[0] > RESTART_WINDOW_MS) {
    recentReconnectRoundsAt.shift();
  }

  const maxAttempts = getMaxQuoteStreamerReconnectAttempts();
  if (!shouldAttemptInProcessReconnect(maxAttempts, recentReconnectRoundsAt.length)) {
    scheduleQuoteStreamerExitRestart(reason, details);
    return;
  }

  reconnectRoundInProgress = true;
  recentReconnectRoundsAt.push(now);
  const extra = details == null ? "" : ` details=${stringifyUnknown(details)}`;
  console.error(
    `[quote-streamer] Fatal condition detected (${reason}). Attempting in-process dxLink reconnect (up to ${maxAttempts} attempts, round ${recentReconnectRoundsAt.length}/${MAX_RECONNECT_ROUNDS_PER_WINDOW} this window) before exit fallback.${extra}`,
  );

  void runQuoteStreamerReconnectRound(reason, maxAttempts)
    .then((recovered) => {
      reconnectRoundInProgress = false;
      if (!recovered) {
        scheduleQuoteStreamerExitRestart(`${reason} — in-process reconnect failed`, details);
      }
    })
    .catch((error) => {
      reconnectRoundInProgress = false;
      scheduleQuoteStreamerExitRestart(`${reason} — in-process reconnect errored`, error);
    });
}

export function restartOnFatalQuoteStreamerError(
  reason: string,
  errorLike: unknown,
): void {
  const message = stringifyUnknown(errorLike);
  if (isFatalQuoteStreamerMessage(message)) {
    triggerQuoteStreamerRestart(reason, errorLike);
  }
}

function joinConsoleArgs(args: unknown[]): string {
  return args.map((value) => stringifyUnknown(value)).join(" ");
}

export function installQuoteStreamerConsoleGuard(): void {
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.warn = (...args: unknown[]) => {
    const message = joinConsoleArgs(args);
    if (isFatalQuoteStreamerConsoleMessage(message)) {
      triggerQuoteStreamerRestart("console.warn dxLink fatal message", message);
    }
    originalWarn(...args);
  };

  console.error = (...args: unknown[]) => {
    const message = joinConsoleArgs(args);
    if (isFatalQuoteStreamerConsoleMessage(message)) {
      triggerQuoteStreamerRestart("console.error dxLink fatal message", message);
    }
    originalError(...args);
  };
}
