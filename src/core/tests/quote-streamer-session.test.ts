import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  closeQuoteStreamerSession,
  ensureQuoteStreamerSessionConnected,
  isQuoteStreamerSessionActive,
  parseQuoteTokenResponse,
  reconnectQuoteStreamerSession,
  setQuoteStreamerSessionDepsForTesting,
  type DxLinkClientLike,
  type DxLinkFeedLike,
  type QuoteStreamerLike,
  type QuoteStreamerSessionDeps,
} from "~/core/quote-streamer-session";

interface FakeClient extends DxLinkClientLike {
  calls: string[];
  connectionState: string;
  authState: string;
}

function makeFakeClient(
  overrides: Partial<Pick<FakeClient, "connectionState" | "authState">> = {},
): FakeClient {
  const client: FakeClient = {
    calls: [],
    connectionState: overrides.connectionState ?? "CONNECTED",
    authState: overrides.authState ?? "AUTHORIZED",
    connect(url: string) {
      client.calls.push(`connect:${url}`);
    },
    setAuthToken(token: string) {
      client.calls.push(`token:${token}`);
    },
    disconnect() {
      client.calls.push("disconnect");
    },
    getConnectionState: () => client.connectionState,
    getAuthState: () => client.authState,
  };
  return client;
}

interface FakeFeed extends DxLinkFeedLike {
  listeners: Array<(events: unknown[]) => void>;
  closed: number;
  closeThrows: boolean;
}

function makeFakeFeed(): FakeFeed {
  const feed: FakeFeed = {
    listeners: [],
    closed: 0,
    closeThrows: false,
    addEventListener(listener) {
      feed.listeners.push(listener);
    },
    close() {
      feed.closed += 1;
      if (feed.closeThrows) {
        throw new Error("channel already gone");
      }
    },
  };
  return feed;
}

interface Harness {
  deps: QuoteStreamerSessionDeps;
  streamer: QuoteStreamerLike;
  clients: FakeClient[];
  feeds: FakeFeed[];
  tokenCalls: number;
}

function makeHarness(
  overrides: Partial<QuoteStreamerSessionDeps> = {},
): Harness {
  const streamer: QuoteStreamerLike = {
    dxLinkFeed: null,
    dxLinkUrl: null,
    dxLinkAuthToken: null,
    eventListeners: [],
  };
  const harness: Harness = {
    streamer,
    clients: [],
    feeds: [],
    tokenCalls: 0,
    deps: {
      async fetchQuoteToken() {
        harness.tokenCalls += 1;
        return { url: "wss://dx.example/feed", token: "quote-token" };
      },
      createClient() {
        const client = makeFakeClient();
        harness.clients.push(client);
        return client;
      },
      createFeed() {
        const feed = makeFakeFeed();
        harness.feeds.push(feed);
        return feed;
      },
      getQuoteStreamer: () => streamer,
      ...overrides,
    },
  };
  setQuoteStreamerSessionDepsForTesting(harness.deps);
  return harness;
}

afterEach(() => {
  setQuoteStreamerSessionDepsForTesting(null);
});

test("ensure connects once and wires the feed onto the SDK streamer", async () => {
  const seenEvents: unknown[][] = [];
  const harness = makeHarness();
  harness.streamer.eventListeners.push((events) => seenEvents.push(events));

  assert.equal(isQuoteStreamerSessionActive(), false);
  await ensureQuoteStreamerSessionConnected();

  assert.equal(isQuoteStreamerSessionActive(), true);
  assert.equal(harness.clients.length, 1);
  assert.deepEqual(harness.clients[0].calls, [
    "connect:wss://dx.example/feed",
    "token:quote-token",
  ]);
  assert.equal(harness.streamer.dxLinkFeed, harness.feeds[0]);
  assert.equal(harness.streamer.dxLinkUrl, "wss://dx.example/feed");
  assert.equal(harness.streamer.dxLinkAuthToken, "quote-token");

  // Persistent listeners registered on the SDK streamer get re-attached to
  // the new feed, mirroring QuoteStreamer.connect().
  assert.equal(harness.feeds[0].listeners.length, 1);
  harness.feeds[0].listeners[0](["evt"]);
  assert.deepEqual(seenEvents, [["evt"]]);
});

test("ensure is a no-op while a session is active", async () => {
  const harness = makeHarness();
  await ensureQuoteStreamerSessionConnected();
  await ensureQuoteStreamerSessionConnected();
  assert.equal(harness.clients.length, 1);
  assert.equal(harness.tokenCalls, 1);
});

