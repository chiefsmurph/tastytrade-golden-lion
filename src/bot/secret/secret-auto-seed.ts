import seedSymbol from "../seed-symbol";
import { SECRET_AUTO_SEED_ORDER_SOURCE } from "../order-sources";
import { isWithinSecretAutoSeedWindow } from "../seeding-windows";
import { getCashAccountNumber, getMarginAccountNumber } from "~/core/default-account";
import { SecretSourcePosition, SecretTickerRecPick } from "./types";
import { shouldSeedMarginFromBooleans } from "../cash-position-gate";

const lastCashAutoSeedAtBySymbol = new Map<string, number>();
const lastMarginAllSignalsSeedAtBySymbol = new Map<string, number>();

export function shouldAutoSeedOnSecretPositionsUpdate(): boolean {
  const raw =
    process.env.SECRET_AUTO_SEED_ON_POSITIONS_UPDATE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function shouldAutoSeedOnTickerRecsUpdate(): boolean {
  const raw =
    process.env.SECRET_AUTO_SEED_ON_TICKER_RECS_UPDATE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function isAnySecretAutoSeedEnabled(): boolean {
  return (
    shouldAutoSeedOnSecretPositionsUpdate() ||
    shouldAutoSeedOnTickerRecsUpdate()
  );
}

function getAutoSeedCooldownMs(): number {
  const raw = process.env.SECRET_AUTO_SEED_COOLDOWN_MS?.trim();
  if (!raw) {
    return 10 * 60 * 1000;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 10 * 60 * 1000;
  }

  return parsed;
}

function normalizeSideForSeed(
  position: SecretSourcePosition,
): "call" | "put" | null {
  const raw = String(position.side ?? "")
    .trim()
    .toLowerCase();
  if (raw === "call" || raw === "c") {
    return "call";
  }
  if (raw === "put" || raw === "p") {
    return "put";
  }

  return null;
}

function hasBuyEligible(position: SecretSourcePosition): boolean {
  const raw = position.buyEligible;

  if (typeof raw === "boolean") {
    return raw;
  }

  if (typeof raw === "number") {
    return raw === 1;
  }

  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function toBooleanFlag(raw: unknown): boolean {
  if (typeof raw === "boolean") {
    return raw;
  }

  if (typeof raw === "number") {
    return raw === 1;
  }

  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

async function maybeAutoSeedSymbol(options: {
  symbol: string;
  side: "call" | "put";
  scope: string;
  accountNumber: string;
  cooldownMap: Map<string, number>;
}): Promise<void> {
  const cooldownMs = getAutoSeedCooldownMs();
  const now = Date.now();
  const lastSeedAt = options.cooldownMap.get(options.symbol) ?? 0;
  if (now - lastSeedAt < cooldownMs) {
    return;
  }

  try {
    const result = await seedSymbol(options.symbol, options.side, options.accountNumber, {
      orderSource: SECRET_AUTO_SEED_ORDER_SOURCE,
      priceMode: "mid",
    });
    options.cooldownMap.set(options.symbol, now);
    console.log(
      JSON.stringify(
        {
          scope: options.scope,
          symbol: options.symbol,
          side: options.side,
          accountNumber: options.accountNumber,
          result,
          timestamp: new Date(now).toISOString(),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[${options.scope}] failed for ${options.symbol}: ${message}`);
  }
}

export async function maybeAutoSeedFromSecretPositions(
  sourcePositions: SecretSourcePosition[],
): Promise<void> {
  if (!shouldAutoSeedOnSecretPositionsUpdate()) {
    return;
  }

  if (!isWithinSecretAutoSeedWindow(new Date())) {
    return;
  }

  const [cashAccountNumber, marginAccountNumber] = await Promise.all([
    getCashAccountNumber(),
    getMarginAccountNumber(),
  ]);
  const hasSeparateMarginAccount = marginAccountNumber !== cashAccountNumber;

  for (const position of sourcePositions) {
    const symbol = String(position.ticker ?? "")
      .trim()
      .toUpperCase();
    if (!symbol) {
      continue;
    }

    if (!hasBuyEligible(position)) {
      continue;
    }

    const side = normalizeSideForSeed(position) ?? "call";

    await maybeAutoSeedSymbol({
      symbol,
      side,
      scope: "secret-auto-seed-cash",
      accountNumber: cashAccountNumber,
      cooldownMap: lastCashAutoSeedAtBySymbol,
    });

    if (hasSeparateMarginAccount && shouldSeedMarginFromBooleans(position)) {
      await maybeAutoSeedSymbol({
        symbol,
        side,
        scope: "secret-auto-seed-margin-all-signals",
        accountNumber: marginAccountNumber,
        cooldownMap: lastMarginAllSignalsSeedAtBySymbol,
      });
    }
  }
}

export async function maybeAutoSeedFromTickerRecs(
  picks: SecretTickerRecPick[],
): Promise<void> {
  if (!shouldAutoSeedOnTickerRecsUpdate()) {
    return;
  }

  if (!isWithinSecretAutoSeedWindow(new Date())) {
    return;
  }

  const cashAccountNumber = await getCashAccountNumber();

  for (const pick of picks) {
    const symbol = String(pick.ticker ?? "")
      .trim()
      .toUpperCase();
    if (!symbol) {
      continue;
    }

    if (!toBooleanFlag(pick.shouldBuy)) {
      continue;
    }

    await maybeAutoSeedSymbol({
      symbol,
      side: "call",
      scope: "secret-auto-seed-ticker-recs",
      accountNumber: cashAccountNumber,
      cooldownMap: lastCashAutoSeedAtBySymbol,
    });
  }
}
