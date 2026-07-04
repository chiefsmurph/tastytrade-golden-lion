import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findLegacyHonoredEnvNames,
  findObsoleteEnvNames,
  getTimezoneWarning,
  maskEnvValue,
} from "~/startup-config";

test("flags the pre-refactor names from the 07-02 incident class", () => {
  const findings = findObsoleteEnvNames({
    BASE_URL: "https://api.tastyworks.com",
    API_CLIENT_SECRET: "abc",
    API_REFRESH_TOKEN: "def",
    BOT_MAX_OPTION_SPREAD_PCT: "0.3",
    TASTYTRADE_BOT_RUN_HISTORY_DIR: "",
    TASTYTRADE_BOT_SOCKET: "/tmp/x.sock",
  });
  const names = findings.map((f) => f.name);
  assert.deepEqual(names, [
    "API_CLIENT_SECRET",
    "API_REFRESH_TOKEN",
    "BASE_URL",
    "BOT_MAX_OPTION_SPREAD_PCT",
    "TASTYTRADE_BOT_SOCKET",
  ]);
  assert.match(
    findings.find((f) => f.name === "TASTYTRADE_BOT_SOCKET")!.guidance,
    /CORE_IPC_SOCKET/,
  );
});

test("blank values are not flagged (empty string is unset)", () => {
  assert.deepEqual(findObsoleteEnvNames({ BASE_URL: "  " }), []);
});

test("current names are never flagged", () => {
  const findings = findObsoleteEnvNames({
    CORE_BASE_URL: "https://api.tastyworks.com",
    STRATEGY_MAX_OPTION_SPREAD_PCT: "0.3",
    STRATEGY_MIN_IV_RANK_PCT: "20",
    BOT_DATA_DIR: "./data",
    SECRET_SOCKET_URL: "wss://x",
  });
  assert.deepEqual(findings, []);
});

test("legacy-honored gate names are reported separately", () => {
  const findings = findLegacyHonoredEnvNames({
    STRATEGY_GATE_STRONG_STOCK_YES_MAX_PCT: "30",
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].guidance, /STRATEGY_GATE_STRONG_PERCENT_OF_BALANCE_THRESHOLD/);
  assert.deepEqual(findObsoleteEnvNames({ STRATEGY_GATE_STRONG_STOCK_YES_MAX_PCT: "30" }), []);
});

test("timezone warning is silent on Pacific, loud elsewhere", () => {
  assert.equal(getTimezoneWarning("America/Los_Angeles"), null);
  assert.match(getTimezoneWarning("America/New_York") ?? "", /expected America\/Los_Angeles/);
  assert.match(getTimezoneWarning("UTC") ?? "", /every intraday schedule assumes Pacific/);
});

test("sensitive values are masked, others pass through", () => {
  assert.equal(maskEnvValue("CORE_API_REFRESH_TOKEN", "supersecretvalue"), "supe…(16 chars)");
  assert.equal(maskEnvValue("CORE_API_CLIENT_SECRET", "ab"), "•••");
  assert.equal(maskEnvValue("SECRET_SOCKET_URL", "wss://internal.example:9000"), "wss:…(27 chars)");
  assert.equal(maskEnvValue("STRATEGY_MIN_IV_RANK_PCT", "20"), "20");
  assert.equal(maskEnvValue("BOT_RUN_ON_SCHEDULE", "true"), "true");
});
