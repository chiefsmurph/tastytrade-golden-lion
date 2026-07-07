// Every cycle through this module routes via tastytrade-client's lazy
// `await import()` hub (benign per FALLOW.md).
// fallow-ignore-file circular-dependencies
import {
  DXLinkAuthState,
  DXLinkConnectionState,
  DXLinkFeed,
  DXLinkWebSocketClient,
  FeedContract,
  FeedDataFormat,
} from "@dxfeed/dxlink-api";
import tastytradeApi from "./tastytrade-client";

// Owns the dxLink quote-streamer session for the whole process.
//
// The SDK's quoteStreamer.connect() creates a DXLinkWebSocketClient as a local
// variable and never retains it, so quoteStreamer.disconnect() only drops
// listeners — the WebSocket keeps its keepalive/reconnect loop running and the
// server-side dxLink session lives on as a zombie. Every extra connect() call
// stacked one more session until the account hit "the number of user sessions
// has exceeded the configured limit" (2026-07-06: 60 UNAUTHORIZED kicks, 23
// process restarts). This module replicates the SDK's tiny connect() with the
// same @dxfeed/dxlink-api primitives but keeps the client reference, so the
// session can be closed for real — on graceful shutdown, before a watchdog
// process exit, and between in-process reconnect attempts.
//
// Parity note: openQuoteStreamerSession() mirrors QuoteStreamer.connect() in
// @tastytrade/api (feed accept config, listener re-attachment, dxLinkFeed /
// dxLinkUrl / dxLinkAuthToken assignment) so every existing
// tastytradeApi.quoteStreamer.subscribe()/addEventListener() call site keeps
// working unchanged against the managed feed.

type FeedEventListener = (events: unknown[]) => void;

export interface DxLinkClientLike {
  connect(url: string): void;
  setAuthToken(token: string): void;
  disconnect(): void;
  getConnectionState(): string;
  getAuthState(): string;
}

/** createFeed returns the feed already configured (accept config applied). */
export interface DxLinkFeedLike {
  addEventListener(listener: FeedEventListener): void;
  close(): void;
}

export interface QuoteStreamerLike {
  dxLinkFeed: unknown;
  dxLinkUrl: string | null;
  dxLinkAuthToken: string | null;
  eventListeners: FeedEventListener[];
}

export interface QuoteStreamerSessionDeps {
  fetchQuoteToken(): Promise<{ url: string; token: string }>;
  createClient(): DxLinkClientLike;
  createFeed(client: DxLinkClientLike): DxLinkFeedLike;
  getQuoteStreamer(): QuoteStreamerLike;
}

// The dxLink client retries a dropped transport on its own. The SDK left it
// unbounded (-1); bound it so a dead session can never self-reconnect forever
// — sustained faults surface as zero events and are handled by the watchdog.
const DXLINK_CLIENT_MAX_TRANSPORT_RECONNECTS = 3;

const AUTHORIZED_POLL_INTERVAL_MS = 100;
const DEFAULT_AUTHORIZED_WAIT_MS = 15_000;

/** Same fields the SDK's QuoteStreamer.connect() reads off getApiQuoteToken(). */
export function parseQuoteTokenResponse(tokenResponse: unknown): {
  url: string;
  token: string;
} {
  const record = (tokenResponse ?? {}) as Record<string, unknown>;
  const url = record["dxlink-url"];
  const token = record["token"];
  if (typeof url !== "string" || url.length === 0 || typeof token !== "string" || token.length === 0) {
    throw new Error("getApiQuoteToken returned no dxlink-url/token");
  }
  return { url, token };
}

function buildDefaultDeps(): QuoteStreamerSessionDeps {
  return {
    async fetchQuoteToken() {
      const tokenResponse =
        await tastytradeApi.accountsAndCustomersService.getApiQuoteToken();
      return parseQuoteTokenResponse(tokenResponse);
    },
    createClient() {
      return new DXLinkWebSocketClient({
        maxReconnectAttempts: DXLINK_CLIENT_MAX_TRANSPORT_RECONNECTS,
      });
    },
    createFeed(client) {
      const feed = new DXLinkFeed(
        client as unknown as ConstructorParameters<typeof DXLinkFeed>[0],
        FeedContract.AUTO,
      );
      feed.configure({
        acceptAggregationPeriod: 10,
        acceptDataFormat: FeedDataFormat.COMPACT,
      });
      return feed as unknown as DxLinkFeedLike;
    },
    getQuoteStreamer() {
      return tastytradeApi.quoteStreamer as unknown as QuoteStreamerLike;
    },
  };
}

