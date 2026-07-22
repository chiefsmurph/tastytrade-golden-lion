import tastytradeApi from "~/core/tastytrade-client";
import type { OrderPayload } from "./order-utils";
import { getMidpointPrice, normalizeInstrumentType, roundOrderPrice } from "./order-utils";
import { getMaxEntrySpreadPctForAccountType } from "~/strategy/liquidity-gate";
import { SPRAY_BUY_ORDER_SOURCE } from "../order-sources";
import {
  chaseCeiling,
  chaseTickSize,
  cumulativeAllowed,
  shouldAdvanceTick,
} from "./spray-ramp";
import {
  SprayRampRecord,
  SprayWorkingOrder,
  abortSpray,
  getSpray,
  isSprayComplete,
  loadActiveSprays,
  registerSpray,
  saveSpray,
} from "./spray-store";

// Spray-buy EXECUTOR — single tick-chaser vs a time-ramped cumulative target.
//
// Redesign (2026-07-21): the old model placed N concurrent STATIC limit slices
// and left unfilled ones behind — so on a fast runner (exactly the winner we
// want to size UP on) the static slices never filled as the price climbed and
// the whole sizing program silently under-filled. This executor replaces that
// with ONE working chasing order against a front-loaded cumulative target:
//
//   Per run cycle, for each active spray:
//     1. RE-READ the broker for the actual filled quantity on the working order
//        (and roll it into observedFilled — monotonic, so a cancel-vs-fill race
//        never double-counts).
//     2. Compute the currently-ALLOWED cumulative target from the ramp
//        (front-loaded; see spray-ramp.cumulativeAllowed).
//     3. If observedFilled < allowed, drive the SINGLE chasing order for the
//        SHORTFALL: place it (if none live) or advance it a tick (f-scaled
//        dwell) toward the ceiling (= ask, spread-gated).
//
//   At most ONE live order per contract at a time (single-order invariant) —
//   this kills the concurrent-chaser hazards (double-buy on cancel-vs-fill,
//   self-competition on thin books, muddy accounting). Everything keys off
//   OBSERVED fills → idempotent across cycles and restarts.
//
// The dwell (price-walk speed) is f-scaled: f = (limit − mid)/(ask − mid),
// recomputed against the LIVE book every cycle. Near mid → advance fast; near
// ask → be patient. On a runner the mid keeps rising above our limit so we stay
// near mid → fast; on a stagnant name we climb to near-ask → patient. No
// separate momentum detector.
//
// CASH-ONLY, flag-gated, DEFAULT OFF. Never a MARKET order. Never chases past
// the ask or into a spread wider than the entry gate. A hard deadline (spray
// window end ∧ market close) collapses patience (take the ask) then aborts.
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

// ---- env-tunable knobs (%-/time-only, no dollars) ------------------------

// The ramp window: how long the cumulative target takes to reach full. Spans
// several ~4min cycles by default.
function getSprayWindowMs(): number {
  return parsePositiveNumber(process.env.BOT_SPRAY_WINDOW_MS, 5 * 60 * 1000);
}

// Front-load driver in [0,1]: 0 linear ramp, 1 maximally front-loaded.
function getSprayFrontLoad(): number {
  const value = Number((process.env.BOT_SPRAY_FRONT_LOAD ?? "").trim());
  if (!Number.isFinite(value)) return 0.6;
  return Math.min(1, Math.max(0, value));
}

// Base dwell (ms) at f=0 (near mid): the fastest tick-advance interval.
function getSprayDwellBaseMs(): number {
  return parsePositiveNumber(process.env.BOT_SPRAY_DWELL_BASE_MS, 20 * 1000);
}

// Dwell steepness k in dwell = base·(1 + k·f²): larger => far more patient near
// the ask.
function getSprayDwellK(): number {
  const value = Number((process.env.BOT_SPRAY_DWELL_K ?? "").trim());
  return Number.isFinite(value) && value >= 0 ? value : 3;
}

// Number of tick steps the mid→ceiling gap is divided into (chase granularity).
function getSprayChaseSteps(): number {
  return Math.floor(parsePositiveNumber(process.env.BOT_SPRAY_CHASE_STEPS, 10));
}

