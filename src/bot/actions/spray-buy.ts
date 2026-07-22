import tastytradeApi from "~/core/tastytrade-client";
import type { OrderPayload } from "./order-utils";
import { normalizeInstrumentType, roundOrderPrice } from "./order-utils";
import { SPRAY_BUY_ORDER_SOURCE } from "../order-sources";
import {
  SpraySliceState,
  buildSpraySchedule,
  getDueSlices,
  summarizeSprayProgress,
} from "./spray-schedule";
import {
  SprayRecord,
  abortSpray,
  loadActiveSprays,
  registerSpray,
  updateSpraySlices,
} from "./spray-store";

// Front-loaded spray-buy EXECUTOR.
//
// Ties the pure schedule math (spray-schedule) and the cross-cycle store
// (spray-store) to the broker. Buy paths OPT INTO it behind a flag; it is
// CASH-ONLY and DEFAULT OFF. When off, startSprayBuy is a no-op and callers use
// their existing single-order path unchanged.
//
// Lifecycle:
//   - startSprayBuy(): builds a front-loaded schedule, persists it, and places
//     the first (largest) LIMIT slice immediately.
//   - advanceSprays(): called once per run cycle. For every active spray it
//     (a) reconciles already-placed slices against the broker (fill/expire),
//     (b) aborts remaining slices whose due time is past the market-close guard,
//     and (c) places any newly-due LIMIT slices. Partial fills are accepted;
//     later slices that don't fill are simply left behind (no chasing).
//
// Never places a MARKET order. Never spills a slice past notAfterMs (close).
//
// Conventions: module vars + exported fns, no classes / `this`.

// ---- flag ----------------------------------------------------------------

