import { io } from "socket.io-client";
import {
  isAnySecretAutoSeedEnabled,
  maybeAutoSeedFromSecretPositions,
  maybeAutoSeedFromTickerRecs,
} from "./secret-auto-seed";
import {
  SecretDataUpdatePayload,
  SecretSourcePosition,
  SecretTickerRecPick,
} from "./types";

const SECRET_SOCKET_EVENT = "server:data-update";

let secretSocket: ReturnType<typeof io> | null = null;
let cachedSourcePositions: SecretSourcePosition[] = [];
let cachedTickerRecsPicks: SecretTickerRecPick[] = [];
let hasConnectedSecretSocket = false;
let secretSocketIsConnected = false;
let lastSecretPositionsUpdateAt: Date | null = null;
let lastSecretTickerRecsUpdateAt: Date | null = null;

export function getSecretPositionsSourceKey(): string | null {
  const configured = process.env.SECRET_DATA_UPDATE_POSITIONS_KEY?.trim();
  return configured && configured.length > 0 ? configured : null;
}

export function getSecretSocketTimeoutMs(): number | null {
  const raw = process.env.SECRET_SOCKET_TIMEOUT_MS?.trim();
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function isSecretSocketConfigured(): boolean {
  const socketUrl = process.env.SECRET_SOCKET_URL?.trim();
  const timeoutMs = getSecretSocketTimeoutMs();

  return Boolean(socketUrl) && timeoutMs != null;
}

function isSecretModuleConfigured(): boolean {
  const sourceKey = getSecretPositionsSourceKey();
  return (
    isSecretSocketConfigured() &&
    (Boolean(sourceKey) || isAnySecretAutoSeedEnabled())
  );
}

function updateCachedPositionsFromPayload(payload: SecretDataUpdatePayload): void {
  const sourceKey = getSecretPositionsSourceKey();
  if (!sourceKey) {
    return;
  }

  const sourcePositions = payload.positions?.[sourceKey];
  if (!Array.isArray(sourcePositions)) {
    return;
  }

  cachedSourcePositions = sourcePositions as SecretSourcePosition[];
  lastSecretPositionsUpdateAt = new Date();

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
  if (!socketUrl || timeoutMs == null) {
    return;
  }

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
    console.log("[secret] socket connected");
  });

  secretSocket.on("disconnect", (reason) => {
    secretSocketIsConnected = false;
    console.warn(`[secret] socket disconnected: ${reason}`);
  });

  secretSocket.on("connect_error", (error) => {
    secretSocketIsConnected = false;
    console.warn("[secret] socket connect_error", error?.message ?? error);
  });

  secretSocket.on("error", (error) => {
    console.warn("[secret] socket error", error);
  });

  hasConnectedSecretSocket = true;
}

export function getCachedSecretSourcePositions(): SecretSourcePosition[] {
  if (!isSecretModuleConfigured() || !getSecretPositionsSourceKey()) {
    return [];
  }

  return [...cachedSourcePositions];
}

export interface SecretSocketStatus {
  cachedPositionsCount: number;
  cachedTickerRecsPicksCount: number;
  connected: boolean;
  hasConnected: boolean;
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
    cachedPositionsCount: moduleEnabled ? cachedSourcePositions.length : 0,
    cachedTickerRecsPicksCount: moduleEnabled ? cachedTickerRecsPicks.length : 0,
    connected: moduleEnabled ? secretSocketIsConnected : false,
    hasConnected: hasConnectedSecretSocket,
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