// How long (ms) a spray may have quote-unavailable before it aborts itself so
// the seed logic can retry with a fresh contract. Default: 60 seconds.
function getSprayQuoteUnavailableAbortMs(): number {
  return parsePositiveNumber(process.env.BOT_SPRAY_QUOTE_UNAVAILABLE_ABORT_MS, 60 * 1000);
}

// Fraction of the window remaining, below which patience COLLAPSES: the chaser
// jumps straight to the ceiling (take the ask) instead of dwelling. Default:
// last 15% of the window.
function getSprayDeadlineCollapseFraction(): number {
  const value = Number((process.env.BOT_SPRAY_DEADLINE_COLLAPSE_FRACTION ?? "").trim());
  if (!Number.isFinite(value) || value <= 0) return 0.15;
  return Math.min(1, value);
}

// The knobs surfaced in the boot snapshot (config:show / startup-config).
export function getSprayBuyConfigSnapshot(): Record<string, unknown> {
  return {
    enabled: isSprayBuyEnabled(),
    windowMs: getSprayWindowMs(),
    frontLoad: getSprayFrontLoad(),
    dwellBaseMs: getSprayDwellBaseMs(),
    dwellK: getSprayDwellK(),
    chaseSteps: getSprayChaseSteps(),
    deadlineCollapseFraction: getSprayDeadlineCollapseFraction(),
    quoteUnavailableAbortMs: getSprayQuoteUnavailableAbortMs(),
  };
}

// ---- id / payload helpers ------------------------------------------------

function makeSprayId(
  accountNumber: string,
  contractSymbol: string,
  startedAtMs: number,
): string {
  return `${accountNumber}:${contractSymbol}:${startedAtMs}`;
}