// Master switch. DEFAULT OFF. Env-overridable. Any of 1/true/yes enables it.
export function isSprayBuyEnabled(): boolean {
  const raw = (process.env.BOT_SPRAY_BUY_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number((raw ?? "").trim());
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getSprayWindowMs(): number {
  // Default 5-minute spray window (spans multiple ~4min cycles).
  return parsePositiveNumber(process.env.BOT_SPRAY_WINDOW_MS, 5 * 60 * 1000);
}

function getSpraySliceCount(): number {
  return Math.floor(parsePositiveNumber(process.env.BOT_SPRAY_SLICE_COUNT, 3));
}

function getSprayFrontLoadBias(): number {
  const value = Number((process.env.BOT_SPRAY_FRONT_LOAD_BIAS ?? "").trim());
  if (!Number.isFinite(value)) return 0.6;
  return Math.min(1, Math.max(0, value));
}

// ---- id / payload helpers ------------------------------------------------

export function makeSprayId(
  accountNumber: string,
  contractSymbol: string,
  startedAtMs: number,
): string {
  return `${accountNumber}:${contractSymbol}:${startedAtMs}`;
}

function buildSliceOrder(
  contractSymbol: string,
  quantity: number,
  limitPrice: number,
  orderSource: string,
): OrderPayload {
  return {
    source: orderSource,
    "time-in-force": "Day",
    "order-type": "Limit",
    price: roundOrderPrice(limitPrice),
    "price-effect": "Debit",
    legs: [
      {
        action: "Buy to Open",
        symbol: contractSymbol,
        quantity,
        "instrument-type": normalizeInstrumentType("Equity Option"),
      },
    ],
  };
}

// Extract the order id (string) from a placed-order response, or null.
function extractOrderId(response: unknown): string | null {
  const id = (response as { order?: { id?: number | string } } | null | undefined)?.order?.id;
  if (id == null) return null;
  return String(id);
}

// ---- placement (dependency-injectable for tests) -------------------------

export interface SprayDeps {
  now: () => number;
  placeLimitOrder: (
    accountNumber: string,
    order: OrderPayload,
  ) => Promise<{ orderId: string | null }>;
  getOrderStatus: (
    accountNumber: string,
    orderId: string,
  ) => Promise<{ status?: string; filledQuantity?: number } | null>;
}

function liveDeps(): SprayDeps {
  return {
    now: () => Date.now(),
    placeLimitOrder: async (accountNumber, order) => {
      const response = await tastytradeApi.orderService.createOrder(accountNumber, order);
      return { orderId: extractOrderId(response) };
    },
    getOrderStatus: async (accountNumber, orderId) => {
      const numericId = Number(orderId);
      if (!Number.isFinite(numericId)) return null;
      const order = await tastytradeApi.orderService.getOrder(accountNumber, numericId);
      const status = (order as { status?: string } | null)?.status;
      const filledQuantity = Number(
        (order as { "size-filled"?: number | string } | null)?.["size-filled"] ?? 0,
      );
      return { status, filledQuantity: Number.isFinite(filledQuantity) ? filledQuantity : 0 };
    },
  };
}

const FILLED_STATUSES = new Set(["Filled", "Partially Filled"]);
// Statuses that mean the slice is done and did NOT (fully) fill — free to leave
// behind. A live/pending order stays "placed" until it resolves.
const DEAD_STATUSES = new Set([
  "Cancelled",
  "Canceled",
  "Rejected",
  "Expired",
  "Removed",
]);

// ---- public API ----------------------------------------------------------

export interface StartSprayBuyInput {
  accountNumber: string;
  symbol: string;
  contractSymbol: string;
  side: "call" | "put";
  totalContracts: number;
  limitPrice: number;
  orderSource?: string;
  windowMs?: number;
  slices?: number;
  frontLoadBias?: number;
  // Absolute epoch ms past which no further slice may be placed (market close).
  notAfterMs?: number;
}

export interface StartSprayBuyResult {
  started: boolean;
  reason?: string;
  sprayId?: string;
  firstSliceOrderId?: string | null;
  scheduledSlices?: number;
}

// Begin a spray. Cash-only, flag-gated. Builds a front-loaded schedule,
// persists it, and fires the first (largest) slice immediately. Idempotent by
// id — a restart that replays the same start does not double-fire slice 0.
export async function startSprayBuy(
  input: StartSprayBuyInput,
  deps: SprayDeps = liveDeps(),
): Promise<StartSprayBuyResult> {
  if (!isSprayBuyEnabled()) {
    return { started: false, reason: "spray-buy disabled" };
  }
  if (!(input.totalContracts >= 1) || !(input.limitPrice > 0)) {
    return { started: false, reason: "invalid spray target" };
  }

  const startedAtMs = deps.now();
  const windowMs = input.windowMs ?? getSprayWindowMs();
  const schedule = buildSpraySchedule({
    totalContracts: Math.floor(input.totalContracts),
    windowMs,
    slices: input.slices ?? getSpraySliceCount(),
    frontLoadBias: input.frontLoadBias ?? getSprayFrontLoadBias(),
  });
  if (schedule.length === 0) {
    return { started: false, reason: "empty schedule" };
  }

  const sprayId = makeSprayId(input.accountNumber, input.contractSymbol, startedAtMs);
  const slices: SpraySliceState[] = schedule.map((spec) => ({
    ...spec,
    status: "pending",
  }));
  const nowIso = new Date(startedAtMs).toISOString();

  const record: SprayRecord = {
    id: sprayId,
    accountNumber: input.accountNumber,
    symbol: input.symbol.toUpperCase(),
    contractSymbol: input.contractSymbol,
    side: input.side,
    orderSource: input.orderSource?.trim() || SPRAY_BUY_ORDER_SOURCE,
    startedAtMs,
    notAfterMs: input.notAfterMs ?? Number.POSITIVE_INFINITY,
    limitPrice: input.limitPrice,
    slices,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const stored = await registerSpray(record);
  // If an identical spray already existed (restart replay), just advance it.
  if (stored !== record) {
    await advanceOneSpray(stored, deps);
    return {
      started: true,
      reason: "resumed existing spray",
      sprayId,
      scheduledSlices: stored.slices.length,
    };
  }

  const updated = await placeDueSlices(record, deps);
  const firstSlice = updated.slices.find((slice) => slice.index === 0);

  return {
    started: true,
    sprayId,
    firstSliceOrderId: firstSlice?.orderId ?? null,
    scheduledSlices: updated.slices.length,
  };
}

// Place every currently-due slice on a record (mutates record.slices), guarding
// against the market-close cutoff, and persist. Returns the record.
async function placeDueSlices(
  record: SprayRecord,
  deps: SprayDeps,
): Promise<SprayRecord> {
  const elapsedMs = deps.now() - record.startedAtMs;
  const due = getDueSlices(record.slices, elapsedMs);
  let mutated = false;

  // A non-finite / missing guard (JSON turns Infinity into null on round-trip)
  // means "no close cutoff" — never let that read as 0 and abort everything.
  const closeGuardMs = Number.isFinite(record.notAfterMs)
    ? record.notAfterMs
    : Number.POSITIVE_INFINITY;

  for (const slice of due) {
    // Never place past the market-close guard — abort instead of spilling over.
    if (deps.now() >= closeGuardMs) {
      slice.status = "aborted";
      mutated = true;
      continue;
    }
    const order = buildSliceOrder(
      record.contractSymbol,
      slice.quantity,
      record.limitPrice,
      record.orderSource,
    );
    try {
      const { orderId } = await deps.placeLimitOrder(record.accountNumber, order);
      slice.status = "placed";
      slice.orderId = orderId ?? undefined;
    } catch {
      // Placement failed this cycle; leave pending to retry next cycle (still
      // subject to the close guard). Do not abort on a transient error.
    }
    mutated = true;
  }

  if (mutated) {
    await updateSpraySlices(record.id, record.slices);
  }
  return record;
}

// Reconcile a spray's already-placed slices against the broker: mark filled or
// dead. Placed slices with no order id (placement response lacked one) are
// re-checked as unknown and left placed until they can be resolved.
async function reconcilePlacedSlices(
  record: SprayRecord,
  deps: SprayDeps,
): Promise<boolean> {
  let mutated = false;
  for (const slice of record.slices) {
    if (slice.status !== "placed" || !slice.orderId) continue;
    let info: { status?: string; filledQuantity?: number } | null;
    try {
      info = await deps.getOrderStatus(record.accountNumber, slice.orderId);
    } catch {
      continue; // transient; retry next cycle
    }
    const status = info?.status;
    if (status && FILLED_STATUSES.has(status)) {
      slice.status = "filled";
      slice.filledQuantity =
        info?.filledQuantity && info.filledQuantity > 0
          ? info.filledQuantity
          : slice.quantity;
      mutated = true;
    } else if (!status || DEAD_STATUSES.has(status)) {
      // Order vanished / cancelled / expired without filling: leave it behind.
      slice.status = "aborted";
      mutated = true;
    }
    // Otherwise (Pending / Open / Live): still working, leave placed.
  }
  return mutated;
}

// Advance a single spray one tick: reconcile placed slices, then release any
// newly-due slices (close-guarded). Persists once at the end.
async function advanceOneSpray(record: SprayRecord, deps: SprayDeps): Promise<void> {
  const reconciled = await reconcilePlacedSlices(record, deps);
  if (reconciled) {
    await updateSpraySlices(record.id, record.slices);
  }
  await placeDueSlices(record, deps);
}

export interface AdvanceSpraysResult {
  advanced: number;
  completed: number;
}

// Per-cycle entry point. Loads all active sprays and advances each. Safe to
// call every run cycle; a no-op when spray-buy is disabled or nothing pending.
export async function advanceSprays(
  deps: SprayDeps = liveDeps(),
): Promise<AdvanceSpraysResult> {
  if (!isSprayBuyEnabled()) {
    return { advanced: 0, completed: 0 };
  }
  const active = await loadActiveSprays();
  let completed = 0;
  for (const record of active) {
    await advanceOneSpray(record, deps);
    if (summarizeSprayProgress(record.slices).isComplete) {
      completed += 1;
    }
  }
  return { advanced: active.length, completed };
}

// Abort a spray on signal change / stop / thesis flip. Keeps whatever filled,
// walks away from the rest. Idempotent; safe when the id is unknown.
export async function abortSprayBuy(sprayId: string): Promise<void> {
  await abortSpray(sprayId);
}
