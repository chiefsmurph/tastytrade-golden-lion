import fs from "node:fs";
import path from "node:path";

// Recovery still works by exiting for a PM2 restart — the SDK's
// quoteStreamer.disconnect() only drops listeners and leaks the underlying
// dxLink WebSocket, so an in-process reconnect would stack sessions and make
// "user sessions exceeded" errors worse. What changed: exits now back off.
// Each fatal within the window doubles the delay before exiting, and the
// timestamps persist to disk so the backoff survives the restart itself.
// Without this, a saturated session limit produced an exit → restart → new
// session → rejected → exit loop every couple of minutes (2026-07-02: 38
// restarts in one trading day).
const RESTART_WINDOW_MS = 30 * 60 * 1000;
const FIRST_RETRY_EXIT_DELAY_MS = 30_000;
const MAX_EXIT_DELAY_MS = 10 * 60 * 1000;

let restartScheduled = false;

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

function getExitDelayMs(recentRestartCount: number): number {
  if (recentRestartCount === 0) {
    return 250;
  }
  return Math.min(
    MAX_EXIT_DELAY_MS,
    FIRST_RETRY_EXIT_DELAY_MS * 2 ** (recentRestartCount - 1),
  );
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
function isFatalQuoteStreamerMessage(message: string): boolean {
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
function isFatalQuoteStreamerConsoleMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  if (normalized.includes("number of user sessions has exceeded the configured limit")) {
    return true;
  }
  return normalized.includes("dxlink") && isFatalQuoteStreamerMessage(normalized);
}

export function triggerQuoteStreamerRestart(reason: string, details?: unknown): void {
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
    process.exit(1);
  }, exitDelayMs);
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
