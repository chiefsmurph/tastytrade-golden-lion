import { readEnvInt } from "~/core/env-utils";

// Underlyings the broker reported as "closing only" — opening trades are
// rejected at order dry-run. The restriction can lift intraday, so entries
// expire after a TTL: once expired, the next seed attempt re-checks with the
// broker rather than skipping forever. The TTL is the "retry every so often
// through the day" cadence.
const DEFAULT_CLOSING_ONLY_RETRY_MS = 30 * 60 * 1000; // 30 minutes

const closingOnlyUntilBySymbol = new Map<string, number>();

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export function getClosingOnlyRetryMs(): number {
  return readEnvInt("BOT_CLOSING_ONLY_RETRY_MS", DEFAULT_CLOSING_ONLY_RETRY_MS, (n) => n > 0);
}

// Record that the broker rejected an opening trade on this underlying as
// closing-only. Returns the timestamp after which we will retry.
export function recordClosingOnly(symbol: string, now: number = Date.now()): number {
  const until = now + getClosingOnlyRetryMs();
  closingOnlyUntilBySymbol.set(normalizeSymbol(symbol), until);
  return until;
}

// Returns the retry-after timestamp if the symbol is still within its skip
// window, or null if it is clear to attempt (never cached, or TTL expired).
// Expired entries are evicted on read so a lifted restriction self-heals.
export function getClosingOnlyRetryAt(
  symbol: string,
  now: number = Date.now(),
): number | null {
  const key = normalizeSymbol(symbol);
  const until = closingOnlyUntilBySymbol.get(key);
  if (until == null) {
    return null;
  }
  if (now >= until) {
    closingOnlyUntilBySymbol.delete(key);
    return null;
  }
  return until;
}

// The broker signals the restriction via a nested preflight error code
// ("closing_only") inside response.data.error.errors[].
export function isClosingOnlyDryRunError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errors = (
    error as Error & {
      response?: { data?: { error?: { errors?: Array<{ code?: string }> } } };
    }
  ).response?.data?.error?.errors;

  return Array.isArray(errors) && errors.some((issue) => issue?.code === "closing_only");
}

// Test hook: reset the module-level cache between cases.
export function clearClosingOnlyCache(): void {
  closingOnlyUntilBySymbol.clear();
}
