import { test } from "node:test";
import assert from "node:assert/strict";
import { createTypedOrderService } from "~/core/tastytrade-order-service";

const READ_ONLY_ACCOUNT = "5WREADONLY";
const LIVE_ACCOUNT = "5WLIVE0001";

function makeSpyRawService() {
  const calls: string[] = [];
  const raw = {
    async postReconfirmOrder(accountNumber: string) {
      calls.push(`postReconfirmOrder:${accountNumber}`);
      return {};
    },
    async replacementOrderDryRun(accountNumber: string) {
      calls.push(`replacementOrderDryRun:${accountNumber}`);
      return {};
    },
    async getOrder(accountNumber: string) {
      calls.push(`getOrder:${accountNumber}`);
      return {};
    },
    async cancelOrder(accountNumber: string) {
      calls.push(`cancelOrder:${accountNumber}`);
      return {};
    },
    async cancelComplexOrder(accountNumber: string) {
      calls.push(`cancelComplexOrder:${accountNumber}`);
      return {};
    },
    async replaceOrder(accountNumber: string) {
      calls.push(`replaceOrder:${accountNumber}`);
      return {};
    },
    async editOrder(accountNumber: string) {
      calls.push(`editOrder:${accountNumber}`);
      return {};
    },
    async getLiveOrders(accountNumber: string) {
      calls.push(`getLiveOrders:${accountNumber}`);
      return {};
    },
    async getOrders(accountNumber: string) {
      calls.push(`getOrders:${accountNumber}`);
      return {};
    },
    async createOrder(accountNumber: string) {
      calls.push(`createOrder:${accountNumber}`);
      return {};
    },
    async createComplexOrder(accountNumber: string) {
      calls.push(`createComplexOrder:${accountNumber}`);
      return {};
    },
    async postOrderDryRun(accountNumber: string) {
      calls.push(`postOrderDryRun:${accountNumber}`);
      return {};
    },
    async getLiveOrdersForCustomer(customerId: string) {
      calls.push(`getLiveOrdersForCustomer:${customerId}`);
      return {};
    },
    async getCustomerOrders(customerId: string) {
      calls.push(`getCustomerOrders:${customerId}`);
      return {};
    },
  };
  return { raw, calls };
}

function withReadOnlyEnv<T>(value: string, fn: () => T): T {
  const previous = process.env.BOT_READ_ONLY_ACCOUNTS;
  process.env.BOT_READ_ONLY_ACCOUNTS = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.BOT_READ_ONLY_ACCOUNTS;
    else process.env.BOT_READ_ONLY_ACCOUNTS = previous;
  }
}

test("createOrder on a read-only account throws before any broker mutation", async () => {
  await withReadOnlyEnv(READ_ONLY_ACCOUNT, async () => {
    const { raw, calls } = makeSpyRawService();
    const service = createTypedOrderService(raw as never);

    await assert.rejects(
      () => service.createOrder(READ_ONLY_ACCOUNT, {} as never),
      /read-only/i,
    );

    assert.equal(
      calls.filter((c) => c.startsWith("createOrder")).length,
      0,
      "raw createOrder must never be reached for a read-only account",
    );
  });
});

test("replaceOrder on a read-only account throws before any broker mutation", async () => {
  await withReadOnlyEnv(READ_ONLY_ACCOUNT, async () => {
    const { raw, calls } = makeSpyRawService();
    const service = createTypedOrderService(raw as never);

    await assert.rejects(
      () => service.replaceOrder(READ_ONLY_ACCOUNT, 123, {} as never),
      /read-only/i,
    );

    assert.equal(
      calls.filter((c) => c.startsWith("replaceOrder")).length,
      0,
      "raw replaceOrder must never be reached for a read-only account",
    );
  });
});

test("dry-run previews are allowed on read-only accounts (margin/effect calc)", async () => {
  await withReadOnlyEnv(READ_ONLY_ACCOUNT, async () => {
    const { raw, calls } = makeSpyRawService();
    const service = createTypedOrderService(raw as never);

    await service.postOrderDryRun(READ_ONLY_ACCOUNT, {} as never);
    await service.replacementOrderDryRun(READ_ONLY_ACCOUNT, 123, {} as never);

    assert.ok(calls.includes(`postOrderDryRun:${READ_ONLY_ACCOUNT}`));
    assert.ok(calls.includes(`replacementOrderDryRun:${READ_ONLY_ACCOUNT}`));
  });
});

test("live accounts place and replace orders normally", async () => {
  await withReadOnlyEnv(READ_ONLY_ACCOUNT, async () => {
    const { raw, calls } = makeSpyRawService();
    const service = createTypedOrderService(raw as never);

    await service.createOrder(LIVE_ACCOUNT, {} as never);
    await service.replaceOrder(LIVE_ACCOUNT, 123, {} as never);

    assert.ok(calls.includes(`createOrder:${LIVE_ACCOUNT}`));
    assert.ok(calls.includes(`replaceOrder:${LIVE_ACCOUNT}`));
  });
});
