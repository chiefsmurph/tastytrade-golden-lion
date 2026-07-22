import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "spray-buy-test-"));
process.env.BOT_SPRAY_BUY_ENABLED = "true";

import type { OrderPayload } from "../actions/order-utils";
import {
  abortSprayBuy,
  advanceSprays,
  isSprayBuyEnabled,
  makeSprayId,
  startSprayBuy,
  type SprayDeps,
} from "../actions/spray-buy";
import {
  clearSprayStore,
  getSpray,
  loadActiveSprays,
} from "../actions/spray-store";
import { summarizeSprayProgress } from "../actions/spray-schedule";

const ACCOUNT = "TEST123";
const CONTRACT = "SPY   260101C00500000";

// A controllable clock + broker double. Records every placed order and lets a
// test dictate each order's eventual status.
interface FakeBroker {
  deps: SprayDeps;
  setNow: (ms: number) => void;
  placed: Array<{ orderId: string; order: OrderPayload }>;
  setStatus: (orderId: string, status: string, filledQuantity?: number) => void;
}

function makeFakeBroker(startMs = 1_000_000): FakeBroker {
  let nowMs = startMs;
  let nextId = 1;
  const placed: FakeBroker["placed"] = [];
  const statusById = new Map<string, { status: string; filledQuantity?: number }>();

  const deps: SprayDeps = {
    now: () => nowMs,
    placeLimitOrder: async (_account, order) => {
      const orderId = String(nextId);
      nextId += 1;
      placed.push({ orderId, order });
      // Default: live/pending until the test says otherwise.
      statusById.set(orderId, { status: "Live" });
      return { orderId };
    },
    getOrderStatus: async (_account, orderId) => statusById.get(orderId) ?? null,
  };

  return {
    deps,
    setNow: (ms) => {
      nowMs = ms;
    },
    placed,
    setStatus: (orderId, status, filledQuantity) => {
      statusById.set(orderId, { status, filledQuantity });
    },
  };
}

test.beforeEach(async () => {
  await clearSprayStore();
});

test("flag defaults off; startSprayBuy is a no-op when disabled", async () => {
  delete process.env.BOT_SPRAY_BUY_ENABLED;
  assert.equal(isSprayBuyEnabled(), false);
  const broker = makeFakeBroker();
  const result = await startSprayBuy(
    {
      accountNumber: ACCOUNT,
      symbol: "SPY",
      contractSymbol: CONTRACT,
      side: "call",
      totalContracts: 10,
      limitPrice: 1.25,
    },
    broker.deps,
  );
  assert.equal(result.started, false);
  assert.equal(broker.placed.length, 0, "no orders placed while disabled");
  assert.deepEqual(await loadActiveSprays(), []);
  process.env.BOT_SPRAY_BUY_ENABLED = "true";
});

test("startSprayBuy fires only the first (largest) slice immediately", async () => {
  const broker = makeFakeBroker();
  const result = await startSprayBuy(
    {
      accountNumber: ACCOUNT,
      symbol: "SPY",
      contractSymbol: CONTRACT,
      side: "call",
      totalContracts: 10,
      limitPrice: 1.25,
      windowMs: 300_000,
      slices: 3,
      frontLoadBias: 0.6,
    },
    broker.deps,
  );

  assert.equal(result.started, true);
  assert.equal(result.scheduledSlices, 3);
  assert.equal(broker.placed.length, 1, "only slice 0 placed at start");

  const firstOrder = broker.placed[0].order;
  assert.equal(firstOrder["order-type"], "Limit", "never a market order");
  assert.equal(firstOrder.legs[0].action, "Buy to Open");
  assert.equal(firstOrder.legs[0].symbol, CONTRACT);

  const spray = await getSpray(result.sprayId!);
  assert.ok(spray);
  assert.equal(spray.slices[0].status, "placed");
  assert.equal(spray.slices[1].status, "pending");
  assert.equal(spray.slices[2].status, "pending");
  // Front-loaded: first slice is the biggest.
  assert.ok(spray.slices[0].quantity >= spray.slices[1].quantity);
});

test("advanceSprays releases later slices only as their offsets elapse", async () => {
  const broker = makeFakeBroker();
  const start = await startSprayBuy(
    {
      accountNumber: ACCOUNT,
      symbol: "SPY",
      contractSymbol: CONTRACT,
      side: "call",
      totalContracts: 9,
      limitPrice: 1.0,
      windowMs: 300_000,
      slices: 3,
    },
    broker.deps,
  );
  const sprayId = start.sprayId!;
  assert.equal(broker.placed.length, 1);

  // Advancing before the second slice's offset places nothing new.
  broker.setNow(1_000_000 + 60_000);
  await advanceSprays(broker.deps);
  assert.equal(broker.placed.length, 1, "slice 1 not yet due");

  // At the halfway offset, slice 1 fires.
  broker.setNow(1_000_000 + 150_000);
  await advanceSprays(broker.deps);
  assert.equal(broker.placed.length, 2, "slice 1 now due");

  // At the window end, slice 2 fires.
  broker.setNow(1_000_000 + 300_000);
  await advanceSprays(broker.deps);
  assert.equal(broker.placed.length, 3, "slice 2 now due");

  const spray = await getSpray(sprayId);
  assert.ok(spray);
  assert.ok(spray.slices.every((s) => s.status === "placed"));
});

