import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tastytradeApi from "./core/tastytrade-client";
import johnsTestRun from "./bot/johns-test-run";
import {
  getOptionMarketSnapshotCacheStats,
  getOptionHealthForSymbol,
  resetOptionMarketSnapshotCacheStats,
  getTopOptionCandidateForAccount,
} from "./bot/get-option-candidates-for-symbol";
import { getPositionsAndBalances } from "./core/get-positions-and-balances";
import {
  getTimeOfDayExecutionTargetsForPstTime as getTargetsForPstTime,
} from "./bot/evaluate-trading-strategy";
import { getCurrentAllocationBudget } from "./bot/actions/manage-allocation";
import { getOptionCandidates } from "./bot/option-contracts";
import runBotCycle, {
  getRunCyclePreview,
  runBotCycleLogOnly,
} from "./bot/run-cycle";
import seedSymbol from "./bot/seed-symbol";
import purchaseSymbol from "./bot/purchase-symbol";
import { getEffectiveBuyingPowerSummary } from "./bot/effective-buying-power";
import {
  getMarketOpenSchedulerStatus,
  startMarketOpenScheduler,
  stopMarketOpenScheduler,
} from "./bot/market-open-scheduler";
import getLastRunCycle from "./bot/get-last-run-cycle";
import { getLastRunGroupsByTickers, getRecentRunHistory } from "./bot/run-history";
import getDayReport from "./bot/get-day-report";
import getDayTrend from "./bot/get-day-trend";
import getClosedPositionsToday from "./bot/get-closed-positions-today";
import { recordDayReportNow } from "./bot/record-day-report";
import {
  getCurrentEquitiesSession,
  isEquityOptionsMarketOpen,
} from "./core/market-sessions";
import { getDefaultAccountNumber, getMarginAccountNumber } from "./core/default-account";
import {
  buildDebugSecretExecutionTargetPayload,
  getSecretSocketStatus,
  logDebugSecretExecutionTargetPayload,
} from "./bot/secret";

type CommandHandler = (args: string[]) => Promise<unknown>;

type IpcRequest = {
  id?: string;
  command?: string;
  args?: string[];
};

type IpcResponse = {
  id: string | null;
  ok: boolean;
  result?: unknown;
  error?: string;
};

const socketPath =
  process.env.TASTYTRADE_BOT_SOCKET ||
  path.join(process.cwd(), ".tastytrade-golden-lion.sock");

