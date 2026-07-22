// Dry-run: what would computeSeedSizing pick on the real ~$1,650 account,
// across option prices and candidate bands? Read-only, no env, no orders.
import { computeSeedSizing } from "../strategy/seed-sizing-model";

const NLV = 1650; // cash account NLV
const prices = [0.5, 0.98, 1.5, 2.0, 3.0]; // $0.98 = the real SG seed
const bands: [number, number][] = [
  [0.06, 0.10],
  [0.10, 0.14],
  [0.12, 0.18],
  [0.12, 0.25],
  [0.12, 0.35], // the LIVE band
];

function row(price: number, q: number) {
  const cells = bands.map(([f, c]) => {
    const r = computeSeedSizing({
      accountNLV: NLV,
      optionPrice: price,
      optionLiquidityQuality: q,
      floorPct: f,
      ceilingPct: c,
    });
    return `${r.modelContracts}c/$${r.modelContractsNotional.toFixed(0)}(${(100 * r.modelContractsNotional / NLV).toFixed(0)}%)`;
  });
  return `$${price.toFixed(2).padStart(5)}  ${cells.map((c) => c.padEnd(14)).join(" ")}`;
}

console.log(`account NLV=$${NLV}, contract=price×100`);
console.log(`price    ` + bands.map(([f, c]) => `${(f * 100).toFixed(0)}-${(c * 100).toFixed(0)}%`.padEnd(14)).join(" "));
console.log("--- LIQUID name (optionLiquidityQuality=1.0, e.g. SG weeklies) ---");
for (const p of prices) console.log(row(p, 1.0));
console.log("--- THIN name (optionLiquidityQuality=0.3, e.g. XXI monthly) ---");
for (const p of prices) console.log(row(p, 0.3));
console.log(`\ntoday (hardcoded 1 contract): $0.98→$98(6%), $2.00→$200(12%), $3.00→$300(18%)`);
