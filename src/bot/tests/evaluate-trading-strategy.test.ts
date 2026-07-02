import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPositionSizeWeightCaps,
  evaluateTradingStrategy,
  getTimeOfDayExecutionTargets,
  getTimeOfDayExecutionTargetsForPstTime,
} from "~/strategy/evaluate-trading-strategy";

function buildMetricsAtTime(hours: number, minutes: number) {
  const currentTime = new Date();
  currentTime.setHours(hours, minutes, 0, 0);

  const lastActionTime = new Date(currentTime.getTime() - 11 * 60 * 1000);

  return {
    currentBidPrice: 1,
    currentAskPrice: 1,
    currentTime,
    lastActionTime,
    weightedAverageFill: 1,
  };
}

test("getTimeOfDayExecutionTargetsForPstTime rejects invalid HH:mm format", () => {
  assert.throws(
    () => getTimeOfDayExecutionTargetsForPstTime("25:00"),
    /Invalid time format/,
  );

  assert.throws(
    () => getTimeOfDayExecutionTargetsForPstTime("10:7"),
    /Invalid time format/,
  );

  assert.throws(
    () => getTimeOfDayExecutionTargetsForPstTime("abc"),
    /Invalid time format/,
  );
});

test("getTimeOfDayExecutionTargetsForPstTime matches clock-based target schedule", () => {
  const fromPstString = getTimeOfDayExecutionTargetsForPstTime("10:14");

  const localClock = new Date();
  localClock.setHours(10, 14, 0, 0);
  const fromDateClock = getTimeOfDayExecutionTargets(localClock);

  assert.deepEqual(fromPstString, fromDateClock);
});

test("getTimeOfDayExecutionTargets boundary at 06:30 is opening target set", () => {
  const targets = getTimeOfDayExecutionTargetsForPstTime("06:30");

  assert.equal(targets.targetDTE, 30);
  assert.equal(targets.targetAccountExposure, 0.4);
  assert.equal(targets.bidWeight, 0.7);
  assert.equal(targets.midWeight, 0.2);
  assert.equal(targets.askWeight, 0.1);
});

test("getTimeOfDayExecutionTargets boundary at 12:30 is fully risk-off", () => {
  const targets = getTimeOfDayExecutionTargetsForPstTime("12:30");

  assert.equal(targets.targetDTE, 7);
  assert.equal(targets.targetAccountExposure, 0);
  assert.equal(targets.bidWeight, 0);
  assert.equal(targets.midWeight, 0);
  assert.equal(targets.askWeight, 0);
});

test("getTimeOfDayExecutionTargets keeps cash accounts active at 12:30", () => {
  const targets = getTimeOfDayExecutionTargetsForPstTime("12:30", "cash");

  assert.equal(targets.targetDTE, 7);
  assert.equal(targets.targetAccountExposure, 0.8);
  assert.equal(targets.bidWeight, 0);
  assert.equal(targets.midWeight, 0.15);
  assert.equal(targets.askWeight, 0.85);
});

test("getTimeOfDayExecutionTargets makes cash accounts risk-off at 13:00", () => {
  const targets = getTimeOfDayExecutionTargetsForPstTime("13:00", "cash");

  assert.equal(targets.targetDTE, 7);
  assert.equal(targets.targetAccountExposure, 0);
  assert.equal(targets.bidWeight, 0);
  assert.equal(targets.midWeight, 0);
  assert.equal(targets.askWeight, 0);
});

test("applyPositionSizeWeightCaps caps ask to 0.50 when position size is 15%", () => {
  const adjusted = applyPositionSizeWeightCaps(
    {
      askWeight: 0.85,
      bidWeight: 0.1,
      midWeight: 0.05,
      targetAccountExposure: 0.6,
      targetDTE: 14,
    },
    0.15,
  );

  assert.equal(adjusted.askWeight, 0.5);
  assert.equal(adjusted.midWeight, 0.4);
});

test("applyPositionSizeWeightCaps caps ask to 0.75 when position size is 30%", () => {
  const adjusted = applyPositionSizeWeightCaps(
    {
      askWeight: 0.9,
      bidWeight: 0.1,
      midWeight: 0.0,
      targetAccountExposure: 0.7,
      targetDTE: 10,
    },
    0.30,
  );

  assert.equal(adjusted.askWeight, 0.75);
  assert.equal(adjusted.midWeight, 0.15);
});

test("applyPositionSizeWeightCaps allows full ask at 50%+ position size", () => {
  const adjusted = applyPositionSizeWeightCaps(
    {
      askWeight: 0.9,
      bidWeight: 0.1,
      midWeight: 0.2,
      targetAccountExposure: 0.8,
      targetDTE: 7,
    },
    0.50,
  );

  assert.equal(adjusted.askWeight, 0.9);
  assert.equal(adjusted.midWeight, 0.2);
});

test("evaluateTradingStrategy liquidates margin accounts in last 5 minutes", () => {
  const strategy = evaluateTradingStrategy(buildMetricsAtTime(12, 55), "margin");

  assert.equal(strategy.action, "CLOSE_POSITION");
  assert.match(strategy.reason, /liquidate all positions immediately/);
});

test("evaluateTradingStrategy does not liquidate cash accounts in last 5 minutes", () => {
  const strategy = evaluateTradingStrategy(buildMetricsAtTime(12, 55), "cash");

  assert.equal(strategy.action, "MANAGE_ALLOCATION");
  assert.match(strategy.reason, /No circuit breakers triggered/);
});

test("evaluateTradingStrategy keeps cash accounts in accumulation mode before 1pm", () => {
  const strategy = evaluateTradingStrategy(buildMetricsAtTime(12, 45), "cash");

  assert.equal(strategy.action, "MANAGE_ALLOCATION");
  assert.match(strategy.reason, /No circuit breakers triggered/);
});
