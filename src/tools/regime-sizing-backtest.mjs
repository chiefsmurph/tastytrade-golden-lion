#!/usr/bin/env node
/**
 * regime-sizing-backtest.mjs
 *
 * QUESTION: Should we size option seeds by market-regime favorability
 * (big ~25% on a "favorable" day, small ~5% on a "timid" day)?
 *
 * COUNTEREXAMPLE that prompted this: on 2026-07-20 the SG option seed
 * (golden-lion's clean winner, $0.98 -> $1.38, +41%) was placed while
 * regimeMult=0.84 / dipBuyMult=1.00 -- a *timid/reduce* posture. Regime
 * scaling would have sized that winner SMALL.
 *
 * METHOD: golden-lion's own seeds are too few to measure, so we use the
 * Alpaca STOCK bot's closed positions as a proxy population. For each buy
 * we join the regime state that was live at buy-time (parsed from the
 * SCANNED_REGIME_AOBM log line), then measure the forward return of that
 * buy (avg sell vs fill). We test whether regime favorability
 * (dipBuyMult / breadth-z / regimeMult / marketReturn) predicts a better
 * per-buy outcome, or whether it is only a broad pacing signal.
 *
 * DATA (pulled to ./data-pull-regime/ from prod, read-only):
 *   positions.json : slim closedPositions {ticker, buys[], sells[]}
 *   regime.json    : parsed SCANNED_REGIME_AOBM series {t, mkt, z, regimeMult, dipBuyMult, crash}
 *
 * NO production code is touched. Pure analysis.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// repo root is two levels up from src/tools/
const DATA = path.join(__dirname, '..', '..', 'data-pull-regime');

const positions = JSON.parse(fs.readFileSync(path.join(DATA, 'positions.json'), 'utf8'));
const regime = JSON.parse(fs.readFileSync(path.join(DATA, 'regime.json'), 'utf8'))
  .map((r) => ({ ...r, ts: Date.parse(r.t) }))
  .sort((a, b) => a.ts - b.ts);

// ---- regime join: nearest regime tick at or before the buy, within maxGapMs ----
const MAX_GAP_MS = 20 * 60 * 1000; // 20 minutes; ticks fire every few min during session
function regimeAt(buyMs) {
  // binary search for last regime tick <= buyMs
  let lo = 0, hi = regime.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (regime[mid].ts <= buyMs) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (ans < 0) return null;
  const r = regime[ans];
  if (buyMs - r.ts > MAX_GAP_MS) return null;
  return r;
}

// ---- forward return of a buy: avg sell price of the position vs this buy's fill ----
// closedPositions aggregate all sells; we use the position's volume-weighted avg sell
// as the exit for every buy in that position (standard for this dataset -- see
// reference_backtest_pattern: return = avgSell vs fillPrice).
function avgSell(pos) {
  let v = 0, q = 0;
  for (const s of pos.sells || []) {
    if (s.f == null || s.q == null) continue;
    v += s.f * s.q; q += s.q;
  }
  return q > 0 ? v / q : null;
}

// ---- build the joined sample ----
const rows = [];
let noRegime = 0, noSell = 0, badFill = 0, total = 0;
for (const pos of positions) {
  const exit = avgSell(pos);
  if (exit == null) { noSell += (pos.buys || []).length; continue; }
  for (const b of pos.buys || []) {
    total++;
    if (!b.f || b.f <= 0) { badFill++; continue; }
    const buyMs = Date.parse(b.t);
    if (!buyMs) continue;
    const r = regimeAt(buyMs);
    if (!r) { noRegime++; continue; }
    const ret = (exit - b.f) / b.f; // fractional forward return
    rows.push({
      ticker: pos.ticker,
      date: b.date,
      buyMs,
      fill: b.f,
      ret,
      dipBuyMult: r.dipBuyMult,
      z: r.z,
      regimeMult: r.regimeMult,
      mkt: r.mkt,
      crash: r.crash,
      dc: b.dc || null,
    });
  }
}

console.log('=== SAMPLE ===');
console.log(`positions: ${positions.length}  total buys: ${total}`);
console.log(`joined rows (buy in regime window): ${rows.length}`);
console.log(`dropped: noSell=${noSell} noRegime=${noRegime} badFill=${badFill}`);

// ---- helpers ----
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const winRate = (a) => (a.length ? a.filter((x) => x > 0).length / a.length : NaN);
const pct = (x) => (x * 100).toFixed(2) + '%';

function summarize(label, subset) {
  const r = subset.map((x) => x.ret);
  return {
    label,
    n: r.length,
    meanRet: mean(r),
    medRet: median(r),
    win: winRate(r),
  };
}
function printTable(title, groups) {
  console.log(`\n=== ${title} ===`);
  console.log(`${'bucket'.padEnd(22)} ${'n'.padStart(6)} ${'meanRet'.padStart(9)} ${'medRet'.padStart(9)} ${'win%'.padStart(7)}`);
  for (const g of groups) {
    if (!g.n) { console.log(`${g.label.padEnd(22)} ${'0'.padStart(6)}  (empty)`); continue; }
    console.log(
      `${g.label.padEnd(22)} ${String(g.n).padStart(6)} ${pct(g.meanRet).padStart(9)} ${pct(g.medRet).padStart(9)} ${(g.win * 100).toFixed(1).padStart(7)}`
    );
  }
}

// ---- quintile bucketer on a numeric signal ----
function quintiles(rowsWith, key) {
  const vals = rowsWith.map((r) => r[key]).filter((v) => v != null).sort((a, b) => a - b);
  if (vals.length < 5) return [];
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  const edges = [q(0.2), q(0.4), q(0.6), q(0.8)];
  const buckets = [[], [], [], [], []];
  for (const r of rowsWith) {
    const v = r[key];
    if (v == null) continue;
    let b = 0;
    while (b < 4 && v > edges[b]) b++;
    buckets[b].push(r);
  }
  return buckets.map((sub, i) =>
    summarize(`Q${i + 1} (${key})`, sub)
  ).map((s, i) => ({ ...s, edge: i < 4 ? edges[i] : null }));
}

// ---- correlation ----
function corr(rowsWith, key) {
  const xs = [], ys = [];
  for (const r of rowsWith) {
    if (r[key] == null || r.ret == null) continue;
    xs.push(r[key]); ys.push(r.ret);
  }
  const n = xs.length;
  if (n < 3) return { n, r: NaN };
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return { n, r: num / Math.sqrt(dx * dy) };
}

// ================= 1. dipBuyMult (full-window signal) =================
// dipBuyMult > 1 == MORE favorable posture (deploy the dip harder).
const withDip = rows.filter((r) => r.dipBuyMult != null);
printTable('dipBuyMult quintiles (higher = more favorable)', quintiles(withDip, 'dipBuyMult'));
printTable('dipBuyMult: favorable vs timid split', [
  summarize('timid  dip<=1.05', withDip.filter((r) => r.dipBuyMult <= 1.05)),
  summarize('mid    1.05-1.25', withDip.filter((r) => r.dipBuyMult > 1.05 && r.dipBuyMult <= 1.25)),
  summarize('favor  dip>1.25', withDip.filter((r) => r.dipBuyMult > 1.25)),
]);
console.log('corr(dipBuyMult, ret):', JSON.stringify(corr(withDip, 'dipBuyMult')));

// ================= 2. breadth z (full-window signal) =================
// Prior work: scannedTotal HIGH == broadly-down == favorable to deploy.
// The regime z here is breadth z; sign convention checked empirically below.
const withZ = rows.filter((r) => r.z != null);
printTable('breadth z quintiles', quintiles(withZ, 'z'));
printTable('breadth z: extreme vs mid', [
  summarize('z<=-0.5', withZ.filter((r) => r.z <= -0.5)),
  summarize('-0.5..0.5', withZ.filter((r) => r.z > -0.5 && r.z < 0.5)),
  summarize('z>=0.5', withZ.filter((r) => r.z >= 0.5)),
]);
console.log('corr(z, ret):', JSON.stringify(corr(withZ, 'z')));

// ================= 3. crashRegime flag =================
printTable('crashRegime', [
  summarize('crash=true', rows.filter((r) => r.crash === true)),
  summarize('crash=false', rows.filter((r) => r.crash === false)),
]);

// ================= 4. regimeMult & marketReturn (THIN: 7/20-7/21 only) =================
const withReg = rows.filter((r) => r.regimeMult != null);
console.log(`\n[thin] regimeMult joined rows: ${withReg.length} (only 7/20-7/21 log format carries it)`);
if (withReg.length >= 20) {
  printTable('regimeMult: timid vs favorable (THIN)', [
    summarize('timid  regMult<1', withReg.filter((r) => r.regimeMult < 1)),
    summarize('favor  regMult>=1', withReg.filter((r) => r.regimeMult >= 1)),
  ]);
  console.log('corr(regimeMult, ret):', JSON.stringify(corr(withReg, 'regimeMult')));
}
const withMkt = rows.filter((r) => r.mkt != null);
if (withMkt.length >= 20) {
  printTable('marketReturn: down vs up (THIN)', [
    summarize('mkt<0 (down)', withMkt.filter((r) => r.mkt < 0)),
    summarize('mkt>=0 (up)', withMkt.filter((r) => r.mkt >= 0)),
  ]);
  console.log('corr(mkt, ret):', JSON.stringify(corr(withMkt, 'mkt')));
}

// ================= 5. SG hypothesis: do WINNERS occur on timid days? =================
// Direct test of the counterexample: among the best forward outcomes, what was
// the regime posture? If big winners cluster on timid (dipBuyMult<=1.05) ticks,
// regime scaling would systematically under-size winners.
const sorted = [...withDip].sort((a, b) => b.ret - a.ret);
const topN = Math.max(20, Math.floor(sorted.length * 0.05)); // top 5% winners
const topWinners = sorted.slice(0, topN);
const timidTopShare = topWinners.filter((r) => r.dipBuyMult <= 1.05).length / topWinners.length;
const baseTimidShare = withDip.filter((r) => r.dipBuyMult <= 1.05).length / withDip.length;
console.log('\n=== SG HYPOTHESIS: are top winners on timid days? ===');
console.log(`top ${topN} winners (top 5% by fwd return)`);
console.log(`  share placed on TIMID (dipBuyMult<=1.05): ${pct(timidTopShare)}`);
console.log(`  baseline timid share of all buys        : ${pct(baseTimidShare)}`);
console.log(`  lift (top vs baseline): ${(timidTopShare / baseTimidShare).toFixed(2)}x`);
console.log(`  mean dipBuyMult of top winners: ${mean(topWinners.map((r) => r.dipBuyMult)).toFixed(3)}`);
console.log(`  mean dipBuyMult of all buys   : ${mean(withDip.map((r) => r.dipBuyMult)).toFixed(3)}`);

// ================= 6. Sizing counterfactual =================
// Compare portfolio-level avg return if you (a) size flat vs (b) regime-scale
// (favorable buys 5x weight of timid buys). We approximate a seed as a
// per-(ticker,day) buy; weight by the proposed sizing multiplier and compare
// the capital-weighted mean forward return.
function capWeightedRet(subset, weightFn) {
  let num = 0, den = 0;
  for (const r of subset) {
    const w = weightFn(r);
    num += w * r.ret; den += w;
  }
  return den ? num / den : NaN;
}
const flat = capWeightedRet(withDip, () => 1);
// proposed regime scaling on dipBuyMult: favorable(>1.25)=5x, mid=2.5x, timid(<=1.05)=1x
const regimeWeight = (r) => (r.dipBuyMult > 1.25 ? 5 : r.dipBuyMult > 1.05 ? 2.5 : 1);
const scaled = capWeightedRet(withDip, regimeWeight);
console.log('\n=== SIZING COUNTERFACTUAL (capital-weighted mean fwd return) ===');
console.log(`  flat sizing            : ${pct(flat)}`);
console.log(`  regime-scaled (dipMult): ${pct(scaled)}`);
console.log(`  delta                  : ${pct(scaled - flat)}`);

// ================= 7. SURVIVORSHIP CHECK =================
// closedPositions holds only CLOSED positions. On recent dates (7/16-7/21)
// nearly all closed positions are same-day round-trips; still-open (often
// losing) positions are excluded -> inflates recent-day / regimeMult buckets
// (that is why the thin regimeMult/mkt buckets above show 100% win rate).
// Re-run the favorable/timid split on the survivorship-CLEANER dates only.
const CLEAN_DATES = new Set(['7-7-2026', '7-9-2026', '7-13-2026', '7-14-2026', '7-15-2026']);
const cleanRows = withDip.filter((r) => CLEAN_DATES.has(r.date));
printTable('dipBuyMult split -- SURVIVORSHIP-CLEANER dates only', [
  summarize('timid  dip<=1.05', cleanRows.filter((r) => r.dipBuyMult <= 1.05)),
  summarize('mid    1.05-1.25', cleanRows.filter((r) => r.dipBuyMult > 1.05 && r.dipBuyMult <= 1.25)),
  summarize('favor  dip>1.25', cleanRows.filter((r) => r.dipBuyMult > 1.25)),
]);

// ================= 8. WITHIN-DAY test (per-name vs day-pacing) =================
// If dipBuyMult only predicts which DAY you traded, it is a pacing signal, not
// a per-seed predictor. Split each day's buys hi vs lo dipBuyMult (vs that
// day's mean). Only days with real intraday dip spread are informative.
console.log('\n=== WITHIN-DAY (per-NAME predictor or just day-pacing?) ===');
console.log(`${'date'.padEnd(12)} ${'spread'.padStart(7)} ${'hiDip n/ret/win'.padStart(22)} ${'loDip n/ret/win'.padStart(22)}`);
const byDayW = {};
for (const r of withDip) (byDayW[r.date] ||= []).push(r);
for (const d of Object.keys(byDayW).sort()) {
  const g = byDayW[d];
  const dips = g.map((r) => r.dipBuyMult);
  const spread = Math.max(...dips) - Math.min(...dips);
  const md = mean(dips);
  const hi = g.filter((r) => r.dipBuyMult > md);
  const lo = g.filter((r) => r.dipBuyMult <= md);
  const fmt = (s) => (s.length ? `${s.length}/${pct(mean(s.map((r) => r.ret)))}/${(winRate(s.map((r) => r.ret)) * 100).toFixed(0)}%` : '-');
  console.log(`${d.padEnd(12)} ${spread.toFixed(2).padStart(7)} ${fmt(hi).padStart(22)} ${fmt(lo).padStart(22)}`);
}

// per-day breakdown so we can see if regime is a pacing (whole-day) signal
console.log('\n=== PER-DAY (does regime move the whole day, not the name?) ===');
const byDay = {};
for (const r of withDip) {
  (byDay[r.date] ||= []).push(r);
}
console.log(`${'date'.padEnd(12)} ${'n'.padStart(5)} ${'meanRet'.padStart(9)} ${'win%'.padStart(6)} ${'meanDip'.padStart(8)} ${'dipRange'.padStart(12)}`);
for (const d of Object.keys(byDay).sort((a, b) => {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return new Date(pa[2], pa[0] - 1, pa[1]) - new Date(pb[2], pb[0] - 1, pb[1]);
})) {
  const g = byDay[d];
  const dips = g.map((r) => r.dipBuyMult);
  console.log(
    `${d.padEnd(12)} ${String(g.length).padStart(5)} ${pct(mean(g.map((r) => r.ret))).padStart(9)} ${(winRate(g.map((r) => r.ret)) * 100).toFixed(0).padStart(6)} ${mean(dips).toFixed(2).padStart(8)} ${(Math.min(...dips).toFixed(2) + '-' + Math.max(...dips).toFixed(2)).padStart(12)}`
  );
}
