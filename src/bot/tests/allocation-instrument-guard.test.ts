import test from "node:test";
import assert from "node:assert/strict";

import {
  manageAllocationForGroup,
  type AllocationBudget,
  type ManageAllocationDependencies,
} from "../actions/manage-allocation";
import {
  ALLOCATION_INSTRUMENT_SUPPRESSED_TOKEN,
  isAllocationInstrumentGuardEnabled,
} from "../allocation-instrument-guard";
import { isOpenableInstrument } from "../position-instrument";
import type { PositionGroupEvaluation } from "../evaluate-position";
import type { ExecutionTargets } from "~/strategy/evaluate-trading-strategy";
import { localTimeAt } from "./test-clock";

// BOT_BUY_ONLY_OPENABLE_INSTRUMENTS — an EQUITY holding must not attract option buys.
//
// The owner hand-buys SHARES in the margin account. An equity leg has no C/P suffix,
// so evaluate-position keys it `TICKER::none`, and `getCandidateSide` defaults a
// sideless group to "call" — which made his share lot an accumulation target for the
// bot's option buying on the same underlying. This is the ENTRY twin of the close-side
// instrument guard; both rest on the same invariant: the bot may only act on an
// instrument it is capable of opening.
//
// Clock pinned via test-clock (AGENTS.md non-negotiable 7) — the allocation path reads
// evaluation.metrics.currentTime off the LOCAL clock for the accumulation-cutoff guard.

const GUARD_ENV = "BOT_BUY_ONLY_OPENABLE_INSTRUMENTS";
delete process.env[GUARD_ENV];

const NINE_AM = localTimeAt(9, 0);

const baseTargets: ExecutionTargets = {
  targetDTE: 21,
  targetAccountExposure: 0.5,
  bidWeight: 0.34,
  midWeight: 0.33,
  askWeight: 0.33,
};

const fullBudget: AllocationBudget = {
  buyingPowerRemaining: 100000,
  portfolioExposure: 0,
  totalCapital: 100000,
};

// Stops the flow at the option-health gate, so "did the instrument guard let this
// through?" has a single, broker-free answer.
const failingHealthDeps: ManageAllocationDependencies = {
  getOptionHealth: (async () => ({ summary: { healthyTargets: [] } })) as never,
};

type TestPosition = PositionGroupEvaluation["positions"][number];

function positionFor(
  symbol: string,
  instrumentType: string | undefined,
  quantity: number,
): TestPosition {
  return {
    "account-number": "ACC-1",
    ...(instrumentType == null ? {} : { "instrument-type": instrumentType }),
    quantity,
    symbol,
  } as unknown as TestPosition;
}

function buildEvaluation(
  groupKey: string,
  underlyingSymbol: string,
  positions: TestPosition[],
): PositionGroupEvaluation {
  return {
    currentReturn: 0,
    executionTargets: baseTargets,
    groupKey,
    metrics: {
      currentAskPrice: 1.2,
      currentBidPrice: 1.0,
      currentTime: NINE_AM,
      lastActionTime: NINE_AM,
      weightedAverageFill: 1,
    },
    positionSnapshots: positions.map((position) => ({
      currentAskPrice: 1.2,
      currentBidPrice: 1.0,
      lastActionTime: NINE_AM,
      position,
      quantityWeight: 1,
      weightedAverageFill: 1,
    })),
    positions,
    strategy: { action: "MANAGE_ALLOCATION", reason: "test" },
    underlyingSymbol,
  } as PositionGroupEvaluation;
}

/** The owner's hand-bought shares, exactly as they group today. */
const equityGroup = () =>
  buildEvaluation("TDUP::none", "TDUP", [positionFor("TDUP", "Equity", 450)]);

/** An ordinary option group the bot opened itself. */
const optionGroup = () =>
  buildEvaluation("LCID::call", "LCID", [
    positionFor("LCID  250117C00010000", "Option", 1),
  ]);

function captureGuardLines(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const originalLog = console.log;
  const lines: Record<string, unknown>[] = [];
  console.log = ((...args: unknown[]) => {
    const first = args[0];
    if (
      typeof first === "string" &&
      first.includes(ALLOCATION_INSTRUMENT_SUPPRESSED_TOKEN)
    ) {
      lines.push(JSON.parse(first) as Record<string, unknown>);
      return;
    }
    (originalLog as (...a: unknown[]) => void)(...args);
  }) as typeof console.log;
  return run().then(
    () => {
      console.log = originalLog;
      return lines;
    },
    (error) => {
      console.log = originalLog;
      throw error;
    },
  );
}

async function withGuardEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const prior = process.env[GUARD_ENV];
  if (value === undefined) delete process.env[GUARD_ENV];
  else process.env[GUARD_ENV] = value;
  try {
    return await run();
  } finally {
    if (prior === undefined) delete process.env[GUARD_ENV];
    else process.env[GUARD_ENV] = prior;
  }
}

