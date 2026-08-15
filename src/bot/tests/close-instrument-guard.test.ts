import test from "node:test";
import assert from "node:assert/strict";

import type { CurrentPosition } from "~/core/types";
import type { PositionGroupEvaluation } from "~/bot/evaluate-position";
import { getGroupSideForPositions, groupPositionsByUnderlying } from "~/bot/evaluate-position";
import { buildClosingOrderPayload } from "~/bot/actions/order-utils";
import { evaluateTradingStrategy } from "~/strategy/evaluate-trading-strategy";
import {
  CLOSE_INSTRUMENT_SUPPRESSED_TOKEN,
  getPositionInstrumentType,
  isCloseBlockedByInstrumentGuard,
  isCloseInstrumentGuardEnabled,
  isOpenableInstrument,
  partitionClosesByInstrumentGuard,
  suppressCloseForInstrumentGuard,
} from "~/bot/close-instrument-guard";
import {
  buildCloseSymbolPositionResult,
  buildOperatorRequestLabel,
  partitionOperatorCloseTargets,
} from "~/bot/close-symbol-position";
import { localTimeAt, minutesBefore } from "./test-clock";

// The engine reads time-of-day off the LOCAL clock, so every fixture time comes
// from the shared hermetic clock. 12:55 is past EOD_ARMED_MINUTE (12:50).
const MARGIN_EOD_TIME = localTimeAt(12, 55);

const GUARD_ENV = "BOT_CLOSE_ONLY_OPENABLE_INSTRUMENTS";

function withEnv(value: string | undefined, fn: () => void): void {
  const previous = process.env[GUARD_ENV];
  if (value === undefined) delete process.env[GUARD_ENV];
  else process.env[GUARD_ENV] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[GUARD_ENV];
    else process.env[GUARD_ENV] = previous;
  }
}

/**
 * The owner's hand-bought share lot, exactly as the broker reports it: a bare
 * ticker for a symbol, no `underlying-symbol`, `instrument-type: "Equity"`.
 */
function equityPosition(overrides: Partial<CurrentPosition> = {}): CurrentPosition {
  return {
    "account-number": "MARGIN-TEST",
    symbol: "TDUP",
    "instrument-type": "Equity",
    quantity: 450,
    "quantity-direction": "Long",
    "average-open-price": 3.2611,
    multiplier: 1,
    ...overrides,
  } as CurrentPosition;
}

function optionPosition(overrides: Partial<CurrentPosition> = {}): CurrentPosition {
  return {
    "account-number": "MARGIN-TEST",
    symbol: "TDUP  260918C00004000",
    "instrument-type": "Equity Option",
    "underlying-symbol": "TDUP",
    quantity: 5,
    "quantity-direction": "Long",
    "average-open-price": 0.45,
    multiplier: 100,
    ...overrides,
  } as CurrentPosition;
}

function evaluationFor(
  positions: CurrentPosition[],
  bid: number,
  ask: number,
  fill: number,
): PositionGroupEvaluation {
  const underlyingSymbol = String(
    positions[0]["underlying-symbol"] ?? positions[0].symbol,
  );
  const metrics = {
    currentBidPrice: bid,
    currentAskPrice: ask,
    weightedAverageFill: fill,
    currentTime: MARGIN_EOD_TIME,
    lastActionTime: minutesBefore(MARGIN_EOD_TIME, 90),
  };
  return {
    groupKey: `${underlyingSymbol}::${getGroupSideForPositions(positions)}`,
    underlyingSymbol,
    positions,
    positionSnapshots: positions.map((position) => ({
      position,
      currentBidPrice: bid,
      currentAskPrice: ask,
      weightedAverageFill: fill,
      quantityWeight: Math.abs(Number(position.quantity) || 0),
      lastActionTime: metrics.lastActionTime,
    })),
    metrics,
    strategy: evaluateTradingStrategy(metrics, "margin"),
    currentReturn: (bid - fill) / fill,
  };
}