const commandHandlers: Record<string, CommandHandler> = {
  "core:listCommands": async () => {
    return Object.keys(commandHandlers).sort((left, right) =>
      left.localeCompare(right),
    );
  },
  "core:getBidAskForSymbol": async ([symbol, timeoutMs]) => {
    assertArg(symbol, "symbol");
    const parsedTimeout = timeoutMs ? Number(timeoutMs) : undefined;
    return tastytradeApi.johnsService.getBidAskForSymbol(symbol, parsedTimeout);
  },
  "core:getUnderlyingPrice": async ([symbol, timeoutMs]) => {
    assertArg(symbol, "symbol");
    const parsedTimeout = timeoutMs ? Number(timeoutMs) : undefined;
    return tastytradeApi.johnsService.getUnderlyingPrice(symbol, parsedTimeout);
  },
  "core:getPositionsAndBalances": async ([accountNumber]) => {
    return getPositionsAndBalances(accountNumber);
  },
  "core:getBalanceSummary": async ([accountNumber]) => {
    const resolvedAccountNumber = accountNumber ?? (await getDefaultAccountNumber());
    return getEffectiveBuyingPowerSummary(resolvedAccountNumber);
  },
  "core:cancelAllLiveOrders": async ([accountNumber]) => {
    const resolvedAccountNumber = accountNumber ?? (await getDefaultAccountNumber());
    return tastytradeApi.johnsService.cancelAllLiveOrders(resolvedAccountNumber);
  },
  "core:fetchOptionChainWithVolume": async ([symbol]) => {
    assertArg(symbol, "symbol");
    return tastytradeApi.johnsService.fetchOptionChainWithVolume(symbol);
  },
  "core:getCurrentEquitiesSession": async () => {
    return getCurrentEquitiesSession();
  },
  "core:isEquityOptionsMarketOpen": async () => {
    const session = await getCurrentEquitiesSession();
    return isEquityOptionsMarketOpen(session);
  },
  "bot:getOptionCandidates": async ([symbol, side]) => {
    assertArg(symbol, "symbol");
    const normalizedSide = side === "put" ? "put" : "call";
    return getOptionCandidates(symbol, normalizedSide);
  },
  "bot:getTopOptionCandidateForSymbol": async ([symbol, side, accountNumber]) => {
    assertArg(symbol, "symbol");
    const normalizedSide = side === "put" ? "put" : "call";
    return getTopOptionCandidateForAccount(symbol, normalizedSide, accountNumber);
  },
  "bot:getOptionHealthForSymbol": async ([symbol, side, targetDTE]) => {
    assertArg(symbol, "symbol");
    const normalizedSide = side === "put" ? "put" : "call";
    const parsedTargetDTE =
      targetDTE != null && targetDTE !== "" ? Number(targetDTE) : undefined;

    if (
      parsedTargetDTE != null &&
      (!Number.isFinite(parsedTargetDTE) || parsedTargetDTE <= 0)
    ) {
      throw new Error("targetDTE must be a number greater than 0");
    }

    return getOptionHealthForSymbol(
      symbol,
      normalizedSide,
      undefined,
      parsedTargetDTE,
    );
  },
  "bot:getOptionMarketSnapshotCacheStats": async () => {
    return getOptionMarketSnapshotCacheStats();
  },
  "bot:resetOptionMarketSnapshotCacheStats": async ([clearCache]) => {
    const normalized = clearCache?.trim().toLowerCase();
    const shouldClearCache =
      normalized === "1" || normalized === "true" || normalized === "yes";
    return resetOptionMarketSnapshotCacheStats(shouldClearCache);
  },
  "bot:getTimeOfDayExecutionTargets": async ([timeOfDay]) => {
    return getTargetsForPstTime(timeOfDay);
  },
  "bot:getCurrentAllocationBudget": async ([accountNumber]) => {
    const resolvedAccountNumber = accountNumber ?? (await getDefaultAccountNumber());
    return getCurrentAllocationBudget(resolvedAccountNumber);
  },
  "bot:getSecretSocketStatus": async () => {
    const status = getSecretSocketStatus();
    console.log(
      JSON.stringify(
        {
          scope: "secret-socket-status",
          status,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    return status;
  },
  "bot:debugSecretExecutionTargetForSymbol": async ([
    symbol,
    askReturnPercArg,
    timeSinceLastActionMinutesArg,
    currentExposurePctArg,
  ]) => {
    assertArg(symbol, "symbol");
    const debugPayload = buildDebugSecretExecutionTargetPayload({
      askReturnPerc: parseOptionalNumberArg(askReturnPercArg, 0),
      currentExposurePct: parseOptionalNumberArg(currentExposurePctArg, 0),
      symbol,
      timeSinceLastActionMinutes: parseOptionalNumberArg(
        timeSinceLastActionMinutesArg,
        20,
      ),
    });

    logDebugSecretExecutionTargetPayload(debugPayload);
    return debugPayload;
  },
  "bot:seedSymbol": async ([symbol, side, accountNumber]) => {
    assertArg(symbol, "symbol");
    const normalizedSide = side === "put" ? "put" : "call";
    const resolvedAccount = accountNumber?.trim() || await getMarginAccountNumber();
    return seedSymbol(symbol, normalizedSide, resolvedAccount);
  },
  "bot:purchaseSymbol": async ([symbol, dollars, side, accountNumber]) => {
    assertArg(symbol, "symbol");
    assertArg(dollars, "dollars");
    const requestedBudget = Number(dollars);
    if (!Number.isFinite(requestedBudget) || requestedBudget <= 0) {
      throw new Error("dollars must be a number greater than 0");
    }

    const normalizedSide = side === "put" ? "put" : "call";
    return purchaseSymbol(symbol, requestedBudget, normalizedSide, accountNumber);
  },
  "bot:johnsTestRun": johnsTestRun,
  "bot:runCycle": async ([accountNumber]) => runBotCycle(accountNumber),
  "bot:runCycleLogOnly": async ([accountNumber]) =>
    runBotCycleLogOnly(accountNumber),
  "bot:getRunCyclePreview": async ([accountNumber]) =>
    getRunCyclePreview(accountNumber),
  "bot:getLastRunCycle": async ([accountNumber]) =>
    getLastRunCycle(
      typeof accountNumber === "string" ? accountNumber.trim() : undefined,
    ),
  "bot:getRecentRunHistory": async ([limit, accountNumber]) => {
    const parsedLimit = limit ? Number(limit) : 20;
    const parsedAccountNumber =
      typeof accountNumber === "string" ? accountNumber.trim() : undefined;
    return getRecentRunHistory(parsedLimit, parsedAccountNumber);
  },
  "bot:getLastRunGroupsByTickers": async (args) => {
    const tickerInput = args
      .map((arg) => String(arg ?? "").trim())
      .filter((arg) => arg.length > 0)
      .join(",");

    if (!tickerInput) {
      throw new Error("tickers are required; pass comma-separated symbols, e.g. RUM,TSLA");
    }

    return getLastRunGroupsByTickers(tickerInput);
  },
  "bot:getMarketOpenSchedulerStatus": async () =>
    getMarketOpenSchedulerStatus(),
  "bot:startMarketOpenScheduler": async () => startMarketOpenScheduler(),
  "bot:stopMarketOpenScheduler": async () => stopMarketOpenScheduler(),
  "bot:getDayReport": async (args) => getDayReport(args),
  "bot:getDayTrend": async (args) => getDayTrend(args),
  "bot:getClosedPositionsToday": async (args) => getClosedPositionsToday(args),
  "bot:recordDayReport": async ([accountNumber]) => recordDayReportNow(accountNumber),
};

export function startIpcServer() {
  cleanupStaleSocket();

  const server = net.createServer((socket) => {
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk.toString();

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const raw = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!raw) {
          continue;
        }

        const response = await handleRequest(raw);
        logResponse(response);
        socket.write(`${JSON.stringify(response)}\n`);
      }
    });
  });

  server.listen(socketPath, () => {
    console.log(`IPC server listening on ${socketPath}`);
    console.log("Available commands:");
    for (const command of Object.keys(commandHandlers)) {
      console.log(`- ${command}`);
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => {
        removeSocketFile();
        process.exit(0);
      });
    });
  }

  process.on("exit", removeSocketFile);
  return server;
}

