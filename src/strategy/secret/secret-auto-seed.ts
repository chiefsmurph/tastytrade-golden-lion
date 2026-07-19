import seedSymbol from "~/bot/seed-symbol";
import { SECRET_AUTO_SEED_ORDER_SOURCE } from "~/bot/order-sources";
import { isWithinSecretAutoSeedWindow } from "~/strategy/seeding-windows";
import { getCashAccountNumber, getMarginAccountNumber } from "~/core/default-account";
import { SecretSourcePosition, SecretTickerRecPick } from "./types";
import { shouldSeedMarginFromBooleans, countGoodBooleans, getBooleanSurplusPct } from "~/strategy/position-gate";
import { recordPositionOpened } from "~/bot/position-registry";
import { toBooleanFlag } from "~/core/env-utils";

const lastCashAutoSeedAtBySymbol = new Map<string, number>();
const lastMarginAllSignalsSeedAtBySymbol = new Map<string, number>();

// ── Sticky "full thesis observed today" memory ──────────────────────────────
// The feed's thesis flags flicker tick-to-tick, so requiring full thesis at
// the exact tick the margin branch runs almost never fires (~1×/day) even
// though several tickers reach full thesis at SOME point each day. Instead:
// remember every ticker that hit full thesis at any point today, and seed
// margin when the feed is actively buying (willBuy) a remembered name. The
// quality bar is unchanged — full thesis must still have been genuinely
// observed today. Rolls over on calendar-date change (stored date string, no
// timers).
const fullThesisObservedTickers = new Set<string>();
let fullThesisObservedDateStr: string | null = null;

function normalizeTicker(ticker: unknown): string {
  return String(ticker ?? "")
    .trim()
    .toUpperCase();
}

// Records every position currently at full thesis (thesisCount/thesisMax >= 1,
// same bar as shouldSeedMarginFromBooleans). Clears the memory first when
// dateStr differs from the stored day — yesterday's conviction doesn't carry.
export function recordFullThesisObservations(
  positions: SecretSourcePosition[],
  dateStr: string,
): void {
  if (fullThesisObservedDateStr !== dateStr) {
    fullThesisObservedTickers.clear();
    fullThesisObservedDateStr = dateStr;
  }

  for (const position of positions) {
    if (!shouldSeedMarginFromBooleans(position)) {
      continue;
    }
    const symbol = normalizeTicker(position.ticker);
    if (symbol) {
      fullThesisObservedTickers.add(symbol);
    }
  }
}

// Read-only query: true only when the memory is for the same day AND the
// ticker was recorded at full thesis.
export function wasFullThesisObservedToday(
  ticker: string,
  dateStr: string,
): boolean {
  return (
    fullThesisObservedDateStr === dateStr &&
    fullThesisObservedTickers.has(normalizeTicker(ticker))
  );
}

// The margin seed condition: full thesis observed today (sticky) AND the feed
// is actively buying this name right now (willBuy at the current tick).
export function shouldSeedMarginSticky(
  position: SecretSourcePosition,
  dateStr: string,
): boolean {
  return (
    position.willBuy === true &&
    wasFullThesisObservedToday(normalizeTicker(position.ticker), dateStr)
  );
}

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
        usedItmFallback: result.usedItmFallback ?? false,
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

  // Record full-thesis observations on EVERY update tick, before any
  // filtering (including the seed window) — a flicker outside the window
  // still counts as "observed today" once the window opens.
  const observationDateStr = new Date().toDateString();
  recordFullThesisObservations(sourcePositions, observationDateStr);

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

    const side = normalizeSideForSeed(position) ?? "call";
    const goodBooleanScore = countGoodBooleans(position);
    const booleanSurplusPct = getBooleanSurplusPct(goodBooleanScore);

    if (toBooleanFlag(position.isQualityToBuy)) {
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
    }

    // Margin path is evaluated for every position (not gated on
    // isQualityToBuy): sticky full-thesis observation + current willBuy.
    if (hasSeparateMarginAccount && shouldSeedMarginSticky(position, observationDateStr)) {
      await maybeAutoSeedSymbol({
        symbol,
        side,
        scope: "secret-auto-seed-margin-all-signals",
        accountNumber: marginAccountNumber,
        cooldownMap: lastMarginAllSignalsSeedAtBySymbol,
        triggerReason: "secret-positions-update: full thesis observed today + willBuy",
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