// ---------------------------------------------------------------------------
// The regression. This is the exact shape that filled four times.
// ---------------------------------------------------------------------------

test("REGRESSION: an Equity position in the margin account at 12:55 PT dispatches no closing order", () => {
  const evaluation = evaluationFor([equityPosition()], 3.1, 3.12, 3.2611);

  // 1. The group is a first-class citizen of the engine: a share lot has no C/P
  //    suffix, so it keys as `TDUP::none` and every strategy branch sees it.
  assert.equal(evaluation.groupKey, "TDUP::none");

  // 2. The strategy STILL says close, and it always will — `PositionMetrics` is
  //    bid/ask/fill/two timestamps, so the instrument type never reaches the
  //    strategy layer and no guard is possible there even in principle.
  assert.equal(evaluation.strategy.action, "CLOSE_POSITION");
  assert.match(evaluation.strategy.reason, /liquidate all positions immediately/);
  assert.equal(evaluation.strategy.isUrgentClose, true);

  // 3. The asymmetry that made it live: the closing payload reads the instrument
  //    type off the POSITION, so it would happily emit an Equity sell leg —
  //    while every buy path hard-codes "Equity Option".
  const payload = buildClosingOrderPayload(evaluation.positionSnapshots[0]);
  assert.equal(payload?.legs[0]["instrument-type"], "Equity");
  assert.equal(payload?.legs[0].action, "Sell to Close");
  assert.equal(payload?.legs[0].quantity, 450);

  // 4. THE INVARIANT: the dispatcher must withhold that order.
  const { dispatch, suppressed } = partitionClosesByInstrumentGuard([evaluation]);
  assert.deepEqual(dispatch, [], "no closing order may be dispatched for equity");
  assert.equal(suppressed.length, 1);
});

test("the suppressed close is reported, not silently dropped", () => {
  const evaluation = evaluationFor([equityPosition()], 3.1, 3.12, 3.2611);
  const results = suppressCloseForInstrumentGuard({
    accountNumber: "MARGIN-TEST",
    dispatchSite: "cycle-close",
    evaluation,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].placedOrder, false);
  assert.equal(results[0].symbol, "TDUP");
  assert.equal(results[0].underlyingSymbol, "TDUP");
  assert.match(results[0].skippedReason ?? "", /instrument guard/);
  assert.match(results[0].skippedReason ?? "", /Equity/);
});

// ---------------------------------------------------------------------------
// The invariant must not cost us a single option exit.
// ---------------------------------------------------------------------------

test("an Equity Option group still closes normally at the same EOD moment", () => {
  const evaluation = evaluationFor([optionPosition()], 0.4, 0.5, 0.45);

  assert.equal(evaluation.groupKey, "TDUP::call");
  assert.equal(evaluation.strategy.action, "CLOSE_POSITION");
  assert.equal(isCloseBlockedByInstrumentGuard(evaluation), false);

  const { dispatch, suppressed } = partitionClosesByInstrumentGuard([evaluation]);
  assert.equal(dispatch.length, 1);
  assert.deepEqual(suppressed, []);
});

test("a mixed batch splits: options dispatch, equity is withheld", () => {
  const option = evaluationFor([optionPosition()], 0.4, 0.5, 0.45);
  const equity = evaluationFor([equityPosition()], 3.1, 3.12, 3.2611);

  const { dispatch, suppressed } = partitionClosesByInstrumentGuard([option, equity]);
  assert.deepEqual(
    dispatch.map((e) => e.groupKey),
    ["TDUP::call"],
  );
  assert.deepEqual(
    suppressed.map((e) => e.groupKey),
    ["TDUP::none"],
  );
});

test("one non-openable leg makes the whole group hands-off (a pile can't be split)", () => {
  // Contrived: the bot cannot sell "only the option part" of a mixed group, so
  // any non-openable member withholds the whole close.
  const mixed = evaluationFor([optionPosition(), equityPosition()], 0.4, 0.5, 0.45);
  assert.equal(isCloseBlockedByInstrumentGuard(mixed), true);
});

