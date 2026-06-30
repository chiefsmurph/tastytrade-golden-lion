import { promises as fs } from "node:fs";
import path from "node:path";
import { getAccountMarginOrCash } from "~/core/default-account";

export interface DayReportGroup {
  underlyingSymbol: string;
  side: "call" | "put" | "none";
  bidReturnPct: number;
  askReturnPct: number;
  midReturnPct: number;
  totalUnrealizedReturnBid: number;
  totalUnrealizedReturnAsk: number;
  totalUnrealizedReturnMid: number;
  totalCostBasis: number;
}

export interface DayReportEntry {
  id: string;
  accountNumber: string;
  date: string; // "YYYY-MM-DD" PST
  timestamp: string; // ISO 8601 UTC
  netLiquidatingValue: number;
  totalCapital: number;
  derivativeBuyingPower: number;
  cashBalance: number;
  groups: DayReportGroup[];
  summary: {
    openPositionCount: number;
    totalUnrealizedReturnBid: number;
    totalUnrealizedReturnAsk: number;
    totalUnrealizedReturnMid: number;
    totalCostBasis: number;
  };
}

export function getPstDateString(date?: Date): string {
  return (date ?? new Date()).toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });
}

export function getPstTimeInMinutes(date?: Date): number {
  const now = date ?? new Date();
  const pst = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  return pst.getHours() * 60 + pst.getMinutes();
}

function getDayReportDirectory(): string {
  return path.join(process.cwd(), "data", "day-reports");
}

function sanitizeAccountNumber(accountNumber: string): string {
  return String(accountNumber ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown-account";
}

async function getDayReportPath(accountNumber: string): Promise<string> {
  const safe = sanitizeAccountNumber(accountNumber);
  const accountType = await getAccountMarginOrCash(accountNumber);
  const suffix = accountType === "unknown" ? "" : `-${accountType}`;
  return path.join(getDayReportDirectory(), `${safe}${suffix}.ndjson`);
}

async function readDayReportFile(filePath: string): Promise<DayReportEntry[]> {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const parsed: DayReportEntry[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      parsed.push(JSON.parse(lines[i]) as DayReportEntry);
    } catch {}
  }
  return parsed;
}

export async function appendDayReport(
  input: Omit<DayReportEntry, "id" | "timestamp">,
): Promise<DayReportEntry> {
  const entry: DayReportEntry = {
    ...input,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date().toISOString(),
  };
  const filePath = await getDayReportPath(input.accountNumber);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export async function getLatestDayReport(
  accountNumber: string,
): Promise<DayReportEntry | null> {
  const filePath = await getDayReportPath(accountNumber);
  const entries = await readDayReportFile(filePath);
  return entries[0] ?? null;
}

export async function getDayReportForDate(
  accountNumber: string,
  date: string,
): Promise<DayReportEntry | null> {
  const filePath = await getDayReportPath(accountNumber);
  const entries = await readDayReportFile(filePath);
  return entries.find((e) => e.date === date) ?? null;
}

export async function getAllDayReports(
  accountNumber: string,
  limit = 20,
): Promise<DayReportEntry[]> {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
  const filePath = await getDayReportPath(accountNumber);
  const entries = await readDayReportFile(filePath);
  return entries.slice(0, normalizedLimit);
}

export async function getAllDayReportsAcrossAccounts(
  limit = 20,
): Promise<DayReportEntry[]> {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
  const dir = getDayReportDirectory();

  let fileNames: string[] = [];
  try {
    fileNames = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const ndjsonFiles = fileNames.filter((f) => f.endsWith(".ndjson"));
  const byFile = await Promise.all(
    ndjsonFiles.map((f) => readDayReportFile(path.join(dir, f))),
  );

  return byFile
    .flat()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, normalizedLimit);
}
