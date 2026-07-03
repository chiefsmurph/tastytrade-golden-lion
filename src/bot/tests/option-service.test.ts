import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeVolumesIntoChain,
  OPEN_INTEREST_FIELD_NAMES,
} from "~/core/option-service";
import type { TastytradeOptionChain, TastytradeStrikeWithVolumes } from "~/core/types";

function miniChain(): TastytradeOptionChain {
  return {
    "underlying-symbol": "MARA",
    expirations: [
      {
        "expiration-date": "2026-08-07",
        "days-to-expiration": 35,
        strikes: [
          {
            "strike-price": "12.0",
            call: "MARA  260807C00012000",
            put: "MARA  260807P00012000",
            "call-streamer-symbol": ".MARA260807C12",
            "put-streamer-symbol": ".MARA260807P12",
          },
        ],
      },
    ],
  } as unknown as TastytradeOptionChain;
}

function firstStrike(chain: unknown): TastytradeStrikeWithVolumes {
  return (chain as { expirations: { strikes: TastytradeStrikeWithVolumes[] }[] })
    .expirations[0].strikes[0];
}

test("volume merge writes callVolume/putVolume", () => {
  const merged = mergeVolumesIntoChain(miniChain(), {
    ".MARA260807C12": 500,
    ".MARA260807P12": 75,
  });
  const strike = firstStrike(merged);
  assert.equal(strike.callVolume, 500);
  assert.equal(strike.putVolume, 75);
  assert.equal(strike.callOpenInterest, undefined);
});

test("open-interest merge writes its own fields and leaves volume untouched", () => {
  const withVolumes = mergeVolumesIntoChain(miniChain(), {
    ".MARA260807C12": 500,
  });
  const merged = mergeVolumesIntoChain(
    withVolumes,
    { ".MARA260807C12": 1200, ".MARA260807P12": 340 },
    OPEN_INTEREST_FIELD_NAMES,
  );
  const strike = firstStrike(merged);
  assert.equal(strike.callVolume, 500);
  assert.equal(strike.callOpenInterest, 1200);
  assert.equal(strike.putOpenInterest, 340);
  assert.equal(strike.putVolume, undefined);
});