let deps: QuoteStreamerSessionDeps | null = null;
let activeClient: DxLinkClientLike | null = null;
let activeFeed: DxLinkFeedLike | null = null;
let connectPromise: Promise<void> | null = null;

function getDeps(): QuoteStreamerSessionDeps {
  deps ??= buildDefaultDeps();
  return deps;
}

/** Test seam: pass full fake deps, or null to restore the real ones. Resets session state. */
export function setQuoteStreamerSessionDepsForTesting(
  testDeps: QuoteStreamerSessionDeps | null,
): void {
  deps = testDeps;
  activeClient = null;
  activeFeed = null;
  connectPromise = null;
}

export function isQuoteStreamerSessionActive(): boolean {
  return activeClient != null && activeFeed != null;
}

async function openQuoteStreamerSession(): Promise<void> {
  const d = getDeps();
  const { url, token } = await d.fetchQuoteToken();

  const client = d.createClient();
  try {
    client.connect(url);
    client.setAuthToken(token);

    const feed = d.createFeed(client);
    const streamer = d.getQuoteStreamer();
    for (const listener of streamer.eventListeners) {
      feed.addEventListener(listener);
    }

    streamer.dxLinkFeed = feed;
    streamer.dxLinkUrl = url;
    streamer.dxLinkAuthToken = token;
    activeClient = client;
    activeFeed = feed;
  } catch (error) {
    // Never leak a half-open client: it would keep the server-side session
    // alive with keepalives — the exact pileup this module exists to stop.
    try {
      client.disconnect();
    } catch {}
    throw error;
  }
}

/** Single-flight connect. No-op when a managed session is already active. */
export async function ensureQuoteStreamerSessionConnected(): Promise<void> {
  if (isQuoteStreamerSessionActive()) {
    return;
  }

  connectPromise ??= openQuoteStreamerSession().finally(() => {
    connectPromise = null;
  });
  await connectPromise;
}

/**
 * Tear down the dxLink session for real: cancel the feed channel, close the
 * WebSocket (stops keepalives, lets the server reap the session), and clear
 * the SDK streamer's feed reference. Best-effort — never throws.
 */
export function closeQuoteStreamerSession(reason: string): void {
  const hadSession = activeClient != null || activeFeed != null;

  try {
    activeFeed?.close();
  } catch {}
  try {
    activeClient?.disconnect();
  } catch {}
  activeFeed = null;
  activeClient = null;

  try {
    const streamer = getDeps().getQuoteStreamer();
    streamer.dxLinkFeed = null;
    streamer.dxLinkAuthToken = null;
  } catch {}

  if (hadSession) {
    console.log(`[quote-streamer] closed dxLink session (${reason})`);
  }
}

async function waitForClientAuthorized(
  client: DxLinkClientLike,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (
      client.getConnectionState() === DXLinkConnectionState.CONNECTED &&
      client.getAuthState() === DXLinkAuthState.AUTHORIZED
    ) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, AUTHORIZED_POLL_INTERVAL_MS));
  }
}

/**
 * One in-process reconnect attempt: close the old session cleanly, open a new
 * one (fresh quote token → re-auth), and wait for the client to reach
 * CONNECTED/AUTHORIZED. Returns false — with the failed session closed, never
 * half-open — when the attempt does not complete in time.
 */
export async function reconnectQuoteStreamerSession(
  reason: string,
  authorizedWaitMs: number = DEFAULT_AUTHORIZED_WAIT_MS,
): Promise<boolean> {
  closeQuoteStreamerSession(`reconnect: ${reason}`);

  try {
    await ensureQuoteStreamerSessionConnected();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[quote-streamer] reconnect attempt failed to open a session: ${message}`);
    closeQuoteStreamerSession("reconnect attempt failed");
    return false;
  }

  const client = activeClient;
  if (!client) {
    return false;
  }

  const authorized = await waitForClientAuthorized(client, authorizedWaitMs);
  if (!authorized) {
    console.warn(
      `[quote-streamer] reconnect attempt did not reach AUTHORIZED within ${authorizedWaitMs}ms`,
    );
    closeQuoteStreamerSession("reconnect attempt unauthorized");
    return false;
  }

  console.log(`[quote-streamer] in-process dxLink reconnect succeeded (${reason})`);
  return true;
}
