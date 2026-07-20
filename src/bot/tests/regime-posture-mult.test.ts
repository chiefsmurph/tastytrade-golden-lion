import test from "node:test";
import assert from "node:assert/strict";

import { getRegimePostureMult } from "~/strategy/position-gate";
import type { SecretRegime } from "~/strategy/secret/types";

// Pin the env the helper reads so ambient .env values can't skew assertions.
function withCleanEnv(fn: () => void): void {
  const keys = [
    "STRATEGY_REGIME_POSTURE_MULT_DISABLED",
    "STRATEGY_REGIME_DIP_MULT_MIN",
    "STRATEGY_REGIME_DIP_MULT_MAX",
  ] as const;
  const originals = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) {
    delete process.env[key];
  }
  try {
    fn();
  } finally {
    for (const [key, value] of originals) {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }
}

test("missing regime → 1 (null, undefined, empty object)", () => {
  withCleanEnv(() => {
    assert.equal(getRegimePostureMult(null), 1);
    assert.equal(getRegimePostureMult(undefined), 1);
    assert.equal(getRegimePostureMult({}), 1);
  });
});

test("throttle 0.7 alone → 0.7", () => {
  withCleanEnv(() => {
    assert.equal(getRegimePostureMult({ regimeMarginMult: 0.7 }), 0.7);
  });
});

test("throttle is down-only: values above 1 clamp to 1; 0 is a valid full block", () => {
  withCleanEnv(() => {
    assert.equal(getRegimePostureMult({ regimeMarginMult: 1.4 }), 1);
    assert.equal(getRegimePostureMult({ regimeMarginMult: 0 }), 0);
  });
});

test("lean 1.3 alone → 1.3", () => {
  withCleanEnv(() => {
    assert.equal(getRegimePostureMult({ dipBuyDeployMult: 1.3 }), 1.3);
  });
});

test("lean clamps to the band: 2.5 → 1.5 max, 0.2 → 0.5 min (defaults)", () => {
  withCleanEnv(() => {
    assert.equal(getRegimePostureMult({ dipBuyDeployMult: 2.5 }), 1.5);
    assert.equal(getRegimePostureMult({ dipBuyDeployMult: 0.2 }), 0.5);
  });
});

test("combined: throttle 0.7 × lean 1.3", () => {
  withCleanEnv(() => {
    const result = getRegimePostureMult({
      regimeMarginMult: 0.7,
      dipBuyDeployMult: 1.3,
    });
    assert.ok(Math.abs(result - 0.7 * 1.3) < 1e-9);
  });
});

test("kill switch STRATEGY_REGIME_POSTURE_MULT_DISABLED → always 1", () => {
  withCleanEnv(() => {
    process.env.STRATEGY_REGIME_POSTURE_MULT_DISABLED = "true";
    const result = getRegimePostureMult({
      regimeMarginMult: 0.4,
      dipBuyDeployMult: 1.3,
    });
    assert.equal(result, 1);
  });
});

test("negative / NaN / non-numeric inputs are treated as missing (→ 1), not clamped", () => {
  withCleanEnv(() => {
    assert.equal(getRegimePostureMult({ regimeMarginMult: -0.5 }), 1);
    assert.equal(getRegimePostureMult({ dipBuyDeployMult: -2 }), 1);
    assert.equal(getRegimePostureMult({ regimeMarginMult: Number.NaN }), 1);
    assert.equal(getRegimePostureMult({ dipBuyDeployMult: Number.NaN }), 1);
    assert.equal(
      getRegimePostureMult({ regimeMarginMult: Number.POSITIVE_INFINITY }),
      1,
    );
    // Index-signature junk: a string never gates.
    assert.equal(
      getRegimePostureMult({
        regimeMarginMult: "0.5" as unknown as number,
      } as SecretRegime),
      1,
    );
  });
});

test("lean band is env-tunable via STRATEGY_REGIME_DIP_MULT_MIN/MAX", () => {
  withCleanEnv(() => {
    process.env.STRATEGY_REGIME_DIP_MULT_MIN = "0.8";
    process.env.STRATEGY_REGIME_DIP_MULT_MAX = "1.2";
    assert.equal(getRegimePostureMult({ dipBuyDeployMult: 2.5 }), 1.2);
    assert.equal(getRegimePostureMult({ dipBuyDeployMult: 0.5 }), 0.8);
  });
});
