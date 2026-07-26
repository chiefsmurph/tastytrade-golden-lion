import tastytradeApi from "./tastytrade-client";
import type { TastytradeCustomerAccountResource } from "./types";

// Read-only account primitives live in a dependency-free module so the broker
// chokepoint can import them without cycling back through the Tastytrade client.
// Re-exported here to preserve the existing import surface for current callers.
export { isReadOnlyAccount } from "./read-only-accounts";

function normalizeMarginOrCash(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

let customerAccountsPromise: ReturnType<
  typeof tastytradeApi.accountsAndCustomersService.getCustomerAccounts
> | null = null;

async function getCustomerAccounts() {
  customerAccountsPromise ??=
    tastytradeApi.accountsAndCustomersService.getCustomerAccounts();
  return customerAccountsPromise as Promise<TastytradeCustomerAccountResource[]>;
}

export async function getManagedAccountNumbers(): Promise<string[]> {
  const accounts = await getCustomerAccounts();

  return accounts
    .filter((item: TastytradeCustomerAccountResource) => item.account?.["is-closed"] !== true)
    .sort((left, right) => {
      const leftType = normalizeMarginOrCash(left.account?.["margin-or-cash"]);
      const rightType = normalizeMarginOrCash(right.account?.["margin-or-cash"]);

      if (leftType === rightType) {
        return String(left.account?.["account-number"] ?? "").localeCompare(
          String(right.account?.["account-number"] ?? ""),
        );
      }

      if (leftType === "margin") {
        return -1;
      }

      if (rightType === "margin") {
        return 1;
      }

      return 0;
    })
    .map((item: TastytradeCustomerAccountResource) => item.account?.["account-number"])
    .filter((accountNumber): accountNumber is string => Boolean(accountNumber));
}

export async function getMarginAccountNumber(): Promise<string> {
  const accounts = await getCustomerAccounts();
  const marginAccount = accounts.find(
    (item: TastytradeCustomerAccountResource) =>
      normalizeMarginOrCash(item.account?.["margin-or-cash"]) === "margin" &&
      item.account?.["is-closed"] !== true,
  );

  const accountNumber = marginAccount?.account?.["account-number"];
  if (!accountNumber) {
    throw new Error("No margin account available");
  }

  return accountNumber;
}

export async function getCashAccountNumber(): Promise<string> {
  const accounts = await getCustomerAccounts();
  const cashAccount = accounts.find(
    (item: TastytradeCustomerAccountResource) =>
      normalizeMarginOrCash(item.account?.["margin-or-cash"]) === "cash" &&
      item.account?.["is-closed"] !== true,
  );

  const accountNumber = cashAccount?.account?.["account-number"];
  if (!accountNumber) {
    throw new Error("No cash account available");
  }

  return accountNumber;
}

export async function getAccountMarginOrCash(
  accountNumber: string,
): Promise<"margin" | "cash" | "unknown"> {
  const normalizedAccountNumber = String(accountNumber).trim();
  if (!normalizedAccountNumber) {
    return "unknown";
  }

  const accounts = await getCustomerAccounts();
  const matchingAccount = accounts.find(
    (item: TastytradeCustomerAccountResource) =>
      item.account?.["account-number"] === normalizedAccountNumber,
  );
  const normalized = normalizeMarginOrCash(
    matchingAccount?.account?.["margin-or-cash"],
  );

  if (normalized === "margin") {
    return "margin";
  }

  if (normalized === "cash") {
    return "cash";
  }

  return "unknown";
}

export async function getDefaultAccountNumber(): Promise<string> {
  try {
    return await getMarginAccountNumber();
  } catch {
    const accountNumbers = await getManagedAccountNumbers();
    const accountNumber = accountNumbers[0];
    if (!accountNumber) {
      throw new Error("No account number available");
    }

    return accountNumber;
  }
}
