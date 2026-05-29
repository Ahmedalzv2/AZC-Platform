// Cross-sectional momentum backtest: rank the universe by trailing return,
// rotate into the strongest (and optionally short the weakest), rebalance
// weekly. A portfolio/relative-strength bet — structurally different from the
// single-asset timing strategies, and the best-documented crypto factor.
// Low turnover (weekly) keeps fees negligible — the thing that killed the
// scalp. Realistic taker fees charged on ACTUAL rebalance turnover.
//
//   node tests/backtest-xsmom.mjs            # sweep lookback × K × mode
//   node tests/backtest-xsmom.mjs --wf       # anchored walk-forward (OOS)

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures');
const DAY = 86400000;
const TAKER = 0.00075;
const REBAL_DAYS = 7;

// hourly → UTC daily close series, then align all symbols to common days.
function dailyCloses(bars) {
  const m = new Map();
  for (const b of bars) m.set(Math.floor(b.t / DAY) * DAY, b.c); // last close of day wins
  return m;
}
const files = readdirSync(FIX).filter(f => /-1095d-Min60\.json$/.test(f));
if (!files.length) { console.error('No -1095d-Min60 fixtures.'); process.exit(1); }
const syms = files.map(f => f.split('-')[0]);
const maps = files.map(f => dailyCloses(JSON.parse(readFileSync(path.join(FIX, f), 'utf8'))));
const days = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort((a, b) => a - b);
const C = maps.map(m => days.map(d => m.get(d)));   // C[symIdx][dayIdx]

function backtest({ look, K, longShort }, fromIdx = 0, toIdx = days.length) {
  let eq = 1, peak = 1, maxDD = 0;
  const rets = [];
  let prevLong = new Set(), prevShort = new Set();
  for (let d = Math.max(look, fromIdx); d + REBAL_DAYS < toIdx; d += REBAL_DAYS) {
    const mom = syms.map((s, i) => ({ i, m: C[i][d] / C[i][d - look] - 1 })).sort((a, b) => b.m - a.m);
    const longs = new Set(mom.slice(0, K).map(x => x.i));
    const shortSet = longShort ? new Set(mom.slice(-K).map(x => x.i)) : new Set();
    const wLong = longShort ? 1 / (2 * K) : 1 / K;
    const wShort = 1 / (2 * K);
    let gross = 0;
    for (const i of longs) gross += wLong * (C[i][d + REBAL_DAYS] / C[i][d] - 1);
    if (longShort) for (const i of shortSet) gross -= wShort * (C[i][d + REBAL_DAYS] / C[i][d] - 1);
    // fee on turnover: legs entered/exited since last rebalance, each at its weight.
    let legs = 0;
    for (const i of longs) if (!prevLong.has(i)) legs += wLong;        // new long entry
    for (const i of prevLong) if (!longs.has(i)) legs += wLong;        // long exit
    if (longShort) {
      for (const i of shortSet) if (!prevShort.has(i)) legs += wShort;
      for (const i of prevShort) if (!shortSet.has(i)) legs += wShort;
    }
    const fee = legs * TAKER;
    const net = gross - fee;
    eq *= (1 + net); rets.push(net);
    if (eq > peak) peak = eq; const dd = (peak - eq) / peak; if (dd > maxDD) maxDD = dd;
    prevLong = longs; prevShort = shortSet;
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1)) || 1e-9;
  const greens = rets.filter(r => r > 0).length;
  return { eqMul: eq, weeks: rets.length, monthly: (eq ** (1 / (rets.length / 4.33)) - 1) * 100, sharpe: mean / sd * Math.sqrt(52), maxDD: maxDD * 100, greenPct: greens / (rets.length || 1) * 100 };
}
const fmt = m => `$200→$${(200 * m.eqMul).toFixed(0)} (${m.monthly.toFixed(1)}%/mo) Sharpe=${m.sharpe.toFixed(2)} DD=${m.maxDD.toFixed(0)}% green=${m.greenPct.toFixed(0)}% wk=${m.weeks}`;

const GRID = [];
for (const look of [7, 14, 30, 60]) for (const K of [2, 3]) for (const longShort of [true, false]) GRID.push({ look, K, longShort });

if (process.argv.includes('--wf')) {
  const FOLDS = 6, step = Math.floor(days.length / FOLDS);
  let segs = [];
  for (let k = 1; k < FOLDS; k++) {
    const trainTo = k * step, testTo = (k + 1) * step;
    let best = null;
    for (const p of GRID) { const m = backtest(p, 0, trainTo); if (m.weeks >= 10 && (!best || m.sharpe > best.sharpe)) best = { p, ...m }; }
    const os = backtest(best.p, trainTo, testTo);
    segs.push(os);
    console.log(`fold ${k}: pick L=${best.p.look} K=${best.p.K} ${best.p.longShort ? 'L/S' : 'long'} (IS Sharpe=${best.sharpe.toFixed(2)}) | OS ${fmt(os)}`);
  }
  // pooled OOS equity
  let eq = 1, peak = 1, maxDD = 0, mr = 0, wk = 0;
  for (const s of segs) { eq *= s.eqMul; if (eq > peak) peak = eq; const dd = (peak - eq) / peak; if (dd > maxDD) maxDD = dd; wk += s.weeks; }
  console.log(`\n=== OOS (chained folds, honest) === $200→$${(200 * eq).toFixed(0)}  ~${((eq ** (1 / (wk / 4.33)) - 1) * 100).toFixed(2)}%/mo  maxDD=${(maxDD * 100).toFixed(0)}%  over ${wk} weeks`);
} else {
  console.log(`X-SECTIONAL MOMENTUM · ${syms.length} symbols · weekly rebal · real ${TAKER * 100}% taker on turnover · ${days.length}d\n`);
  for (const p of GRID) console.log(`L=${String(p.look).padStart(2)}d K=${p.K} ${(p.longShort ? 'long/short' : 'long-only ').padEnd(10)} ${fmt(backtest(p))}`);
}