// ---------------------------------------------------------------------------
// The operator IPC close (`closeSymbolPosition`), which had NO protection at all
// ---------------------------------------------------------------------------

function silenceWarnings<T>(fn: () => T): T {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = originalWarn;
  }
}

test("operator close with no side matches ::none — and the equity leg is withheld", () => {
  delete process.env.BOT_DO_NOT_TOUCH_GROUPS;
  const option = evaluationFor([optionPosition()], 0.4, 0.5, 0.45);
  const equity = evaluationFor([equityPosition()], 3.1, 3.12, 3.2611);

  const targets = silenceWarnings(() =>
    partitionOperatorCloseTargets("MARGIN-TEST", [option, equity], "operator TDUP"),
  );

  assert.deepEqual(
    targets.closeable.map((e) => e.groupKey),
    ["TDUP::call"],
  );
  assert.deepEqual(targets.suppressedGroupKeys, ["TDUP::none"]);
  assert.equal(targets.suppressedResults.length, 1);
  assert.equal(targets.suppressedResults[0].placedOrder, false);
  assert.match(targets.suppressedResults[0].skippedReason ?? "", /instrument guard/);
});

test("the operator close now honours BOT_DO_NOT_TOUCH_GROUPS (it previously did not)", () => {
  const option = evaluationFor([optionPosition()], 0.4, 0.5, 0.45);
  process.env.BOT_DO_NOT_TOUCH_GROUPS = "TDUP::call";
  try {
    const targets = partitionOperatorCloseTargets("MARGIN-TEST", [option], "operator TDUP");
    assert.deepEqual(targets.closeable, []);
    assert.deepEqual(targets.suppressedGroupKeys, ["TDUP::call"]);
    assert.match(
      targets.suppressedResults[0].skippedReason ?? "",
      /do-not-touch group TDUP::call/,
    );
  } finally {
    delete process.env.BOT_DO_NOT_TOUCH_GROUPS;
  }
});

test("an unprotected option group still closes on operator request", () => {
  delete process.env.BOT_DO_NOT_TOUCH_GROUPS;
  const option = evaluationFor([optionPosition()], 0.4, 0.5, 0.45);
  const targets = partitionOperatorCloseTargets("MARGIN-TEST", [option], "operator TDUP");
  assert.deepEqual(
    targets.closeable.map((e) => e.groupKey),
    ["TDUP::call"],
  );
  assert.deepEqual(targets.suppressedGroupKeys, []);
  assert.deepEqual(targets.suppressedResults, []);
});

test("operator close: the kill switch re-exposes the equity leg, do-not-touch still holds", () => {
  delete process.env.BOT_DO_NOT_TOUCH_GROUPS;
  const equity = evaluationFor([equityPosition()], 3.1, 3.12, 3.2611);
  withEnv("false", () => {
    const targets = partitionOperatorCloseTargets("MARGIN-TEST", [equity], "operator TDUP");
    assert.deepEqual(
      targets.closeable.map((e) => e.groupKey),
      ["TDUP::none"],
    );
  });

  process.env.BOT_DO_NOT_TOUCH_GROUPS = "TDUP::stock";
  try {
    withEnv("false", () => {
      // Guard disarmed, but the `::stock` <-> `::none` alias still protects it.
      const targets = partitionOperatorCloseTargets("MARGIN-TEST", [equity], "operator TDUP");
      assert.deepEqual(targets.closeable, []);
      assert.deepEqual(targets.suppressedGroupKeys, ["TDUP::none"]);
    });
  } finally {
    delete process.env.BOT_DO_NOT_TOUCH_GROUPS;
  }
});