async function handleRequest(raw: string): Promise<IpcResponse> {
  let request: IpcRequest;

  try {
    request = JSON.parse(raw) as IpcRequest;
  } catch {
    const response = {
      id: null,
      ok: false,
      error: "Invalid JSON request",
    };
    logRequest({ id: null, command: undefined, args: [] }, "invalid-json", raw);
    return response;
  }

  const id = request.id ?? null;
  const command = request.command;
  const args = Array.isArray(request.args) ? request.args : [];

  logRequest({ id, command, args }, "received");

  if (!command) {
    logRequest({ id, command, args }, "missing-command");
    return { id, ok: false, error: "Missing command" };
  }

  const handler = commandHandlers[command];
  if (!handler) {
    logRequest({ id, command, args }, "unknown-command");
    return { id, ok: false, error: `Unknown command: ${command}` };
  }

  logRequest({ id, command, args }, "route-hit");

  try {
    const result = await handler(args);
    return { id, ok: true, result };
  } catch (error) {
    const message = formatIpcError(error);
    return { id, ok: false, error: message };
  }
}

function formatIpcError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  const maybeAxiosError = error as {
    message?: string;
    response?: {
      data?: unknown;
      status?: number;
    };
  };
  const responseData = maybeAxiosError.response?.data;

  if (responseData != null) {
    try {
      return JSON.stringify(responseData);
    } catch {}
  }

  return maybeAxiosError.message ?? String(error);
}

function logRequest(
  request: { id: string | null; command?: string; args: string[] },
  status: "received" | "route-hit" | "missing-command" | "unknown-command" | "invalid-json",
  raw?: string,
) {
  console.log(
    JSON.stringify({
      scope: "ipc-request",
      status,
      id: request.id,
      command: request.command ?? null,
      args: request.args,
      raw: raw ?? undefined,
      timestamp: new Date().toISOString(),
    }, null, 2),
  );
}

function logResponse(response: IpcResponse) {
  console.log(
    JSON.stringify({
      scope: "ipc-response",
      id: response.id,
      ok: response.ok,
      error: response.error ?? null,
      result: response.result ?? null,
      timestamp: new Date().toISOString(),
    }, null, 2),
  );
}

function assertArg(value: string | undefined, name: string): asserts value is string {
  if (!value) {
    throw new Error(`Missing required argument: ${name}`);
  }
}

function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseOptionalNumberArg(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanupStaleSocket() {
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not clean up IPC socket ${socketPath}: ${message}`);
  }
}

function removeSocketFile() {
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch {}
}