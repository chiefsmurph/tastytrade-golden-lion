import { test } from "node:test";
import assert from "node:assert/strict";
import { installApiCallCounting } from "~/core/api-call-count-wiring";

function makeFakeHttpClient() {
  const calls: string[] = [];
  return {
    calls,
    client: {
      getData: async (url: string) => {
        calls.push(`getData ${url}`);
        return { ok: true, url };
      },
      postData: async (url: string) => {
        calls.push(`postData ${url}`);
        return { ok: true, url };
      },
      generateAccessToken: async () => {
        calls.push("generateAccessToken");
        return { token: "t" };
      },
    } as Record<string, unknown>,
  };
}

test("wiring: records the url and passes the request through untouched", async () => {
  const recorded: string[] = [];
  const { calls, client } = makeFakeHttpClient();

  assert.equal(installApiCallCounting(client, (url) => recorded.push(url)), true);

  const getData = client.getData as (url: string) => Promise<{ ok: boolean; url: string }>;
  const result = await getData("/option-chains/AAPL/nested");

  assert.deepEqual(result, { ok: true, url: "/option-chains/AAPL/nested" });
  assert.deepEqual(recorded, ["/option-chains/AAPL/nested"]);
  assert.deepEqual(calls, ["getData /option-chains/AAPL/nested"]);
});

test("wiring: generateAccessToken is recorded as /oauth/token", async () => {
  const recorded: string[] = [];
  const { client } = makeFakeHttpClient();
  installApiCallCounting(client, (url) => recorded.push(url));

  const generateAccessToken = client.generateAccessToken as () => Promise<unknown>;
  await generateAccessToken();

  assert.deepEqual(recorded, ["/oauth/token"]);
});

test("wiring: double install is a no-op — no double counting", async () => {
  const recorded: string[] = [];
  const { client } = makeFakeHttpClient();

  assert.equal(installApiCallCounting(client, (url) => recorded.push(url)), true);
  assert.equal(installApiCallCounting(client, (url) => recorded.push(url)), false);

  const postData = client.postData as (url: string) => Promise<unknown>;
  await postData("/accounts/5WX/orders/dry-run");

  assert.deepEqual(recorded, ["/accounts/5WX/orders/dry-run"]);
});

test("wiring: a throwing recorder never breaks the request", async () => {
  const { client } = makeFakeHttpClient();
  installApiCallCounting(client, () => {
    throw new Error("counter exploded");
  });

  const getData = client.getData as (url: string) => Promise<{ ok: boolean }>;
  const result = await getData("/market-metrics");
  assert.equal(result.ok, true);
});

test("wiring: missing methods and null clients are tolerated", () => {
  assert.equal(installApiCallCounting(null), false);
  assert.equal(installApiCallCounting(undefined), false);

  // Object with only some of the counted methods — install must not throw.
  const partial: Record<string, unknown> = { getData: async () => "ok" };
  assert.equal(installApiCallCounting(partial, () => {}), true);
});
