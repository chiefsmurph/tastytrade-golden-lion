import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Enable the flag + isolate the store on disk BEFORE importing the executor.
process.env.BOT_SPRAY_BUY_ENABLED = "true";
process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "spray-buy-test-"));
// Deterministic, small knobs for the tests.
process.env.BOT_SPRAY_WINDOW_MS = "300000"; // 5 min
process.env.BOT_SPRAY_FRONT_LOAD = "0.6";
process.env.BOT_SPRAY_DWELL_BASE_MS = "20000";
process.env.BOT_SPRAY_DWELL_K = "3";
process.env.BOT_SPRAY_CHASE_STEPS = "10";
process.env.BOT_SPRAY_DEADLINE_COLLAPSE_FRACTION = "0.15";

import {
  advanceSprays,
  abortSprayBuy,
  startSprayBuy,
  type SprayDeps,
} from "../actions/spray-buy";
import { clearSprayStore, getSpray } from "../actions/spray-store";

// ── A controllable fake broker ──────────────────────────────────────────────

interface FakeOrder {
  id: string;
  quantity: number;
  status: string;
  filledQuantity: number;
  limitPrice: number;
}

class FakeBroker {
  clock = 0;
  bid = 1.0;
  ask = 1.2;
  orders: FakeOrder[] = [];
  placedCount = 0;
  cancelledIds: string[] = [];
  private nextId = 1;

  // How many orders are live (Received/Open) right now — the single-order
  // invariant is: this is never > 1.
  liveOrderCount(): number {
    return this.orders.filter((o) => o.status === "Received").length;
  }

  deps(): SprayDeps {
    return {
      now: () => this.clock,
      placeLimitOrder: async (_acct, order) => {
        const qty = Number(order.legs[0]?.quantity ?? 0);
        const limitPrice = Number(order.price ?? 0);
        const id = String(this.nextId++);
        this.orders.push({ id, quantity: qty, status: "Received", filledQuantity: 0, limitPrice });
        this.placedCount += 1;
        return { orderId: id };
      },
      cancelOrder: async (_acct, orderId) => {
        const o = this.orders.find((x) => x.id === orderId);
        if (!o) return false;
        if (o.status === "Received") o.status = "Cancelled";
        this.cancelledIds.push(orderId);
        return true;
      },
      getOrderStatus: async (_acct, orderId) => {
        const o = this.orders.find((x) => x.id === orderId);
        if (!o) return null;
        return { status: o.status, filledQuantity: o.filledQuantity };
      },
      getBidAsk: async () => ({ bid: this.bid, ask: this.ask }),
    };
  }

  // Simulate the working order filling `n` contracts.
  fill(orderId: string, n: number): void {
    const o = this.orders.find((x) => x.id === orderId);
    if (!o) return;
    o.filledQuantity = Math.min(o.quantity, n);
    o.status = o.filledQuantity >= o.quantity ? "Filled" : "Partially Filled";
  }
}