test("operator reply: an all-protected request reports why, and places nothing", () => {
  delete process.env.BOT_DO_NOT_TOUCH_GROUPS;
  const equity = evaluationFor([equityPosition()], 3.1, 3.12, 3.2611);
  const targets = silenceWarnings(() =>
    partitionOperatorCloseTargets("MARGIN-TEST", [equity], "operator TDUP"),
  );

  const reply = buildCloseSymbolPositionResult("MARGIN-TEST", "TDUP", undefined, targets, []);
  assert.deepEqual(reply.matchedGroupKeys, []);
  assert.deepEqual(reply.suppressedGroupKeys, ["TDUP::none"]);
  assert.match(reply.skippedReason ?? "", /is protected \(TDUP::none\)/);
  assert.equal(reply.results.length, 1);
  assert.equal(reply.results[0].placedOrder, false);
});

test("operator reply: a partially-protected request keeps both halves visible", () => {
  delete process.env.BOT_DO_NOT_TOUCH_GROUPS;
  const option = evaluationFor([optionPosition()], 0.4, 0.5, 0.45);
  const equity = evaluationFor([equityPosition()], 3.1, 3.12, 3.2611);
  const targets = silenceWarnings(() =>
    partitionOperatorCloseTargets("MARGIN-TEST", [option, equity], "operator TDUP"),
  );

  const placed = {
    accountNumber: "MARGIN-TEST",
    action: "CLOSE_POSITION" as const,
    placedOrder: true,
    symbol: "TDUP  260918C00004000",
    underlyingSymbol: "TDUP",
  };
  const reply = buildCloseSymbolPositionResult(
    "MARGIN-TEST",
    "TDUP",
    undefined,
    targets,
    [placed],
  );
  assert.deepEqual(reply.matchedGroupKeys, ["TDUP::call"]);
  assert.deepEqual(reply.suppressedGroupKeys, ["TDUP::none"]);
  assert.equal(reply.skippedReason, undefined);
  assert.deepEqual(
    reply.results.map((r) => r.placedOrder),
    [true, false],
  );
});

test("operator reply: a fully-clear request carries no suppression fields", () => {
  delete process.env.BOT_DO_NOT_TOUCH_GROUPS;
  const option = evaluationFor([optionPosition()], 0.4, 0.5, 0.45);
  const targets = partitionOperatorCloseTargets("MARGIN-TEST", [option], "operator TDUP");
  const reply = buildCloseSymbolPositionResult("MARGIN-TEST", "TDUP", "call", targets, []);
  assert.equal(reply.suppressedGroupKeys, undefined);
  assert.equal(reply.skippedReason, undefined);
  assert.deepEqual(reply.matchedGroupKeys, ["TDUP::call"]);
});

test("the operator request label names the symbol and, when given, the side", () => {
  assert.equal(
    buildOperatorRequestLabel("TDUP"),
    "operator closeSymbolPosition(TDUP)",
  );
  assert.equal(
    buildOperatorRequestLabel("TDUP", "call"),
    "operator closeSymbolPosition(TDUP, call)",
  );
});

// ---------------------------------------------------------------------------
// Instrument classification
// ---------------------------------------------------------------------------

test("only Equity Option is openable; every other instrument type is not", () => {
  assert.equal(isOpenableInstrument(optionPosition()), true);
  assert.equal(isOpenableInstrument(equityPosition()), false);
  for (const instrumentType of ["Future", "Future Option", "Cryptocurrency"]) {
    assert.equal(
      isOpenableInstrument(optionPosition({ "instrument-type": instrumentType })),
      false,
      instrumentType,
    );
  }
  // The broker's loose spellings normalize before the comparison.
  assert.equal(isOpenableInstrument(optionPosition({ "instrument-type": "option" })), true);
  assert.equal(
    isOpenableInstrument(optionPosition({ "instrument-type": "equity option" })),
    true,
  );
  assert.equal(isOpenableInstrument(equityPosition({ "instrument-type": "equity" })), false);
});

