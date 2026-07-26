// Read-only account enforcement primitives.
//
// Deliberately dependency-free (only reads process.env) so it can be imported
// by both `default-account.ts` and the broker chokepoint in
// `tastytrade-order-service.ts` / `tastytrade-client.ts` without creating an
// import cycle through the Tastytrade client.

function normalizeAccountNumber(value: unknown): string {
  return String(value ?? "").trim();
}

function getReadOnlyAccountNumbers(): Set<string> {
  const raw = process.env.BOT_READ_ONLY_ACCOUNTS?.trim();
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map((part) => normalizeAccountNumber(part))
      .filter((part) => part.length > 0),
  );
}

export function isReadOnlyAccount(accountNumber: string): boolean {
  return getReadOnlyAccountNumbers().has(normalizeAccountNumber(accountNumber));
}

/**
 * Lowest mandatory boundary for read-only enforcement.
 *
 * Every real order placement/replacement/edit must cross this check before it
 * can reach the broker, regardless of caller (run-cycle, manual IPC, auto-seed).
 * Dry-run / preview endpoints are NOT guarded — they are non-mutating and are
 * legitimately used on read-only accounts for margin / effect calculations.
 */
export function assertNotReadOnly(accountNumber: string): void {
  if (isReadOnlyAccount(accountNumber)) {
    throw new Error(
      `Refusing to place order on read-only account ${accountNumber}`,
    );
  }
}
