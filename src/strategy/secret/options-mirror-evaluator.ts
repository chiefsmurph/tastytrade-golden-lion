import { SecretRegime, SecretSourcePosition } from "./types";

// norm(x, lo, hi) = clamp((x - lo) / (hi - lo), 0, 1)
function norm(x: number, lo: number, hi: number): number {
  return Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
}

const MARGIN_SCORE_THRESHOLD = 0.45;
const CASH_SCORE_THRESHOLD = 0.55;

export interface MarginOptComponents {
  bwExcess: number;
  dtQual: number;
  room: number;
  fresh: number;
  momo: number;
}

export interface MarginOptEval {
  ticker: string;
  gatePass: boolean;
  gateFailReason: string | null;
  score: number | null;
  wouldBuy: boolean;
  strikeOtm: number | null;
  components: MarginOptComponents | null;
}

export interface CashOptComponents {
  hs: number;
  thesis: number;
  entry: number;
  stab: number;
  regime: number;
}

export interface CashOptEval {
  ticker: string;
  gatePass: boolean;
  gateFailReason: string | null;
  score: number | null;
  wouldBuy: boolean;
  strikeItm: number | null;
  components: CashOptComponents | null;
}

// fallow-ignore-next-line complexity
function marginGateFailReason(
  position: SecretSourcePosition,
  regime: SecretRegime | null,
): string | null {
  if (position.willBuy !== true) return `willBuy=${String(position.willBuy ?? "null")}`;
  const min = regime?.min ?? null;
  if (min !== null && min >= 300) return `min=${min} (≥300 — past entry window)`;
  const rangePos = typeof position.rangePos === "number" ? position.rangePos : null;
  if (rangePos !== null && rangePos > 65) return `rangePos=${rangePos.toFixed(0)} (>65)`;
  const daytradeScore = typeof position.daytradeScore === "number" ? position.daytradeScore : null;
  if (daytradeScore !== null && daytradeScore <= -150) return `daytradeScore=${daytradeScore} (≤-150)`;
  return null;
}

// fallow-ignore-next-line complexity
function computeMarginScore(
  position: SecretSourcePosition,
  regime: SecretRegime | null,
): MarginOptComponents {
  const buyWeight = typeof position.buyWeight === "number" ? position.buyWeight : 0;
  const currentMinBuyWeight = regime?.currentMinBuyWeight ?? null;
  const bwExcess = currentMinBuyWeight !== null && currentMinBuyWeight > 0
    ? norm(buyWeight / currentMinBuyWeight, 1.0, 3.0)
    : 0;

  const daytradeScore = typeof position.daytradeScore === "number" ? position.daytradeScore : 0;
  const dtQual = norm(daytradeScore, -100, 300);

  const rangePos = typeof position.rangePos === "number" ? position.rangePos : null;
  const room = rangePos !== null ? 1 - rangePos / 100 : 0.5;

  const minOld = typeof position.minOld === "number" ? position.minOld : 0;
  const fresh = norm(-minOld, -180, 0);

  const tsc = typeof position.tsc === "number" ? position.tsc : 0;
  const fiveMinuteRSI = typeof position.fiveMinuteRSI === "number" ? position.fiveMinuteRSI : null;
  const momoMult = fiveMinuteRSI !== null ? (fiveMinuteRSI >= 40 && fiveMinuteRSI <= 68 ? 1 : 0.5) : 1;
  const momo = norm(tsc, -8, 6) * momoMult;

  return { bwExcess, dtQual, room, fresh, momo };
}

// fallow-ignore-next-line complexity
export function evaluateMarginOpt(
  position: SecretSourcePosition,
  regime: SecretRegime | null,
): MarginOptEval {
  const ticker = position.ticker ?? "?";
  const gateFailReason = marginGateFailReason(position, regime);
  if (gateFailReason !== null) {
    return { ticker, gatePass: false, gateFailReason, score: null, wouldBuy: false, strikeOtm: null, components: null };
  }

  const components = computeMarginScore(position, regime);
  const { bwExcess, dtQual, room, fresh, momo } = components;
  const score = 0.35 * bwExcess + 0.25 * dtQual + 0.20 * room + 0.10 * fresh + 0.10 * momo;

  const currentPrice = typeof position.currentPrice === "number" ? position.currentPrice : null;
  const trueHigh = typeof position.trueHigh === "number" ? position.trueHigh : null;
  let strikeOtm: number | null = null;
  if (currentPrice !== null) {
    const raw = currentPrice * (1 + 0.02 + 0.03 * room);
    strikeOtm = trueHigh !== null ? Math.min(raw, trueHigh) : raw;
  }

  return { ticker, gatePass: true, gateFailReason: null, score, wouldBuy: score >= MARGIN_SCORE_THRESHOLD, strikeOtm, components };
}

// fallow-ignore-next-line complexity
function cashGateFailReason(
  position: SecretSourcePosition,
  regime: SecretRegime | null,
): string | null {
  const holdScore = typeof position.holdScore === "number" ? position.holdScore : null;
  if (holdScore === null || holdScore < 0.45) return `holdScore=${holdScore ?? "null"} (<0.45)`;
  if (position.isOvernightEligible !== true) return "!isOvernightEligible";
  if (regime?.crashRegime === true) return "crashRegime";
  const manualThesisCount = typeof position.manualThesisCount === "number" ? position.manualThesisCount : null;
  const buyFraction = typeof position.buyFraction === "number" ? position.buyFraction : null;
  const thesisSoftPass = (manualThesisCount !== null && manualThesisCount >= 2) || (buyFraction !== null && buyFraction >= 0.6);
  if (!thesisSoftPass) return `thesis soft floor: manualThesisCount=${manualThesisCount ?? "null"} buyFraction=${buyFraction ?? "null"}`;
  if (position.failsDayHighGate === true) return "failsDayHighGate";
  const rangePos = typeof position.rangePos === "number" ? position.rangePos : null;
  if (rangePos !== null && rangePos > 55) return `rangePos=${rangePos.toFixed(0)} (>55)`;
  return null;
}