test("an equity group is not an accumulation target", async () => {
  const result = await manageAllocationForGroup(
    "ACC-1",
    equityGroup(),
    fullBudget,
    1,
    {},
    failingHealthDeps,
  );

  assert.equal(result.placedOrder, false);
  assert.match(result.skippedReason ?? "", /instrument guard/);
  assert.match(result.skippedReason ?? "", /Equity/);
  assert.deepEqual(result.routeOrders, []);
});

test("the suppression is logged with the side it would have bought", async () => {
  const lines = await captureGuardLines(() =>
    manageAllocationForGroup("ACC-1", equityGroup(), fullBudget, 1, {}, failingHealthDeps),
  );

  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(line.token, ALLOCATION_INSTRUMENT_SUPPRESSED_TOKEN);
  assert.equal(line.scope, "allocation-instrument-guard");
  assert.equal(line.groupKey, "TDUP::none");
  assert.equal(line.underlyingSymbol, "TDUP");
  assert.deepEqual(line.instrumentTypes, ["Equity"]);
  // The hazard, named: without the guard this group is bought as a CALL.
  assert.equal(line.wouldHaveBoughtSide, "call");
  assert.equal(line.heldQuantity, 450);
  assert.deepEqual(line.symbols, ["TDUP"]);
});

test("an option group is untouched — it reaches the ordinary gates", async () => {
  const lines = await captureGuardLines(async () => {
    const result = await manageAllocationForGroup(
      "ACC-1",
      optionGroup(),
      fullBudget,
      1,
      {},
      failingHealthDeps,
    );
    assert.match(result.skippedReason ?? "", /option health gate failed/);
  });
  assert.deepEqual(lines, []);
});

test("a missing instrument-type falls back to the OCC symbol shape, so real options still allocate", async () => {
  const evaluation = buildEvaluation("LCID::call", "LCID", [
    positionFor("LCID  250117C00010000", undefined, 1),
  ]);
  const result = await manageAllocationForGroup(
    "ACC-1",
    evaluation,
    fullBudget,
    1,
    {},
    failingHealthDeps,
  );
  assert.match(result.skippedReason ?? "", /option health gate failed/);
});

test("a bare ticker with no instrument-type is still caught", async () => {
  const evaluation = buildEvaluation("TDUP::none", "TDUP", [
    positionFor("TDUP", undefined, 450),
  ]);
  const result = await manageAllocationForGroup(
    "ACC-1",
    evaluation,
    fullBudget,
    1,
    {},
    failingHealthDeps,
  );
  assert.match(result.skippedReason ?? "", /instrument guard/);
});

test("one non-openable leg blocks the whole group — the bot cannot buy half of a mixed pile", async () => {
  const evaluation = buildEvaluation("TDUP::none", "TDUP", [
    positionFor("TDUP  250117C00010000", "Equity Option", 2),
    positionFor("TDUP", "Equity", 450),
  ]);
  const result = await manageAllocationForGroup(
    "ACC-1",
    evaluation,
    fullBudget,
    1,
    {},
    failingHealthDeps,
  );
  assert.match(result.skippedReason ?? "", /instrument guard/);
});

test("the kill switch restores the previous behaviour exactly", async () => {
  await withGuardEnv("false", async () => {
    const lines = await captureGuardLines(async () => {
      const result = await manageAllocationForGroup(
        "ACC-1",
        equityGroup(),
        fullBudget,
        1,
        {},
        failingHealthDeps,
      );
      // Past the guard, on to the ordinary gates — i.e. it is an accumulation
      // target again, which is what this branch is for.
      assert.match(result.skippedReason ?? "", /option health gate failed/);
    });
    assert.deepEqual(lines, []);
  });
});

test("a present-but-blank env var reads as the in-code default (ON), not as false", async () => {
  // dotenv turns `BOT_BUY_ONLY_OPENABLE_INSTRUMENTS=` into "", which is not nullish —
  // `toBooleanFlag(process.env.X ?? true)` would ship this guard silently OFF.
  await withGuardEnv("", async () => {
    assert.equal(isAllocationInstrumentGuardEnabled(), true);
    const result = await manageAllocationForGroup(
      "ACC-1",
      equityGroup(),
      fullBudget,
      1,
      {},
      failingHealthDeps,
    );
    assert.match(result.skippedReason ?? "", /instrument guard/);
  });
});

test("the shared predicate answers for both guards", () => {
  assert.equal(isOpenableInstrument(positionFor("LCID  250117C00010000", "Option", 1)), true);
  assert.equal(isOpenableInstrument(positionFor("LCID  250117C00010000", "Equity Option", 1)), true);
  assert.equal(isOpenableInstrument(positionFor("TDUP", "Equity", 450)), false);
  assert.equal(isOpenableInstrument(positionFor("BTC/USD", "Cryptocurrency", 1)), false);
});
