import { getOccExpirationDate } from "./actions/order-utils";
import type { PositionQuoteSnapshot } from "./evaluate-position";

export interface PerLegReturn {
  expiration: string; // YYYY-MM-DD, or "unknown" when the OCC symbol won't parse
  returnPct: number; // (bid − cost basis) / cost basis, weighted within the expiration
  quantityWeight: number;
}

export interface PerLegReturnBreakdown {
  legs: PerLegReturn[];
  // Max − min per-expiration return. A wide spread across expirations means the
  // group-blended return is masking a diverging leg (v7 #2 → v5 strategy #5).
  returnSpreadPct: number;
  spansMultipleExpirations: boolean;
}

// Break a UNDERLYING::side group's snapshots into per-expiration returns so a
// profitable long-dated leg can't hide a collapsing short-dated one behind the
// blended group return. Pure; diagnostic only.
export function computePerLegReturnBreakdown(
  snapshots: PositionQuoteSnapshot[],
): PerLegReturnBreakdown {
  const byExpiration = new Map<
    string,
    { costBasis: number; bidValue: number; quantityWeight: number }
  >();

  for (const snapshot of snapshots) {
    const expirationDate = getOccExpirationDate(snapshot.position.symbol);
    const key = expirationDate ? expirationDate.toISOString().slice(0, 10) : "unknown";
    const entry = byExpiration.get(key) ?? {
      costBasis: 0,
      bidValue: 0,
      quantityWeight: 0,
    };
    entry.costBasis += snapshot.weightedAverageFill * snapshot.quantityWeight;
    entry.bidValue += snapshot.currentBidPrice * snapshot.quantityWeight;
    entry.quantityWeight += snapshot.quantityWeight;
    byExpiration.set(key, entry);
  }

  const legs: PerLegReturn[] = [...byExpiration.entries()]
    .map(([expiration, entry]) => ({
      expiration,
      returnPct:
        entry.costBasis > 0 ? (entry.bidValue - entry.costBasis) / entry.costBasis : 0,
      quantityWeight: entry.quantityWeight,
    }))
    .sort((left, right) => left.expiration.localeCompare(right.expiration));

  const returns = legs.map((leg) => leg.returnPct);
  const returnSpreadPct =
    returns.length > 1 ? Math.max(...returns) - Math.min(...returns) : 0;

  return {
    legs,
    returnSpreadPct,
    spansMultipleExpirations: legs.length > 1,
  };
}
