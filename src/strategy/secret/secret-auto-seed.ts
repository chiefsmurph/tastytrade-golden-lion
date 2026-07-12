import seedSymbol from "~/bot/seed-symbol";
import { SECRET_AUTO_SEED_ORDER_SOURCE } from "~/bot/order-sources";
import { isWithinSecretAutoSeedWindow } from "~/strategy/seeding-windows";
import { getCashAccountNumber, getMarginAccountNumber } from "~/core/default-account";
import { SecretSourcePosition, SecretTickerRecPick } from "./types";
import { shouldSeedMarginFromBooleans, countGoodBooleans, getBooleanSurplusPct, THESIS_MAX } from "~/strategy/position-gate";
import { recordPositionOpened } from "~/bot/position-registry";
import { toBooleanFlag } from "~/core/env-utils";

const lastCashAutoSeedAtBySymbol = new Map<string, number>();
const lastMarginAllSignalsSeedAtBySymbol = new Map<string, number>();

function shouldAutoSeedOnSecretPositionsUpdate(): boolean {
  const raw =
    process.env.SECRET_AUTO_SEED_ON_POSITIONS_UPDATE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function shouldAutoSeedOnTickerRecsUpdate(): boolean {
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

async function maybeAutoSeedSymbol(options: {
  symbol: string;
  side: "call" | "put";
  scope: string;
  accountNumber: string;
  cooldownMap: Map<string, number>;
  triggerReason?: string;
  goodBooleanScore?: number;
  booleanSurplusPct?: number;
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
    if (result.placedOrder) {
      await recordPositionOpened(options.accountNumber, options.symbol, options.side);
    }
    console.log(
      JSON.stringify({
        scope: options.scope,
        symbol: options.symbol,
        side: options.side,
        accountNumber: options.accountNumber,
        triggerReason: options.triggerReason ?? null,
        goodBooleanScore: options.goodBooleanScore ?? null,
        booleanSurplusPct: options.booleanSurplusPct ?? null,
        placedOrder: result.placedOrder,
        skippedReason: result.skippedReason ?? null,
        candidateSymbol: result.candidateSymbol ?? null,
        limitPrice: result.limitPrice ?? null,
        estimatedOrderCost: result.estimatedOrderCost ?? null,
        timestamp: new Date(now).toISOString(),
      }),
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

    if (!toBooleanFlag(position.isQualityToBuy)) {
      continue;
    }

    const side = normalizeSideForSeed(position) ?? "call";
    const goodBooleanScore = countGoodBooleans(position);
    const booleanSurplusPct = getBooleanSurplusPct(goodBooleanScore);

    await maybeAutoSeedSymbol({
      symbol,
      side,
      scope: "secret-auto-seed-cash",
      accountNumber: cashAccountNumber,
      cooldownMap: lastCashAutoSeedAtBySymbol,
      triggerReason: "secret-positions-update: isQualityToBuy",
      goodBooleanScore,
      booleanSurplusPct,
    });

    if (hasSeparateMarginAccount && shouldSeedMarginFromBooleans(position)) {
      await maybeAutoSeedSymbol({
        symbol,
        side,
        scope: "secret-auto-seed-margin-all-signals",
        accountNumber: marginAccountNumber,
        cooldownMap: lastMarginAllSignalsSeedAtBySymbol,
        triggerReason: `secret-positions-update: booleans ${goodBooleanScore}/${THESIS_MAX} good`,
        goodBooleanScore,
        booleanSurplusPct,
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