test("concurrent ensure calls share a single connect (single-flight)", async () => {
  const gate: { release?: () => void } = {};
  const harness = makeHarness({
    async fetchQuoteToken() {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return { url: "wss://dx.example/feed", token: "quote-token" };
    },
  });

  const first = ensureQuoteStreamerSessionConnected();
  const second = ensureQuoteStreamerSessionConnected();
  assert.ok(gate.release, "connect should be in flight");
  gate.release();
  await Promise.all([first, second]);

  assert.equal(harness.clients.length, 1);
});

test("a client that fails mid-open is disconnected, and ensure can retry", async () => {
  let failNext = true;
  const harness = makeHarness({
    createFeed() {
      if (failNext) {
        failNext = false;
        throw new Error("feed construction failed");
      }
      const feed = makeFakeFeed();
      harness.feeds.push(feed);
      return feed;
    },
  });

  await assert.rejects(ensureQuoteStreamerSessionConnected(), /feed construction failed/);
  assert.equal(isQuoteStreamerSessionActive(), false);
  // The half-open client must not keep the server-side session alive.
  assert.equal(harness.clients[0].calls.includes("disconnect"), true);

  await ensureQuoteStreamerSessionConnected();
  assert.equal(isQuoteStreamerSessionActive(), true);
  assert.equal(harness.clients.length, 2);
});

test("close tears down feed + client and clears the SDK streamer reference", async () => {
  const harness = makeHarness();
  await ensureQuoteStreamerSessionConnected();

  closeQuoteStreamerSession("test");

  assert.equal(isQuoteStreamerSessionActive(), false);
  assert.equal(harness.feeds[0].closed, 1);
  assert.equal(harness.clients[0].calls.includes("disconnect"), true);
  assert.equal(harness.streamer.dxLinkFeed, null);
  assert.equal(harness.streamer.dxLinkAuthToken, null);

  // Idempotent: a second close performs no further teardown and never throws.
  closeQuoteStreamerSession("test again");
  assert.equal(harness.feeds[0].closed, 1);
  assert.equal(
    harness.clients[0].calls.filter((c) => c === "disconnect").length,
    1,
  );
});

test("close still disconnects the client when the feed close throws", async () => {
  const harness = makeHarness();
  await ensureQuoteStreamerSessionConnected();
  harness.feeds[0].closeThrows = true;

  closeQuoteStreamerSession("test");

  assert.equal(harness.clients[0].calls.includes("disconnect"), true);
  assert.equal(isQuoteStreamerSessionActive(), false);
});

test("reconnect closes the old session and reports success once authorized", async () => {
  const harness = makeHarness();
  await ensureQuoteStreamerSessionConnected();

  const recovered = await reconnectQuoteStreamerSession("test-fault", 500);

  assert.equal(recovered, true);
  assert.equal(harness.clients.length, 2);
  assert.equal(harness.clients[0].calls.includes("disconnect"), true);
  assert.equal(isQuoteStreamerSessionActive(), true);
  assert.equal(harness.streamer.dxLinkFeed, harness.feeds[1]);
});

test("reconnect fails closed when the client never authorizes in time", async () => {
  const harness = makeHarness({
    createClient() {
      const client = makeFakeClient({ authState: "AUTHORIZING" });
      harness.clients.push(client);
      return client;
    },
  });

  const recovered = await reconnectQuoteStreamerSession("test-fault", 50);

  assert.equal(recovered, false);
  // The failed attempt must not linger half-open — that would stack sessions.
  assert.equal(isQuoteStreamerSessionActive(), false);
  assert.equal(harness.clients[0].calls.includes("disconnect"), true);
});

test("reconnect returns false without throwing when the token fetch fails", async () => {
  makeHarness({
    async fetchQuoteToken() {
      throw new Error("api down");
    },
  });

  const recovered = await reconnectQuoteStreamerSession("test-fault", 50);

  assert.equal(recovered, false);
  assert.equal(isQuoteStreamerSessionActive(), false);
});

test("parseQuoteTokenResponse reads the SDK fields and rejects junk", () => {
  assert.deepEqual(
    parseQuoteTokenResponse({ "dxlink-url": "wss://dx", token: "t0k" }),
    { url: "wss://dx", token: "t0k" },
  );
  assert.throws(() => parseQuoteTokenResponse(null), /no dxlink-url\/token/);
  assert.throws(() => parseQuoteTokenResponse({}), /no dxlink-url\/token/);
  assert.throws(
    () => parseQuoteTokenResponse({ "dxlink-url": "", token: "t0k" }),
    /no dxlink-url\/token/,
  );
  assert.throws(
    () => parseQuoteTokenResponse({ "dxlink-url": "wss://dx" }),
    /no dxlink-url\/token/,
  );
});