function buildChaseOrder(
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

function extractOrderId(response: unknown): string | null {
  const id = (response as { order?: { id?: number | string } } | null | undefined)?.order?.id;
  if (id == null) return null;
  return String(id);
}

function toFiniteNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// Parse a broker order response into { status, filledQuantity }.
function parseOrderStatus(order: unknown): { status?: string; filledQuantity: number } {
  const raw = order as { status?: string; "size-filled"?: number | string } | null;
  return { status: raw?.status, filledQuantity: toFiniteNumber(raw?.["size-filled"]) };
}

// Parse a bid/ask quote into a usable { bid, ask }, or null when there's no ask.
// fallow-ignore-next-line complexity -- trivial parse; CRAP inflated by coverage attribution
function parseQuote(quote: unknown): { bid: number; ask: number } | null {
  const raw = quote as { bid?: number | string; ask?: number | string } | null;
  const bid = toFiniteNumber(raw?.bid);
  const ask = toFiniteNumber(raw?.ask);
  if (!(ask > 0)) return null;
  return { bid: bid > 0 ? bid : 0, ask };
}

// ---- placement (dependency-injectable for tests) -------------------------

export interface SprayDeps {
  now: () => number;
  placeLimitOrder: (
    accountNumber: string,
    order: OrderPayload,
  ) => Promise<{ orderId: string | null }>;
  cancelOrder: (accountNumber: string, orderId: string) => Promise<boolean>;
  getOrderStatus: (
    accountNumber: string,
    orderId: string,
  ) => Promise<{ status?: string; filledQuantity?: number } | null>;
  getBidAsk: (
    quoteSymbol: string,
  ) => Promise<{ bid: number; ask: number } | null>;
}

function liveDeps(): SprayDeps {
  return {
    now: () => Date.now(),
    placeLimitOrder: async (accountNumber, order) => {
      const response = await tastytradeApi.orderService.createOrder(accountNumber, order);
      return { orderId: extractOrderId(response) };
    },
    cancelOrder: async (accountNumber, orderId) => {
      const numericId = Number(orderId);
      if (!Number.isFinite(numericId)) return false;
      try {
        await tastytradeApi.orderService.cancelOrder(accountNumber, numericId);
        return true;
      } catch {
        return false;
      }
    },
    getOrderStatus: async (accountNumber, orderId) => {
      const numericId = Number(orderId);
      if (!Number.isFinite(numericId)) return null;
      const order = await tastytradeApi.orderService.getOrder(accountNumber, numericId);
      return parseOrderStatus(order);
    },
    getBidAsk: async (quoteSymbol) => {
      const quote = await tastytradeApi.johnsService.getBidAskForSymbol(quoteSymbol, 3000);
      return parseQuote(quote);
    },
  };
}

// Statuses that mean the working order is dead (cancelled/expired/rejected).
const DEAD_STATUSES = new Set([
  "Cancelled",
  "Canceled",
  "Rejected",
  "Expired",
  "Removed",
]);
// Statuses that mean the order is still live and should keep working.
const LIVE_STATUSES = new Set(["Received", "Routed", "In Flight", "Live", "Pending", "Open"]);

// ---- public API ----------------------------------------------------------

export interface StartSprayBuyInput {
  accountNumber: string;
  symbol: string;
  contractSymbol: string;
  side: "call" | "put";
  totalContracts: number;
  // The limit anchor at start (typically the ask). The chaser re-quotes against
  // the LIVE book each cycle; this only seeds the first placement and lets the
  // store round-trip without a live quote.
  limitPrice: number;
  orderSource?: string;
  windowMs?: number;
  frontLoad?: number;
  // Absolute epoch ms past which no further chasing may happen (market close).
  // The effective deadline is min(this, startedAt + windowMs).
  notAfterMs?: number;
  // Streamer/quote symbol for the live bid/ask read; defaults to contractSymbol.
  quoteSymbol?: string;
  // Account type for the spread-gate ceiling; defaults to "cash".
  accountType?: "margin" | "cash" | "unknown";
}

export interface StartSprayBuyResult {
  started: boolean;
  reason?: string;
  sprayId?: string;
  // The working chasing order id after the first cycle, if one was placed.
  firstSliceOrderId?: string | null;
  // Kept for API compatibility with #22's telemetry: the cumulative target
  // (contracts) the ramp will drive toward. (Formerly the discrete slice count.)
  scheduledSlices?: number;
}

// Begin a spray. Cash-only, flag-gated. Persists the ramp and immediately runs
// one advance cycle (which places the first chasing order for the shortfall
// unlocked at t=0). Idempotent by id — a restart that replays the same start
// resumes the in-flight ramp rather than double-firing.
// fallow-ignore-next-line complexity -- linear guard/setup sequence; unit-tested (spray-buy.test.ts), high CRAP is a coverage-attribution artifact
export async function startSprayBuy(
  input: StartSprayBuyInput,
  deps: SprayDeps = liveDeps(),
): Promise<StartSprayBuyResult> {
  if (!isSprayBuyEnabled()) {
    return { started: false, reason: "spray-buy disabled" };
  }
  const total = Math.floor(input.totalContracts);
  if (!(total >= 1) || !(input.limitPrice > 0)) {
    return { started: false, reason: "invalid spray target" };
  }

  const startedAtMs = deps.now();
  const windowMs = input.windowMs ?? getSprayWindowMs();
  const windowEndMs = startedAtMs + windowMs;
  const closeGuardMs = input.notAfterMs ?? Number.POSITIVE_INFINITY;
  const deadlineMs = Math.min(windowEndMs, closeGuardMs);
  const nowIso = new Date(startedAtMs).toISOString();
  const sprayId = makeSprayId(input.accountNumber, input.contractSymbol, startedAtMs);
  const quoteSymbol = input.quoteSymbol ?? input.contractSymbol;
  const accountType = input.accountType ?? "cash";

  const record: SprayRampRecord = {
    id: sprayId,
    accountNumber: input.accountNumber,
    symbol: input.symbol.toUpperCase(),
    contractSymbol: input.contractSymbol,
    side: input.side,
    orderSource: input.orderSource?.trim() || SPRAY_BUY_ORDER_SOURCE,
    quoteSymbol,
    accountType,
    startedAtMs,
    deadlineMs,
    totalContracts: total,
    windowMs,
    frontLoad: input.frontLoad ?? getSprayFrontLoad(),
    observedFilled: 0,
    workingOrder: null,
    aborted: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const stored = await registerSpray(record);

  // Whether we stored a fresh record or resumed an existing one, run one advance
  // so the first order lands / the in-flight ramp progresses. The quote symbol /
  // account type come from the STORED record (a resumed spray keeps its own).
  await advanceOneSpray(stored, deps);
  const refreshed = (await getSpray(sprayId)) ?? stored;

  return {
    started: true,
    reason: stored !== record ? "resumed existing spray" : undefined,
    sprayId,
    firstSliceOrderId: refreshed.workingOrder?.orderId ?? null,
    scheduledSlices: total,
  };
}

// Reconcile the single working order against the broker, folding any confirmed
// fill into observedFilled. observedFilled is ALWAYS recomputed as
//   working.filledBefore + <this order's live fill>
// so re-reading the same live order across cycles is idempotent (no double-
// count) and monotonic (Math.max guard against a broker reporting a lower fill).
// Returns whether the order is still live; a dead/filled order frees the slot.
// fallow-ignore-next-line complexity -- broker-status branching is inherent; unit-tested (spray-buy.test.ts), high CRAP is a coverage-attribution artifact
async function reconcileWorkingOrder(
  record: SprayRampRecord,
  deps: SprayDeps,
): Promise<{ stillLive: boolean }> {
  const working = record.workingOrder;
  if (!working) return { stillLive: false };

  let info: { status?: string; filledQuantity?: number } | null;
  try {
    info = await deps.getOrderStatus(record.accountNumber, working.orderId);
  } catch {
    // Transient — treat as still live, retry next cycle. Do NOT drop the slot
    // (dropping it would risk a second concurrent order = double-buy).
    return { stillLive: true };
  }

  const status = info?.status;
  const liveFill = Math.max(0, Math.floor(info?.filledQuantity ?? 0));
  // True cumulative = fills baked from retired orders + this order's live fill.
  // Never regress (broker eventual-consistency safety).
  const cumulative = Math.max(record.observedFilled, working.filledBefore + liveFill);
  record.observedFilled = cumulative;

  if (status === "Filled" || (status && DEAD_STATUSES.has(status))) {
    // Order retired (fully filled, or cancelled/expired without full fill): its
    // fill is already baked into observedFilled; free the slot.
    record.workingOrder = null;
    return { stillLive: false };
  }

  if (!status || (!LIVE_STATUSES.has(status) && status !== "Partially Filled")) {
    // Unknown status: be conservative and treat as still live (avoid a second
    // order); retry next cycle.
    return { stillLive: true };
  }

  return { stillLive: true };
}

// Cancel the working order and bake its confirmed fill into observedFilled
// BEFORE placing anything new. Returns false when cancellation can't be
// confirmed — in which case the caller must NOT place a second order (single-
// order invariant), to avoid a double-buy on a cancel-vs-fill race.
// fallow-ignore-next-line complexity -- unit-tested (spray-buy.test.ts), high CRAP is a coverage-attribution artifact
async function retireWorkingOrder(
  record: SprayRampRecord,
  deps: SprayDeps,
): Promise<boolean> {
  const working = record.workingOrder;
  if (!working) return true;

  // Re-read the fill one last time so a race (fill landed while we decided to
  // cancel) is captured, not lost.
  const { stillLive } = await reconcileWorkingOrder(record, deps);
  if (!record.workingOrder) return true; // it retired itself (filled/dead)
  if (!stillLive) {
    record.workingOrder = null;
    return true;
  }

  const cancelled = await deps.cancelOrder(record.accountNumber, working.orderId);
  if (!cancelled) {
    // Can't confirm cancel — leave it working, do NOT place a competitor.
    return false;
  }
  // Cancellation confirmed. Re-read once more to capture any fill that landed
  // between our decision and the cancel taking effect, then free the slot.
  await reconcileWorkingOrder(record, deps);
  record.workingOrder = null;
  return true;
}

// Place a fresh chasing order for `quantity` at `limitPrice`, recording the
// working slot. Returns whether it was placed.
async function placeChase(
  record: SprayRampRecord,
  quantity: number,
  limitPrice: number,
  deps: SprayDeps,
): Promise<boolean> {
  const order = buildChaseOrder(
    record.contractSymbol,
    quantity,
    limitPrice,
    record.orderSource,
  );
  let orderId: string | null;
  try {
    ({ orderId } = await deps.placeLimitOrder(record.accountNumber, order));
  } catch (err) {
    console.log(JSON.stringify({ scope: "spray-place-error", sprayId: record.id, symbol: record.symbol, contractSymbol: record.contractSymbol, quantity, limitPrice, error: String(err) }));
    return false;
  }
  if (!orderId) {
    console.log(JSON.stringify({ scope: "spray-place-no-order-id", sprayId: record.id, symbol: record.symbol, contractSymbol: record.contractSymbol, quantity, limitPrice }));
    return false;
  }
  const working: SprayWorkingOrder = {
    orderId,
    quantity,
    limitPrice,
    lastMoveMs: deps.now(),
    // Snapshot the cumulative fill from all retired orders so this order's live
    // fill is added on top without double-counting.
    filledBefore: record.observedFilled,
  };
  record.workingOrder = working;
  return true;
}

// The live-book chase context for one cycle: mid, spread-gated ceiling, whether
// we're in the deadline-collapse zone, the tick size, and the dwell config. Null
// when the book is unusable / the spread is blown out (caller must not chase).
interface ChaseContext {
  mid: number;
  ask: number;
  ceiling: number;
  collapse: boolean;
  tickSize: number;
  dwell: { baseMs: number; k: number };
}

// fallow-ignore-next-line complexity -- unit-tested (spray-buy.test.ts), high CRAP is a coverage-attribution artifact
async function resolveChaseContext(
  record: SprayRampRecord,
  now: number,
  deps: SprayDeps,
): Promise<ChaseContext | null> {
  const quote = await deps.getBidAsk(record.quoteSymbol);
  if (!quote) return null;
  const mid = getMidpointPrice(quote.bid, quote.ask);
  const maxSpreadPct = getMaxEntrySpreadPctForAccountType(record.accountType, new Date(now));
  const ceiling = chaseCeiling(quote.bid, quote.ask, maxSpreadPct);
  if (ceiling == null || !(mid > 0)) return null;

  // Deadline-collapse: in the final fraction of the window, take the ceiling
  // (ask) immediately instead of dwelling.
  const windowRemainingFrac =
    record.windowMs > 0 ? (record.deadlineMs - now) / record.windowMs : 0;
  return {
    mid,
    ask: quote.ask,
    ceiling,
    collapse: windowRemainingFrac <= getSprayDeadlineCollapseFraction(),
    tickSize: chaseTickSize(mid, ceiling, getSprayChaseSteps()),
    dwell: { baseMs: getSprayDwellBaseMs(), k: getSprayDwellK() },
  };
}

// Drive the SINGLE chasing order toward the shortfall given the live book: place
// it if none is live, else dwell or tick-up toward the ceiling. Mutates the
// record's working slot (does NOT persist — the caller does).
// fallow-ignore-next-line complexity -- place/dwell/tick decision tree is inherent; unit-tested (spray-buy.test.ts), high CRAP is a coverage-attribution artifact
async function driveWorkingOrder(
  record: SprayRampRecord,
  now: number,
  allowed: number,
  shortfall: number,
  ctx: ChaseContext,
  deps: SprayDeps,
): Promise<void> {
  const working = record.workingOrder;
  console.log(JSON.stringify({ scope: "spray-drive-debug", sprayId: record.id, symbol: record.symbol, hasWorking: !!working, shortfall, mid: ctx.mid, ceiling: ctx.ceiling, collapse: ctx.collapse }));
  if (!working) {
    // No live order: place one for the shortfall, starting at mid (or the
    // ceiling when collapsing / mid already at/above the ceiling).
    const startPrice = ctx.collapse ? ctx.ceiling : Math.min(ctx.mid, ctx.ceiling);
    await placeChase(record, shortfall, Math.max(startPrice, 0.01), deps);
    return;
  }

  // A live order exists. Re-price when we should advance a tick (f-scaled dwell),
  // are collapsing, or the shortfall changed (a prior order folded a fill).
  const sizeMismatch = working.quantity !== shortfall;
  const readyToAdvance =
    ctx.collapse ||
    shouldAdvanceTick(now - working.lastMoveMs, working.limitPrice, ctx.mid, ctx.ask, ctx.dwell) ||
    sizeMismatch;
  if (!readyToAdvance) return; // still dwelling at the current limit

  // Next limit: collapse jumps to the ceiling; otherwise step up one tick toward
  // it, but never below the live mid (re-anchor to a moving book — on a runner
  // the mid may have risen above our old limit).
  const anchored = Math.max(working.limitPrice, ctx.mid);
  const nextLimit = ctx.collapse ? ctx.ceiling : Math.min(ctx.ceiling, anchored + ctx.tickSize);
  if (Math.abs(nextLimit - working.limitPrice) < 1e-9 && !sizeMismatch) {
    return; // already at the ceiling with a matching size — re-placing is waste
  }

  // Retire the current order (baking any fill) before placing the successor. A
  // failed cancel means do NOT place a competitor (single-order invariant).
  if (!(await retireWorkingOrder(record, deps))) return;

  const remaining = allowed - record.observedFilled;
  if (remaining > 0 && !isSprayComplete(record)) {
    await placeChase(record, remaining, Math.max(nextLimit, 0.01), deps);
  }
}

// Advance one spray a single tick: reconcile, compute the shortfall vs the ramp,
// and place / re-price the ONE chasing order. Persists once at the end.
// fallow-ignore-next-line complexity -- orchestration is unit-tested (spray-buy.test.ts), high CRAP is a coverage-attribution artifact
async function advanceOneSpray(
  record: SprayRampRecord,
  deps: SprayDeps,
): Promise<void> {
  if (record.aborted || isSprayComplete(record)) {
    console.log(JSON.stringify({ scope: "spray-advance-skip", sprayId: record.id, aborted: record.aborted, observedFilled: record.observedFilled, totalContracts: record.totalContracts }));
    return;
  }

  const now = deps.now();
  await reconcileWorkingOrder(record, deps); // fold fills, free a dead slot

  // Deadline: past it, cancel any remainder and abort — no chasing past close.
  if (now >= record.deadlineMs) {
    console.log(JSON.stringify({ scope: "spray-advance-deadline", sprayId: record.id, now, deadlineMs: record.deadlineMs }));
    await retireWorkingOrder(record, deps);
    record.aborted = true;
    await saveSpray(record);
    return;
  }

  // Currently-allowed cumulative target (front-loaded ramp) vs observed fills.
  const allowed = cumulativeAllowed(now - record.startedAtMs, {
    totalContracts: record.totalContracts,
    windowMs: record.windowMs,
    frontLoad: record.frontLoad,
  });
  const shortfall = allowed - record.observedFilled;
  console.log(JSON.stringify({ scope: "spray-advance-shortfall", sprayId: record.id, symbol: record.symbol, allowed, observedFilled: record.observedFilled, shortfall, elapsed: now - record.startedAtMs }));

  // Only touch the book when there's a shortfall to chase; otherwise just persist
  // any reconciled state (a working order for a now-satisfied target can stay —
  // it only helps fill sooner).
  if (shortfall > 0) {
    const ctx = await resolveChaseContext(record, now, deps);
    if (ctx) {
      record.quoteUnavailableSinceMs = undefined;
      await driveWorkingOrder(record, now, allowed, shortfall, ctx, deps);
    } else {
      if (record.quoteUnavailableSinceMs == null) {
        record.quoteUnavailableSinceMs = now;
      }
      const unavailableMs = now - record.quoteUnavailableSinceMs;
      console.log(JSON.stringify({ scope: "spray-quote-unavailable", sprayId: record.id, symbol: record.symbol, contractSymbol: record.contractSymbol, quoteSymbol: record.quoteSymbol, unavailableMs }));
      if (unavailableMs >= getSprayQuoteUnavailableAbortMs()) {
        console.log(JSON.stringify({ scope: "spray-abort-no-quote", sprayId: record.id, symbol: record.symbol, contractSymbol: record.contractSymbol, unavailableMs }));
        record.aborted = true;
      }
    }
  }
  await saveSpray(record);
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
  console.log(JSON.stringify({ scope: "spray-advance-entry", activeCount: active.length, ids: active.map(r => r.id.slice(-20)) }));
  let completed = 0;
  for (const record of active) {
    await advanceOneSpray(record, deps);
    if (isSprayComplete(record)) {
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
