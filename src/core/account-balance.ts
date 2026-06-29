import { TastytradeAccountBalance } from "./types";

export function getAccountBalanceNumber(
  accountBalance: TastytradeAccountBalance,
  key: keyof TastytradeAccountBalance,
): number {
  const rawAccountBalance = accountBalance as unknown as Record<string, unknown>;
  const keyString = String(key);
  const alternateKey = keyString.includes("-")
    ? keyString
    : keyString
        .replace(/_/g, "-")
        .replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const rawValue = rawAccountBalance[keyString] ?? rawAccountBalance[alternateKey];
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getSignedPendingCash(accountBalance: TastytradeAccountBalance): number {
  const pendingCash = getAccountBalanceNumber(accountBalance, "pending-cash");
  const rawAccountBalance = accountBalance as unknown as Record<string, unknown>;
  const effect = String(rawAccountBalance["pending-cash-effect"] ?? "").toLowerCase();

  if (effect === "debit") {
    return -pendingCash;
  }

  return pendingCash;
}

export function getConservativeSpendableFunds(
  accountBalance: TastytradeAccountBalance,
): number {
  const candidates = [
    getAccountBalanceNumber(accountBalance, "cash-balance"),
    getAccountBalanceNumber(accountBalance, "derivative-buying-power"),
    getAccountBalanceNumber(accountBalance, "cash-settle-balance"),
  ].filter((value) => Number.isFinite(value) && value > 0);

  if (candidates.length === 0) {
    return 0;
  }

  return Math.min(...candidates);
}

export function getMarginSpendableFunds(
  accountBalance: TastytradeAccountBalance,
): number {
  const derivativeBuyingPower = getAccountBalanceNumber(
    accountBalance,
    "derivative-buying-power",
  );

  if (derivativeBuyingPower > 0) {
    return derivativeBuyingPower;
  }

  const availableTradingFunds = getAccountBalanceNumber(
    accountBalance,
    "available-trading-funds",
  );
  if (availableTradingFunds > 0) {
    return availableTradingFunds;
  }

  return getConservativeSpendableFunds(accountBalance);
}

function parseCashAccountMaxBuyingPowerPct(): number {
  const raw = process.env.BOT_CASH_ACCOUNT_MAX_BUYING_POWER_PCT;
  if (!raw) return 0.6;
  const parsed = Number(raw);
  // Leave at least 10% undeployed to avoid GFV the next day
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 0.9 ? parsed : 0.6;
}

const CASH_ACCOUNT_MAX_BUYING_POWER_PCT = parseCashAccountMaxBuyingPowerPct();

export function getSpendableFundsForAccountType(
  accountBalance: TastytradeAccountBalance,
  accountMarginOrCash: "margin" | "cash" | "unknown",
): number {
  if (accountMarginOrCash === "margin") {
    return getMarginSpendableFunds(accountBalance);
  }

  return getConservativeSpendableFunds(accountBalance) * CASH_ACCOUNT_MAX_BUYING_POWER_PCT;
}

export function getEffectiveTotalCapital(accountBalance: TastytradeAccountBalance): number {
  const derivativeBuyingPower = getAccountBalanceNumber(
    accountBalance,
    "derivative-buying-power",
  );
  const usedDerivativeBuyingPower = getAccountBalanceNumber(
    accountBalance,
    "used-derivative-buying-power",
  );
  const derivativeCapacity = derivativeBuyingPower + usedDerivativeBuyingPower;

  if (derivativeCapacity > 0) {
    return derivativeCapacity;
  }

  if (derivativeBuyingPower > 0) {
    return derivativeBuyingPower;
  }

  const equityBuyingPower = getAccountBalanceNumber(
    accountBalance,
    "equity-buying-power",
  );
  if (equityBuyingPower > 0) {
    return equityBuyingPower;
  }

  const netLiq = getAccountBalanceNumber(accountBalance, "net-liquidating-value");

  if (netLiq > 0) {
    return netLiq;
  }

  return netLiq + getSignedPendingCash(accountBalance);
}