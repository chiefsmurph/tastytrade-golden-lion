import { promises as fs } from "node:fs";
import path from "node:path";
import { getAccountMarginOrCash } from "~/core/default-account";

export interface RunPlanRow {
  estimatedCost: number;
  limitPrice: number;
  quantity: number;
  route: string;
  symbol: string;
  underlyingSymbol: string;
}

export interface RunPlanSelectedGroup {
  askWeight: number;
  bidWeight: number;
  currentReturnPct: number;
  groupKey: string;
  midWeight: number;
  rank: number;
  secretBuyWeight: number | null;
  strategyAction?: "MANAGE_ALLOCATION" | "CLOSE_POSITION";
  targetAccountExposure: number;
  targetDTE: number;
  underlyingSymbol: string;
}

import type { PositionGateResult } from "./cash-position-gate";

export interface RunGroupReturn {
  askReturnPct: number;
  bidReturnPct: number;
  positionGate: PositionGateResult | null;
  currentReturnPct: number;
  side: "call" | "put" | "none";
  buyWeight: number | null;
  daytradeScore: number | null;
  returnPerc: number | null;
  superRecScore: number | null;
  totalCostBasis: number;
  totalUnrealizedReturnAsk: number;
  totalUnrealizedReturnBid: number;
  underlyingSymbol: string;
}

export interface RunStrategyDecision {
  currentReturnPct: number;
  strategyAction: "MANAGE_ALLOCATION" | "CLOSE_POSITION";
  reason: string;
  underlyingSymbol: string;
}

export interface RunCloseOrderFill {
  fillId: string | null;
  fillPrice: number | null;
  filledAt: string | null;
  quantity: number | null;
}

export interface RunCloseOrder {
  orderId: string | null;
  placedOrder: boolean;
  price: number | null;
  skippedReason: string | null;
  status: string | null;
  symbol: string;
  underlyingSymbol: string;
  fills: RunCloseOrderFill[];
}

export interface RunSeedOrder {
  accountNumber: string;
  askReturnPctSource: number;
  candidateSymbol: string | null;
  estimatedOrderCost: number | null;
  limitPrice: number | null;
  placedOrder: boolean;
  scope: string;
  side: "call" | "put";
  skippedReason: string | null;
  sourceAccountNumber: string;
  symbol: string;
  triggerReason: string;
  goodBooleanScore: number | null;
  booleanSurplusPct: number | null;
}

export interface RunHistoryEntry {
  accountNumber: string;
  closeOrders: RunCloseOrder[];
  executionSummary: {
    allocationEstimatedTotal: number;
    allocationPlacedCount: number;
    allocationSkippedCount: number;
    cancelledOrderCount: number;
    closeOrderCount: number;
    seedEstimatedTotal?: number;
    seedPlacedCount?: number;
    seedSkippedCount?: number;
  };
  id: string;
  groups: RunGroupReturn[];
  plan: {
    diagnostics?: {
      currentReturnPct: number;
      groupKey?: string;
      skippedReason: string;
      strategyAction: "MANAGE_ALLOCATION" | "CLOSE_POSITION";
      underlyingSymbol: string;
    }[];
    ignoredGroups?: RunPlanSelectedGroup[];
    rows: RunPlanRow[];
    selectedGroups?: RunPlanSelectedGroup[];
    unselectedGroups?: RunPlanSelectedGroup[];
    totalContracts: number;
    totalEstimatedCost: number;
  };
  seedOrders?: RunSeedOrder[];
  strategyDecisions: RunStrategyDecision[];
  snapshot: {
    dynamicTakeProfitTarget: number;
    currentExposurePct: number;
    currentExposureValue: number;
    secondsSinceLastPositionsUpdate: number | null;
    routeWeights: {
      ask: number;
      bid: number;
      mid: number;
    };
    targetDTE: number;
    targetExposurePct: number;
    targetExposureValue: number;
    totalCapital: number;
  };
  timestamp: string;
}

export interface PublicRunGroupReturn {
  askReturnPct: number;
  bidReturnPct: number;
  currentReturnPct: number;
  side: "call" | "put" | "none";
  totalCostBasis: number;
  totalUnrealizedReturnAsk: number;
  totalUnrealizedReturnBid: number;
  underlyingSymbol: string;
}

export interface TickerRunGroupReturn extends PublicRunGroupReturn {
  account: "margin" | "cash" | "unknown";
}

export interface LastRunGroupsByTicker {
  aggregated: PublicRunGroupReturn | null;
  groups: TickerRunGroupReturn[];
}

export type LastRunGroupsByTickerMap = Record<string, LastRunGroupsByTicker>;