// fallow-ignore-next-line complexity
function computeCashScore(
  position: SecretSourcePosition,
  regime: SecretRegime | null,
): CashOptComponents {
  const holdScore = (position.holdScore as number);
  const hs = norm(holdScore, 0.30, 0.80);

  const manualThesisCount = typeof position.manualThesisCount === "number" ? position.manualThesisCount : 0;
  const buyFraction = typeof position.buyFraction === "number" ? position.buyFraction : 0;
  const thesis = 0.6 * norm(manualThesisCount, 2, 8) + 0.4 * norm(buyFraction, 0.5, 1.25);

  const rangePos = typeof position.rangePos === "number" ? position.rangePos : null;
  const entry = rangePos !== null ? 1 - rangePos / 100 : 0.5;

  const bounceStabilizationScore = typeof position.bounceStabilizationScore === "number" ? position.bounceStabilizationScore : null;
  const stab = bounceStabilizationScore !== null ? norm(bounceStabilizationScore, 30, 55) : 0.5;

  const crashRegime = regime?.crashRegime ?? false;
  const scannedTotalZ = typeof regime?.scannedTotalZ === "number" ? regime.scannedTotalZ : 0;
  const regimeScore = crashRegime ? 0 : 0.5 + 0.5 * norm(scannedTotalZ, 0, 2.5);

  return { hs, thesis, entry, stab, regime: regimeScore };
}

// fallow-ignore-next-line complexity
export function evaluateCashOpt(
  position: SecretSourcePosition,
  regime: SecretRegime | null,
): CashOptEval {
  const ticker = position.ticker ?? "?";
  const gateFailReason = cashGateFailReason(position, regime);
  if (gateFailReason !== null) {
    return { ticker, gatePass: false, gateFailReason, score: null, wouldBuy: false, strikeItm: null, components: null };
  }

  const components = computeCashScore(position, regime);
  const { hs, thesis, entry, stab, regime: regimeScore } = components;
  const score = 0.45 * hs + 0.20 * thesis + 0.15 * entry + 0.10 * stab + 0.10 * regimeScore;

  const currentPrice = typeof position.currentPrice === "number" ? position.currentPrice : null;
  const trueLow = typeof position.trueLow === "number" ? position.trueLow : null;
  let strikeItm: number | null = null;
  if (currentPrice !== null) {
    const raw = currentPrice * (1 - 0.03 - 0.02 * (1 - entry));
    strikeItm = trueLow !== null ? Math.max(raw, trueLow) : raw;
  }

  return { ticker, gatePass: true, gateFailReason: null, score, wouldBuy: score >= CASH_SCORE_THRESHOLD, strikeItm, components };
}

function fmtNum(n: number): string {
  return n.toFixed(2);
}

// Logs would-buy candidates and a per-tick summary. Skips are silent — only
// candidates (score ≥ threshold) produce a log line to keep output clean.
// fallow-ignore-next-line complexity
export function logOptionsMirrorEval(
  positions: SecretSourcePosition[],
  regime: SecretRegime | null,
): void {
  let marginCandidates = 0;
  let cashCandidates = 0;

  for (const pos of positions) {
    const m = evaluateMarginOpt(pos, regime);
    if (m.wouldBuy && m.components !== null && m.score !== null) {
      const c = m.components;
      const strike = m.strikeOtm !== null ? `$${m.strikeOtm.toFixed(2)}` : "strike=?";
      console.log(
        `[options-mirror] MARGIN_OPT would-buy ${m.ticker.padEnd(6)} score ${fmtNum(m.score)} ${strike} OTM/weekly [bwExc ${fmtNum(c.bwExcess)} dt ${fmtNum(c.dtQual)} room ${fmtNum(c.room)} fresh ${fmtNum(c.fresh)} momo ${fmtNum(c.momo)}]`,
      );
      marginCandidates++;
    }

    const ca = evaluateCashOpt(pos, regime);
    if (ca.wouldBuy && ca.components !== null && ca.score !== null) {
      const c = ca.components;
      const strike = ca.strikeItm !== null ? `$${ca.strikeItm.toFixed(2)}` : "strike=?";
      console.log(
        `[options-mirror] CASH_OPT   would-buy ${ca.ticker.padEnd(6)} score ${fmtNum(ca.score)} ${strike} ITM/10-14d [hs ${fmtNum(c.hs)} thesis ${fmtNum(c.thesis)} entry ${fmtNum(c.entry)} stab ${fmtNum(c.stab)} regime ${fmtNum(c.regime)}]`,
      );
      cashCandidates++;
    }
  }

  if (marginCandidates > 0 || cashCandidates > 0) {
    console.log(
      `[options-mirror] ${positions.length} positions: ${marginCandidates} margin candidate(s), ${cashCandidates} cash candidate(s)`,
    );
  }
}