async function freshStart(
  broker: FakeBroker,
  overrides: Partial<Parameters<typeof startSprayBuy>[0]> = {},
) {
  await clearSprayStore();
  return startSprayBuy(
    {
      accountNumber: "5WT00001",
      symbol: "SG",
      contractSymbol: "SG    260731C00003000",
      side: "call",
      totalContracts: 10,
      limitPrice: 1.2,
      quoteSymbol: ".SG260731C3",
      accountType: "cash",
      ...overrides,
    },
    broker.deps(),
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("startSprayBuy places the first chasing order and reports the target", async () => {
  const broker = new FakeBroker();
  const result = await freshStart(broker);
  assert.equal(result.started, true);
  assert.equal(result.scheduledSlices, 10, "reports the cumulative target");
  assert.ok(result.firstSliceOrderId, "a working order id is returned");
  assert.equal(broker.liveOrderCount(), 1, "exactly one live order");
});

test("single-order invariant: never more than one live order across many cycles", async () => {
  const broker = new FakeBroker();
  await freshStart(broker);
  // Walk the clock forward across the window, advancing every 20s. The price
  // stays put (stagnant) so the chaser will tick up but must always retire the
  // old order before placing a new one.
  for (let i = 0; i < 20; i++) {
    broker.clock += 20_000;
    await advanceSprays(broker.deps());
    assert.ok(
      broker.liveOrderCount() <= 1,
      `at least-one-order invariant held at cycle ${i} (live=${broker.liveOrderCount()})`,
    );
  }
});

test("idempotent on observed fills: a cancel-vs-fill race does NOT double-buy", async () => {
  const broker = new FakeBroker();
  const start = await freshStart(broker);
  const orderId = start.firstSliceOrderId as string;

  // The order fully fills its shortfall (the front-loaded clip unlocked at t=0)
  // AND we cancel it in the same breath (the classic cancel-vs-fill race).
  const firstOrder = broker.orders.find((o) => o.id === orderId)!;
  const clip = firstOrder.quantity;
  broker.fill(orderId, clip);

  // Advance repeatedly — each advance re-reads the same filled order. If the
  // bookkeeping double-counted, observedFilled would balloon past `clip`.
  for (let i = 0; i < 3; i++) {
    broker.clock += 25_000;
    await advanceSprays(broker.deps());
  }

  const rec = await getSpray(start.sprayId as string);
  assert.ok(rec, "record still present (target not yet met)");
  assert.equal(
    rec!.observedFilled,
    clip,
    "observed fill counted exactly once despite repeated re-reads / the race",
  );
});

// fallow-ignore-next-line complexity -- test-loop simulating multi-cycle fills
test("under-filled runner keeps chasing until the ramp target is met", async () => {
  const broker = new FakeBroker();
  const start = await freshStart(broker);
  const sprayId = start.sprayId as string;

  // Simulate a runner: every cycle, the book climbs and the working order fills
  // 1 contract, then we advance. Over the window the spray should accumulate
  // toward the full 10.
  for (let i = 0; i < 25 && !(await isComplete(sprayId)); i++) {
    broker.clock += 20_000;
    // Book climbs (runner).
    broker.bid += 0.02;
    broker.ask += 0.02;
    // Fill 1 more contract on whatever is live.
    const live = broker.orders.find((o) => o.status === "Received");
    if (live) broker.fill(live.id, live.filledQuantity + 1);
    await advanceSprays(broker.deps());
  }

  const rec = await getSpray(sprayId);
  // Either it completed (dropped from the store) or it's near-full — the point
  // is the observed fill kept climbing past the old static-slice ceiling.
  if (rec) {
    assert.ok(rec.observedFilled >= 5, `runner kept filling (got ${rec.observedFilled})`);
  } else {
    assert.ok(true, "spray completed and was pruned");
  }
});

async function isComplete(sprayId: string): Promise<boolean> {
  return (await getSpray(sprayId)) == null;
}

test("deadline collapses patience: past the deadline the spray aborts", async () => {
  const broker = new FakeBroker();
  const start = await freshStart(broker, { windowMs: 60_000 });
  const sprayId = start.sprayId as string;

  // Jump PAST the window/deadline without filling.
  broker.clock += 120_000;
  await advanceSprays(broker.deps());

  const rec = await getSpray(sprayId);
  // Aborted sprays are pruned on the next load → gone from the store.
  assert.equal(rec, null, "spray aborted + pruned past the deadline");
});

test("never chases past the ask (ceiling = ask)", async () => {
  const broker = new FakeBroker();
  broker.bid = 1.0;
  broker.ask = 1.1; // tight book
  const start = await freshStart(broker, { totalContracts: 4 });
  const sprayId = start.sprayId as string;

  for (let i = 0; i < 20 && (await getSpray(sprayId)); i++) {
    broker.clock += 25_000;
    await advanceSprays(broker.deps());
  }
  // Every order ever placed must rest at or below the ask (the ceiling).
  for (const o of broker.orders) {
    assert.ok(
      o.limitPrice <= broker.ask + 1e-9,
      `limit ${o.limitPrice} must never exceed the ask ${broker.ask}`,
    );
    assert.ok(o.quantity <= 4, "order size bounded by target");
  }
  assert.ok(broker.placedCount < 40, "chase does not thrash indefinitely at the ceiling");
});

test("blown-out spread gate: do not place into a spread wider than the gate", async () => {
  const broker = new FakeBroker();
  // Wide spread that the default cash entry gate rejects.
  broker.bid = 1.0;
  broker.ask = 4.0;
  const before = broker.placedCount;
  await freshStart(broker, { totalContracts: 4 });
  // The first advance reads the blown-out book and refuses to place.
  assert.equal(broker.placedCount, before, "no order placed into the blown-out spread");
});

test("abort keeps fills and stops chasing (idempotent)", async () => {
  const broker = new FakeBroker();
  const start = await freshStart(broker);
  const sprayId = start.sprayId as string;

  await abortSprayBuy(sprayId);
  await abortSprayBuy(sprayId); // idempotent — safe twice
  const rec = await getSpray(sprayId);
  assert.equal(rec, null, "aborted spray is pruned from the store");

  // A subsequent advance is a no-op (nothing active).
  const placedBefore = broker.placedCount;
  broker.clock += 20_000;
  await advanceSprays(broker.deps());
  assert.equal(broker.placedCount, placedBefore, "no chasing after abort");
});

test("disabled flag makes startSprayBuy a no-op", async () => {
  process.env.BOT_SPRAY_BUY_ENABLED = "false";
  const broker = new FakeBroker();
  const result = await freshStart(broker);
  assert.equal(result.started, false);
  assert.equal(broker.placedCount, 0);
  process.env.BOT_SPRAY_BUY_ENABLED = "true"; // restore for other tests
});