interface AppendRunHistoryInput {
  accountNumber: string;
  closeOrders: RunHistoryEntry["closeOrders"];
  executionSummary: RunHistoryEntry["executionSummary"];
  groups: RunHistoryEntry["groups"];
  plan: RunHistoryEntry["plan"];
  seedOrders?: RunHistoryEntry["seedOrders"];
  strategyDecisions: RunHistoryEntry["strategyDecisions"];
  snapshot: RunHistoryEntry["snapshot"];
}

type AccountTypeLabel = "margin" | "cash" | "unknown";

function sanitizeAccountNumberForPath(accountNumber: string): string {
  const normalized = String(accountNumber ?? "").trim();
  if (!normalized) {
    return "unknown-account";
  }

  return normalized.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function normalizeAccountTypeForFileName(accountType: string): AccountTypeLabel {
  if (accountType === "margin") {
    return "margin";
  }

  if (accountType === "cash") {
    return "cash";
  }

  return "unknown";
}

function getAccountTypeFromHistoryFileName(fileName: string): AccountTypeLabel {
  if (fileName.endsWith("-margin.ndjson")) {
    return "margin";
  }

  if (fileName.endsWith("-cash.ndjson")) {
    return "cash";
  }

  return "unknown";
}

function getRunHistoryDirectory(): string {
  const configuredDirectory = process.env.TASTYTRADE_BOT_RUN_HISTORY_DIR?.trim();
  if (configuredDirectory) {
    return configuredDirectory;
  }

  return path.join(process.cwd(), "data", "runs");
}

async function getRunHistoryPrimaryPathForAccount(accountNumber: string): Promise<string> {
  const safeAccountNumber = sanitizeAccountNumberForPath(accountNumber);
  const accountType = normalizeAccountTypeForFileName(
    await getAccountMarginOrCash(accountNumber),
  );

  if (accountType === "unknown") {
    return path.join(getRunHistoryDirectory(), `${safeAccountNumber}.ndjson`);
  }

  return path.join(getRunHistoryDirectory(), `${safeAccountNumber}-${accountType}.ndjson`);
}

async function getRunHistoryReadPathsForAccount(accountNumber: string): Promise<string[]> {
  const safeAccountNumber = sanitizeAccountNumberForPath(accountNumber);
  const legacyPath = path.join(getRunHistoryDirectory(), `${safeAccountNumber}.ndjson`);
  const primaryPath = await getRunHistoryPrimaryPathForAccount(accountNumber);

  if (primaryPath === legacyPath) {
    return [legacyPath];
  }

  return [primaryPath, legacyPath];
}

async function readRunHistoryFile(historyPath: string): Promise<RunHistoryEntry[]> {
  let raw = "";

  try {
    raw = await fs.readFile(historyPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const parsed: RunHistoryEntry[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      parsed.push(JSON.parse(lines[index]) as RunHistoryEntry);
    } catch {
      // Skip malformed lines to keep history readable even after partial writes.
    }
  }

  return parsed;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function normalizeTicker(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function toPublicGroup(group: RunGroupReturn): PublicRunGroupReturn {
  return {
    askReturnPct: group.askReturnPct,
    bidReturnPct: group.bidReturnPct,
    currentReturnPct: group.currentReturnPct,
    side: group.side,
    totalCostBasis: group.totalCostBasis,
    totalUnrealizedReturnAsk: group.totalUnrealizedReturnAsk,
    totalUnrealizedReturnBid: group.totalUnrealizedReturnBid,
    underlyingSymbol: group.underlyingSymbol,
  };
}

function aggregatePublicGroups(
  groups: PublicRunGroupReturn[],
  ticker: string,
): PublicRunGroupReturn | null {
  if (groups.length === 0) {
    return null;
  }

  const totalCostBasis = groups.reduce(
    (sum, group) => sum + (Number(group.totalCostBasis) || 0),
    0,
  );
  const totalUnrealizedReturnAsk = groups.reduce(
    (sum, group) => sum + (Number(group.totalUnrealizedReturnAsk) || 0),
    0,
  );
  const totalUnrealizedReturnBid = groups.reduce(
    (sum, group) => sum + (Number(group.totalUnrealizedReturnBid) || 0),
    0,
  );

  const hasMeaningfulCostBasis = totalCostBasis > 0;
  const askReturnPct = hasMeaningfulCostBasis
    ? totalUnrealizedReturnAsk / totalCostBasis
    : 0;
  const bidReturnPct = hasMeaningfulCostBasis
    ? totalUnrealizedReturnBid / totalCostBasis
    : 0;

  const uniqueSides = new Set(groups.map((group) => group.side));
  const side = uniqueSides.size === 1 ? groups[0]?.side ?? "none" : "none";

  return {
    askReturnPct,
    bidReturnPct,
    currentReturnPct: bidReturnPct,
    side,
    totalCostBasis,
    totalUnrealizedReturnAsk,
    totalUnrealizedReturnBid,
    underlyingSymbol: ticker,
  };
}

function parseTickersInput(rawTickers: string): string[] {
  return rawTickers
    .split(",")
    .map((ticker) => normalizeTicker(ticker))
    .filter((ticker) => ticker.length > 0);
}

export async function appendRunHistory(
  input: AppendRunHistoryInput,
): Promise<RunHistoryEntry> {
  const entry: RunHistoryEntry = {
    ...input,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date().toISOString(),
  };

  const historyPath = await getRunHistoryPrimaryPathForAccount(input.accountNumber);
  const legacyPath = path.join(
    getRunHistoryDirectory(),
    `${sanitizeAccountNumberForPath(input.accountNumber)}.ndjson`,
  );

  if (historyPath !== legacyPath) {
    const [legacyExists, primaryExists] = await Promise.all([
      pathExists(legacyPath),
      pathExists(historyPath),
    ]);

    if (legacyExists && !primaryExists) {
      await fs.mkdir(path.dirname(historyPath), { recursive: true });
      await fs.rename(legacyPath, historyPath);
    }
  }

  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.appendFile(historyPath, `${JSON.stringify(entry)}\n`, "utf8");

  return entry;
}

export async function getRecentRunHistory(
  limit = 20,
  accountNumber?: string,
): Promise<RunHistoryEntry[]> {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : 20;

  if (accountNumber?.trim()) {
    const accountReadPaths = await getRunHistoryReadPathsForAccount(accountNumber);
    const accountEntriesFromPaths = await Promise.all(
      accountReadPaths.map((historyPath) => readRunHistoryFile(historyPath)),
    );
    const accountEntries = accountEntriesFromPaths
      .flat()
      .sort((left, right) =>
        String(right.timestamp).localeCompare(String(left.timestamp)),
      );
    return accountEntries.slice(0, normalizedLimit);
  }

  const directoryPath = getRunHistoryDirectory();
  let fileNames: string[] = [];
  try {
    fileNames = await fs.readdir(directoryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const ndjsonFiles = fileNames.filter((fileName) => fileName.endsWith(".ndjson"));
  const entriesByFile = await Promise.all(
    ndjsonFiles.map((fileName) =>
      readRunHistoryFile(path.join(directoryPath, fileName)),
    ),
  );

  const merged = entriesByFile
    .flat()
    .sort((left, right) =>
      String(right.timestamp).localeCompare(String(left.timestamp)),
    );

  return merged.slice(0, normalizedLimit);
}

export async function getLastRunGroupsByTickers(
  rawTickers: string,
): Promise<LastRunGroupsByTickerMap> {
  const requestedTickers = Array.from(new Set(parseTickersInput(rawTickers)));

  if (requestedTickers.length === 0) {
    return {};
  }

  const result: LastRunGroupsByTickerMap = Object.fromEntries(
    requestedTickers.map((ticker) => [ticker, { groups: [], aggregated: null }]),
  );

  const directoryPath = getRunHistoryDirectory();
  let fileNames: string[] = [];
  try {
    fileNames = await fs.readdir(directoryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return result;
    }
    throw error;
  }

  const ndjsonFiles = fileNames.filter((fileName) => fileName.endsWith(".ndjson"));
  const entriesByFile = await Promise.all(
    ndjsonFiles.map(async (fileName) => {
      const entries = await readRunHistoryFile(path.join(directoryPath, fileName));
      return {
        accountType: getAccountTypeFromHistoryFileName(fileName),
        entries,
      };
    }),
  );

  const collected: Record<string, TickerRunGroupReturn[]> = Object.fromEntries(
    requestedTickers.map((ticker) => [ticker, []]),
  );

  // For each account (file), get the most recent entry and extract requested tickers
  for (const fileEntries of entriesByFile) {
    const { accountType, entries } = fileEntries;

    // Get the most recent entry for this account
    const mostRecentEntry = entries[0];
    if (!mostRecentEntry) {
      continue;
    }

    // Collect requested tickers from this account's most recent entry
    for (const ticker of requestedTickers) {
      const groupsForTicker = mostRecentEntry.groups
        .filter((group) => normalizeTicker(group.underlyingSymbol) === ticker)
        .map((group) => ({
          account: accountType,
          ...toPublicGroup(group),
        }));

      collected[ticker].push(...groupsForTicker);
    }
  }

  for (const ticker of requestedTickers) {
    const groups = collected[ticker]
      .slice()
      .sort((left, right) => left.account.localeCompare(right.account));
    result[ticker] = {
      groups,
      aggregated: aggregatePublicGroups(groups, ticker),
    };
  }

  return result;
}
