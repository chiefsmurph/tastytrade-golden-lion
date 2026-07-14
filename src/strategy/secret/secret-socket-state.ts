import fs from "node:fs";
import path from "node:path";
import { io } from "socket.io-client";
import { readEnvInt } from "~/core/env-utils";
import {
  isAnySecretAutoSeedEnabled,
  maybeAutoSeedFromSecretPositions,
  maybeAutoSeedFromTickerRecs,
} from "./secret-auto-seed";
import { logOptionsMirrorEval } from "./options-mirror-evaluator";
import {
  SecretDataUpdatePayload,
  SecretRegime,
  SecretSourcePosition,
  SecretTickerRecPick,
} from "./types";

const SECRET_SOCKET_EVENT = "server:data-update";

// The cache is plain module state, so a process restart used to blank it until
// the server's next push — minutes of "no boolean data" after every restart.
// Persist it to disk on each update and rehydrate on boot while still fresh.
const SECRET_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

function getSecretCacheFilePath(): string {
  const dataDir = process.env.BOT_DATA_DIR?.trim() || path.join(process.cwd(), "data");
  return path.join(dataDir, "secret-cache.json");
}

function persistSecretCacheToDisk(): void {
  try {
    const filePath = getSecretCacheFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({
        positions: cachedSourcePositions,
        positionsUpdatedAt: lastSecretPositionsUpdateAt?.toISOString() ?? null,
        tickerRecsPicks: cachedTickerRecsPicks,
        tickerRecsUpdatedAt: lastSecretTickerRecsUpdateAt?.toISOString() ?? null,
      }),
      "utf8",
    );
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[secret] failed to persist cache to disk: ${message}`);
  }
}

// Rehydrates caches and timestamps only — deliberately does not trigger
// auto-seeding, which should only react to live pushes.
function rehydrateSecretCacheFromDisk(): void {
  try {
    const raw = fs.readFileSync(getSecretCacheFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    const now = Date.now();

    const positionsUpdatedAt = Date.parse(parsed?.positionsUpdatedAt ?? "");
    if (
      Array.isArray(parsed?.positions) &&
      Number.isFinite(positionsUpdatedAt) &&
      now - positionsUpdatedAt <= SECRET_CACHE_MAX_AGE_MS
    ) {
      cachedSourcePositions = parsed.positions as SecretSourcePosition[];
      lastSecretPositionsUpdateAt = new Date(positionsUpdatedAt);
      console.log(
        `[secret] rehydrated ${cachedSourcePositions.length} cached positions from disk (age ${Math.round((now - positionsUpdatedAt) / 1000)}s)`,
      );
    }

    const tickerRecsUpdatedAt = Date.parse(parsed?.tickerRecsUpdatedAt ?? "");
    if (
      Array.isArray(parsed?.tickerRecsPicks) &&
      Number.isFinite(tickerRecsUpdatedAt) &&
      now - tickerRecsUpdatedAt <= SECRET_CACHE_MAX_AGE_MS
    ) {
      cachedTickerRecsPicks = parsed.tickerRecsPicks as SecretTickerRecPick[];
      lastSecretTickerRecsUpdateAt = new Date(tickerRecsUpdatedAt);
      console.log(
        `[secret] rehydrated ${cachedTickerRecsPicks.length} cached ticker-rec picks from disk (age ${Math.round((now - tickerRecsUpdatedAt) / 1000)}s)`,
      );
    }
  } catch {
    // Missing or unreadable cache file — start cold like before.
  }
}

let secretSocket: ReturnType<typeof io> | null = null;
let cachedSourcePositions: SecretSourcePosition[] = [];
let cachedTickerRecsPicks: SecretTickerRecPick[] = [];
let cachedRegime: SecretRegime | null = null;
let hasConnectedSecretSocket = false;
let secretSocketIsConnected = false;
let secretSocketIsAuthed = false;
let lastSecretPositionsUpdateAt: Date | null = null;
let lastSecretTickerRecsUpdateAt: Date | null = null;

export function getCachedSecretRegime(): SecretRegime | null {
  return cachedRegime;
}

// Log emits attempted before the server acks attemptAuth queue here and flush
// on the ack — the server drops client:act from unauthenticated sockets, so
// sending early loses the message. Bounded: notifications are best-effort.
const MAX_PENDING_SECRET_LOGS = 50;
const pendingSecretLogs: string[] = [];

export function getSecretPositionsSourceKey(): string | null {
  const configured = process.env.SECRET_DATA_UPDATE_POSITIONS_KEY?.trim();
  return configured && configured.length > 0 ? configured : null;
}

// A present-but-blank (or invalid) SECRET_SOCKET_TIMEOUT_MS falls back to the
// in-code default rather than returning null. Returning null used to make
// isSecretSocketConfigured() false, silently disabling the entire secret module
// even when the URL and source key were set (see .env.example default = 5000).
export function getSecretSocketTimeoutMs(): number {
  return readEnvInt("SECRET_SOCKET_TIMEOUT_MS", 5000, (n) => n > 0);
}

function isSecretSocketConfigured(): boolean {
  const socketUrl = process.env.SECRET_SOCKET_URL?.trim();
  return Boolean(socketUrl);
}

function isSecretModuleConfigured(): boolean {
  const sourceKey = getSecretPositionsSourceKey();
  return (
    isSecretSocketConfigured() &&
    (Boolean(sourceKey) || isAnySecretAutoSeedEnabled())
  );
}

// Tripwire: the thesis rollup is the SOLE score source (no legacy fallback
// since 2026-07-13). A position arriving without it scores 0 — safe but
// signal-blind — so make a feed regression loud instead of silent.
function warnOnMissingThesisRollup(positions: SecretSourcePosition[]): void {
  const missing = positions.filter(
    (position) =>
      !Number.isFinite(Number(position.manualThesisCount)) &&
      !Number.isFinite(Number(position.buyFraction)),
  );
  if (missing.length === 0) return;
  const tickers = missing.slice(0, 5).map((position) => position.ticker).join(", ");
  console.warn(
    `[secret] ${missing.length}/${positions.length} positions arrived WITHOUT thesis rollup fields (manualThesisCount/buyFraction) — they will score 0. Feed regression? Tickers: ${tickers}`,
  );
}

// fallow-ignore-next-line complexity
function updateCachedPositionsFromPayload(payload: SecretDataUpdatePayload): void {
  const sourceKey = getSecretPositionsSourceKey();
  if (!sourceKey) {
    return;
  }

  const sourcePositions = payload.positions?.[sourceKey];
  if (!Array.isArray(sourcePositions)) {
    return;
  }

  if (payload.regime && typeof payload.regime === "object") {
    cachedRegime = payload.regime;
  }

  cachedSourcePositions = sourcePositions as SecretSourcePosition[];
  lastSecretPositionsUpdateAt = new Date();
  persistSecretCacheToDisk();
  warnOnMissingThesisRollup(cachedSourcePositions);
  logOptionsMirrorEval(cachedSourcePositions, cachedRegime);

  void maybeAutoSeedFromSecretPositions(cachedSourcePositions);
}

function updateTickerRecsFromPayload(payload: SecretDataUpdatePayload): void {
  const rawTickerRecs = payload.tickerRecs;
  if (!rawTickerRecs || typeof rawTickerRecs !== "object") {
    return;
  }

  const picks = (rawTickerRecs as { picks?: unknown }).picks;
  if (!Array.isArray(picks)) {
    return;
  }

  cachedTickerRecsPicks = picks as SecretTickerRecPick[];
  lastSecretTickerRecsUpdateAt = new Date();
  persistSecretCacheToDisk();

  void maybeAutoSeedFromTickerRecs(cachedTickerRecsPicks);
}

export function startSecretSocketConnection(): void {
  if (hasConnectedSecretSocket) {
    return;
  }

  if (!isSecretModuleConfigured()) {
    return;
  }

  const socketUrl = process.env.SECRET_SOCKET_URL?.trim();
  const timeoutMs = getSecretSocketTimeoutMs();
  if (!socketUrl) {
    return;
  }

  rehydrateSecretCacheFromDisk();

  secretSocket = io(socketUrl, {
    reconnection: true,
    timeout: timeoutMs,
    transports: ["websocket"],
  });

  secretSocket.on(SECRET_SOCKET_EVENT, (payload: SecretDataUpdatePayload) => {
    updateCachedPositionsFromPayload(payload);
    updateTickerRecsFromPayload(payload);
  });

  secretSocket.on("connect", () => {
    secretSocketIsConnected = true;
    secretSocketIsAuthed = false;
    console.log("[secret] socket connected");
    // The server drops client:act (log emits, etc.) from unauthenticated
    // sockets, so emits must wait for the attemptAuth ack — auth on every
    // connect so reconnects re-authenticate too.
    const authKey = process.env.SECRET_SOCKET_AUTH_KEY?.trim();
    if (authKey && secretSocket) {
      secretSocket.emit("attemptAuth", authKey, (result: unknown) => {
        if (result === false) {
          console.warn("[secret] attemptAuth rejected — check SECRET_SOCKET_AUTH_KEY");
          return;
        }
        secretSocketIsAuthed = true;
        console.log("[secret] attemptAuth acked — flushing queued log emits:", pendingSecretLogs.length);
        flushPendingSecretLogs();
      });
    }
  });

  secretSocket.on("disconnect", (reason) => {
    secretSocketIsConnected = false;
    secretSocketIsAuthed = false;
    console.warn(`[secret] socket disconnected: ${reason}`);
  });

  secretSocket.on("connect_error", (error) => {
    secretSocketIsConnected = false;
    secretSocketIsAuthed = false;
    console.warn("[secret] socket connect_error", error?.message ?? error);
  });

  secretSocket.on("error", (error) => {
    console.warn("[secret] socket error", error);
  });

  hasConnectedSecretSocket = true;
}

// Push an operational log line back to the secret server over the live socket.
// Never throws — logging must not touch the trading path. Messages sent before
// the attemptAuth ack are queued (bounded) and flushed on the ack; with no
// auth key configured, sends immediately as before.
const SECRET_LOG_PREFIX = "tastytrade-golden-lion";

function isSecretAuthConfigured(): boolean {
  return Boolean(process.env.SECRET_SOCKET_AUTH_KEY?.trim());
}

// Emits are deliverable only on a connected socket that has either been acked
// by attemptAuth or needs no auth (no key configured) — the server drops
// client:act from unauthenticated sockets.
function isReadyToEmitSecretLog(): boolean {
  return Boolean(
    secretSocket &&
      secretSocketIsConnected &&
      (secretSocketIsAuthed || !isSecretAuthConfigured()),
  );
}

function sendSecretLogFrame(message: string): void {
  try {
    secretSocket?.emit("client:act", "log", message);
  } catch {
    // best-effort; swallow any transport error
  }
}

// Exported for tests; called from the attemptAuth ack in production.
export function flushPendingSecretLogs(): void {
  while (pendingSecretLogs.length > 0 && isReadyToEmitSecretLog()) {
    sendSecretLogFrame(pendingSecretLogs.shift()!);
  }
}

// Returns the actual outcome so callers (notify breadcrumbs) report truthfully:
// "sent" = emitted on an authed (or auth-less) connected socket; "queued" =
// held for the attemptAuth ack or reconnect.
export function emitSecretLog(message: string): "sent" | "queued" {
  const fullMessage = `${SECRET_LOG_PREFIX} ${message}`;

  if (!isReadyToEmitSecretLog()) {
    // Queue until the auth ack (or reconnect) — drop oldest past the cap.
    pendingSecretLogs.push(fullMessage);
    if (pendingSecretLogs.length > MAX_PENDING_SECRET_LOGS) {
      pendingSecretLogs.shift();
    }
    return "queued";
  }

  sendSecretLogFrame(fullMessage);
  return "sent";
}

export function getCachedSecretSourcePositions(): SecretSourcePosition[] {
  if (!isSecretModuleConfigured() || !getSecretPositionsSourceKey()) {
    return [];
  }

  return [...cachedSourcePositions];
}

export interface SecretSocketStatus {
  authed: boolean;
  cachedPositionsCount: number;
  cachedTickerRecsPicksCount: number;
  connected: boolean;
  hasConnected: boolean;
  pendingLogEmits: number;
  lastPositionsUpdateAt: string | null;
  lastTickerRecsUpdateAt: string | null;
  secondsSinceLastPositionsUpdate: number | null;
  secondsSinceLastTickerRecsUpdate: number | null;
  moduleEnabled: boolean;
  positionsSourceKey: string | null;
  socketTimeoutMs: number | null;
  socketUrlConfigured: boolean;
}

export function getSecretSocketStatus(): SecretSocketStatus {
  const now = Date.now();
  const socketUrlConfigured = Boolean(process.env.SECRET_SOCKET_URL?.trim());
  const positionsSourceKey = getSecretPositionsSourceKey();
  const socketTimeoutMs = getSecretSocketTimeoutMs();
  const moduleEnabled = isSecretModuleConfigured();

  return {
    authed: moduleEnabled ? secretSocketIsAuthed : false,
    cachedPositionsCount: moduleEnabled ? cachedSourcePositions.length : 0,
    cachedTickerRecsPicksCount: moduleEnabled ? cachedTickerRecsPicks.length : 0,
    connected: moduleEnabled ? secretSocketIsConnected : false,
    hasConnected: hasConnectedSecretSocket,
    pendingLogEmits: pendingSecretLogs.length,
    lastPositionsUpdateAt:
      moduleEnabled ? lastSecretPositionsUpdateAt?.toISOString() ?? null : null,
    lastTickerRecsUpdateAt:
      moduleEnabled ? lastSecretTickerRecsUpdateAt?.toISOString() ?? null : null,
    secondsSinceLastPositionsUpdate:
      moduleEnabled && lastSecretPositionsUpdateAt
        ? Math.max(0, (now - lastSecretPositionsUpdateAt.getTime()) / 1000)
        : null,
    secondsSinceLastTickerRecsUpdate:
      moduleEnabled && lastSecretTickerRecsUpdateAt
        ? Math.max(0, (now - lastSecretTickerRecsUpdateAt.getTime()) / 1000)
        : null,
    moduleEnabled,
    positionsSourceKey,
    socketTimeoutMs,
    socketUrlConfigured,
  };
}