test("a missing instrument-type falls back to the SYMBOL SHAPE, never to a blanket block", () => {
  // A real option keeps closing — a blank field must not disarm a live stop.
  const optionNoType = optionPosition({ "instrument-type": "" });
  assert.equal(getPositionInstrumentType(optionNoType), "Equity Option");
  assert.equal(isOpenableInstrument(optionNoType), true);

  // A bare ticker cannot pass the OCC shape test, so a share lot is still caught.
  const equityNoType = equityPosition({ "instrument-type": "" });
  assert.equal(getPositionInstrumentType(equityNoType), "Unknown");
  assert.equal(isOpenableInstrument(equityNoType), false);
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

test("the guard defaults ON, including for a present-but-blank env var", () => {
  withEnv(undefined, () => assert.equal(isCloseInstrumentGuardEnabled(), true));
  // The `toBooleanFlag(process.env.X ?? true)` trap: dotenv turns `KEY=` into
  // "", which is not nullish. A blank value must still mean "use the default".
  for (const blank of ["", "   "]) {
    withEnv(blank, () =>
      assert.equal(isCloseInstrumentGuardEnabled(), true, JSON.stringify(blank)),
    );
  }
});

test("the kill switch restores today's behaviour exactly", () => {
  const evaluation = evaluationFor([equityPosition()], 3.1, 3.12, 3.2611);
  for (const off of ["false", "0", "no", "off"]) {
    withEnv(off, () => {
      assert.equal(isCloseInstrumentGuardEnabled(), false, off);
      assert.equal(isCloseBlockedByInstrumentGuard(evaluation), false, off);
      assert.equal(partitionClosesByInstrumentGuard([evaluation]).dispatch.length, 1, off);
    });
  }
  for (const on of ["true", "1", "yes"]) {
    withEnv(on, () => assert.equal(isCloseInstrumentGuardEnabled(), true, on));
  }
});

// ---------------------------------------------------------------------------
// Grouping + log contract
// ---------------------------------------------------------------------------

test("equity really does arrive as its own ::none group alongside the option legs", () => {
  const grouped = groupPositionsByUnderlying([equityPosition(), optionPosition()]);
  assert.deepEqual([...grouped.keys()].sort(), ["TDUP::call", "TDUP::none"]);
});

test("every suppression writes one greppable JSON line with the full context", () => {
  const evaluation = evaluationFor([equityPosition()], 3.1, 3.12, 3.2611);
  const lines: string[] = [];
  const originalWarn = console.warn;
  console.warn = (line: string) => void lines.push(line);
  try {
    suppressCloseForInstrumentGuard({
      accountNumber: "MARGIN-TEST",
      dispatchSite: "overnight-reduction",
      evaluation,
      requestedBy: "overnight exposure reduction (over the overnight cap)",
      requestedQuantity: 120,
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.token, CLOSE_INSTRUMENT_SUPPRESSED_TOKEN);
  assert.equal(entry.scope, "close-instrument-guard");
  assert.equal(entry.accountNumber, "MARGIN-TEST");
  assert.equal(entry.underlyingSymbol, "TDUP");
  assert.equal(entry.groupKey, "TDUP::none");
  assert.deepEqual(entry.instrumentTypes, ["Equity"]);
  assert.equal(entry.dispatchSite, "overnight-reduction");
  assert.equal(entry.requestedBy, "overnight exposure reduction (over the overnight cap)");
  assert.equal(entry.quantity, 120);
  assert.deepEqual(entry.symbols, ["TDUP"]);
});

test("without an explicit requestedBy the log carries the strategy reason and full quantity", () => {
  const evaluation = evaluationFor([equityPosition()], 3.1, 3.12, 3.2611);
  const lines: string[] = [];
  const originalWarn = console.warn;
  console.warn = (line: string) => void lines.push(line);
  try {
    suppressCloseForInstrumentGuard({
      accountNumber: "MARGIN-TEST",
      dispatchSite: "cycle-close",
      evaluation,
    });
  } finally {
    console.warn = originalWarn;
  }

  const entry = JSON.parse(lines[0]);
  assert.match(entry.requestedBy, /liquidate all positions immediately/);
  assert.equal(entry.strategyAction, "CLOSE_POSITION");
  assert.equal(entry.isUrgentClose, true);
  assert.equal(entry.quantity, 450);
});