test("advanceSprays reconciles fills and completes a partial spray", async () => {
  const broker = makeFakeBroker();
  const start = await startSprayBuy(
    {
      accountNumber: ACCOUNT,
      symbol: "SPY",
      contractSymbol: CONTRACT,
      side: "call",
      totalContracts: 9,
      limitPrice: 1.0,
      windowMs: 300_000,
      slices: 3,
    },
    broker.deps,
  );
  const sprayId = start.sprayId!;

  // Slice 0 fills; later slices never fill (name ran away) and expire.
  broker.setStatus("1", "Filled", 5);

  broker.setNow(1_000_000 + 150_000);
  await advanceSprays(broker.deps); // reconciles slice 0 filled, places slice 1
  broker.setStatus("2", "Expired");

  broker.setNow(1_000_000 + 300_000);
  await advanceSprays(broker.deps); // reconciles slice 1 expired, places slice 2
  broker.setStatus("3", "Expired");

  broker.setNow(1_000_000 + 360_000);
  await advanceSprays(broker.deps); // reconciles slice 2 expired => complete

  // The spray is now complete: slice 0 filled (5 contracts), 1 & 2 aborted.
  const spray = await getSpray(sprayId);
  assert.ok(spray);
  const progress = summarizeSprayProgress(spray.slices);
  assert.equal(progress.isComplete, true, "partial fill is a complete spray");
  assert.equal(progress.filledContracts, 5);
  // Completed sprays are pruned from the store on the next load.
  assert.deepEqual(await loadActiveSprays(), [], "completed spray pruned");
});

test("aborting a spray leaves filled slices and stops placing the rest", async () => {
  const broker = makeFakeBroker();
  const start = await startSprayBuy(
    {
      accountNumber: ACCOUNT,
      symbol: "SPY",
      contractSymbol: CONTRACT,
      side: "call",
      totalContracts: 9,
      limitPrice: 1.0,
      windowMs: 300_000,
      slices: 3,
    },
    broker.deps,
  );
  const sprayId = start.sprayId!;
  broker.setStatus("1", "Filled", 5);

  // Reconcile the fill, then abort on a (simulated) thesis flip.
  await advanceSprays(broker.deps);
  await abortSprayBuy(sprayId);

  // Any further advance must NOT place the remaining slices.
  const placedBefore = broker.placed.length;
  broker.setNow(1_000_000 + 300_000);
  await advanceSprays(broker.deps);
  assert.equal(broker.placed.length, placedBefore, "aborted spray never chases");

  // Aborted spray is complete and pruned.
  assert.deepEqual(await loadActiveSprays(), []);
});

test("never places past the market-close guard (notAfterMs)", async () => {
  const broker = makeFakeBroker();
  await startSprayBuy(
    {
      accountNumber: ACCOUNT,
      symbol: "SPY",
      contractSymbol: CONTRACT,
      side: "call",
      totalContracts: 9,
      limitPrice: 1.0,
      windowMs: 300_000,
      slices: 3,
      // Close 100s after start: slices 1 (150s) & 2 (300s) fall past it.
      notAfterMs: 1_000_000 + 100_000,
    },
    broker.deps,
  );
  assert.equal(broker.placed.length, 1, "slice 0 placed before close");
  // Slice 0 (placed before the close) fills; the later slices are past the guard.
  broker.setStatus("1", "Filled", 3);

  broker.setNow(1_000_000 + 150_000);
  await advanceSprays(broker.deps);
  broker.setNow(1_000_000 + 300_000);
  await advanceSprays(broker.deps);

  assert.equal(broker.placed.length, 1, "no slices placed past the close guard");
  // Slice 0 filled; slices past the guard are aborted, not stranded => resolves.
  assert.deepEqual(await loadActiveSprays(), []);
});

test("restart is idempotent: re-registering the same spray does not double-fire", async () => {
  const broker = makeFakeBroker();
  const input = {
    accountNumber: ACCOUNT,
    symbol: "SPY",
    contractSymbol: CONTRACT,
    side: "call" as const,
    totalContracts: 9,
    limitPrice: 1.0,
    windowMs: 300_000,
    slices: 3,
  };

  const first = await startSprayBuy(input, broker.deps);
  assert.equal(broker.placed.length, 1);

  // Same start time => same id => replay (as after a restart mid-window).
  const replay = await startSprayBuy(input, broker.deps);
  assert.equal(replay.sprayId, first.sprayId);
  assert.equal(broker.placed.length, 1, "slice 0 not re-placed on replay");
});

test("makeSprayId is stable for the same account/contract/start", () => {
  assert.equal(makeSprayId(ACCOUNT, CONTRACT, 42), makeSprayId(ACCOUNT, CONTRACT, 42));
  assert.notEqual(makeSprayId(ACCOUNT, CONTRACT, 42), makeSprayId(ACCOUNT, CONTRACT, 43));
});

test("summarizeSprayProgress reflects the executor's slice states", async () => {
  const broker = makeFakeBroker();
  const start = await startSprayBuy(
    {
      accountNumber: ACCOUNT,
      symbol: "SPY",
      contractSymbol: CONTRACT,
      side: "call",
      totalContracts: 6,
      limitPrice: 1.0,
      windowMs: 200_000,
      slices: 2,
    },
    broker.deps,
  );
  const spray = await getSpray(start.sprayId!);
  assert.ok(spray);
  const progress = summarizeSprayProgress(spray.slices);
  assert.equal(progress.totalContracts, 6);
  assert.equal(progress.filledContracts, 0);
  assert.equal(progress.isComplete, false);
});
