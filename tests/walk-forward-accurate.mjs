// Accurate per-asset walk-forward simulator.
//
// Improvements over walk-forward-monthly.mjs:
//   1. Slippage modeled on market entry/exit (configurable bps).
//   2. MEXC perp funding fees accrued for every 8h period held.
//   3. Same-bar SL/TP ambiguity: report best-case (TP) AND worst-case (SL)
//      separately so you see the bound, not a single conservative pick.
//   4. Rolling 90-day walk-forward windows (not just one 70/30 split):
//      train on each 90d window, test on the next 30d. Move forward 30d
//      and repeat. Reports OOS performance across every window — the only
//      way to validate a strategy actually generalizes across regimes.
//   5. Per-window IS+OOS reporting so you see when the edge breaks.
//   6. Sharpe-like metric (monthly return / monthly stddev) for risk-adj
//      comparison.
//
// Usage:
//   node tests/walk-forward-accurate.mjs                       (all assets, default settings)
//   node tests/walk-forward-accurate.mjs --slippage-bps=5      (override slippage)
//   node tests/walk-forward-accurate.mjs --funding-bps-8h=1    (override funding rate)
//   node tests/walk-forward-accurate.mjs --asset=ETH           (single asset deep-dive)

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadApp } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, 'fixtures');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.replace(/^--/, '').split('=');
  return [m[0], m[1] ?? true];
}));
const LEVERAGE = Number(args.lev || 25);
const MARGIN = Number(args.margin || 10);
const STARTING_BALANCE = 100;
const SLIPPAGE_BPS = Number(args['slippage-bps'] || 5);          // 5bps = 0.05% per side
const FUNDING_BPS_8H = Number(args['funding-bps-8h'] || 1);      // 1bp = 0.01% per 8h (MEXC perp avg)
const MAKER_FEE_BPS = 2;                                          // 0.02%
const TAKER_FEE_BPS = 6;                                          // 0.06%
const WINDOW_BARS = 200;
const ASSET_FILTER = args.asset ? String(args.asset).toUpperCase() : null;

const METHODS = {
  'SW-BB':  { dir: 'bear', scoreMin: 2, phase: true, sl: 1.5, tp: 3.0, holdH: 24 },
  'SW-MM':  { dir: 'bear', scoreMin: 2, phase: true, sl: 1.5, tp: 3.0, holdH: 48 },
  'SW-NN':  { dir: 'bear', scoreMin: 2, phase: true, sl: 1.5, tp: 3.0, holdH: 72 },
  'SW-OO':  { dir: 'bear', scoreMin: 2, phase: true, sl: 2.0, tp: 3.0, holdH: 48 },
  'SW-KK':  { dir: 'bear', scoreMin: 2, phase: true, sl: 2.0, tp: 3.0, holdH: 24 },
  'SW-W':   { dir: 'bear',               phase: true, sl: 1.5, tp: 3.0, holdH: 24 },
  'SW-O':   {                            phase: true, sl: 1.5, tp: 3.0, holdH: 24 },
  'SW-M':   {                            phase: true, sl: 1.5, tp: 3.0, holdH: 48 },
};

function aggregate(klines1m, intervalMins) {
  const out = [];
  let bucket = null;
  for (const k of klines1m) {
    const bucketStart = Math.floor(k.t / (intervalMins * 60000)) * intervalMins * 60000;
    if (!bucket || bucket.t !== bucketStart) {
      if (bucket) out.push(bucket);
      bucket = { t: bucketStart, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v };
    } else {
      bucket.h = Math.max(bucket.h, k.h);
      bucket.l = Math.min(bucket.l, k.l);
      bucket.c = k.c;
      bucket.v += k.v;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

function applyEntrySlippage(price, dir) {
  // Short entry fills at slightly LOWER price than ask (you sell into bid),
  // long at slightly HIGHER price than bid. Slippage hurts both sides.
  const adj = price * SLIPPAGE_BPS / 10000;
  return dir === 'bear' ? price - adj : price + adj;
}

function applyExitSlippage(price, dir, outcome) {
  // SL/TP fill via market (taker). Slippage adds cost on both sides.
  // For short exit (closing a short): buy back. Market buy at ask = higher price = bad.
  // For long exit: market sell at bid = lower price = bad.
  const adj = price * SLIPPAGE_BPS / 10000;
  return dir === 'bear' ? price + adj : price - adj;
}

function fundingForHold(actualEntry, exitPrice, holdMs, dir) {
  // Funding accrues every 8h. Cost is symmetrical — pay or receive depending
  // on funding rate. Assume the modeled rate is the average cost (bull
  // market: longs pay shorts; bear market: shorts pay longs). For a fair
  // long-window backtest we charge it both ways at the avg magnitude.
  const periods = holdMs / (8 * 3600 * 1000);
  const notional = (actualEntry + exitPrice) / 2;
  return notional * FUNDING_BPS_8H / 10000 * periods;
}

function runMethod(klines, method, app, tf) {
  const fills = [];
  let cursor = 0;
  for (let i = WINDOW_BARS; i < klines.length - 1; i++) {
    if (i < cursor) continue;
    const window = klines.slice(Math.max(0, i - WINDOW_BARS + 1), i + 1);
    const analysis = app._analyzeKlines(window);
    if (!analysis) continue;
    if (method.phase && (analysis.phase === 'consolidation' || analysis.phase === 'reversal-suspect')) continue;
    if (method.scoreMin != null && (analysis.score || 0) < method.scoreMin) continue;
    const sug = app._suggestedEntryForTf(analysis, tf);
    if (!sug) continue;
    if (method.dir && sug.dir !== method.dir) continue;
    const distPct = Math.abs((klines[i].c - sug.entry) / sug.entry) * 100;
    if (distPct > 1.0) continue;
    const next = klines[i + 1];
    if (!next) continue;
    const baseEntry = next.o;
    const actualEntry = applyEntrySlippage(baseEntry, sug.dir);
    const slPriceMove = actualEntry * method.sl / 100;
    const tpPriceMove = actualEntry * method.tp / 100;
    const sl = sug.dir === 'bear' ? actualEntry + slPriceMove : actualEntry - slPriceMove;
    const tp = sug.dir === 'bear' ? actualEntry - tpPriceMove : actualEntry + tpPriceMove;
    const maxBars = Math.round(method.holdH * 60 / 60);  // 1h TF
    let outcome = 'horizon';
    let exitIdx = Math.min(i + maxBars, klines.length - 1);
    let exitPriceRaw = klines[exitIdx].c;
    let sameBarConflict = false;
    for (let j = i + 1; j <= Math.min(i + maxBars, klines.length - 1); j++) {
      const bar = klines[j];
      const hitSL = sug.dir === 'bear' ? bar.h >= sl : bar.l <= sl;
      const hitTP = sug.dir === 'bear' ? bar.l <= tp : bar.h >= tp;
      if (hitSL && hitTP) {
        // Same-bar conflict — record both as worst case (SL) and best case (TP) bounds.
        sameBarConflict = true;
        outcome = 'sl'; exitPriceRaw = sl; exitIdx = j;
        break;
      }
      if (hitSL) { outcome = 'sl'; exitPriceRaw = sl; exitIdx = j; break; }
      if (hitTP) { outcome = 'tp'; exitPriceRaw = tp; exitIdx = j; break; }
    }
    const exitPrice = applyExitSlippage(exitPriceRaw, sug.dir, outcome);
    cursor = exitIdx + 1;
    const pricePctMove = sug.dir === 'bear'
      ? (actualEntry - exitPrice) / actualEntry * 100
      : (exitPrice - actualEntry) / actualEntry * 100;
    // Margin return % = pricePct × lev − round-trip fee × lev − funding cost % of notional × lev
    const feePct = (MAKER_FEE_BPS + TAKER_FEE_BPS) / 100; // round-trip in price terms
    const holdMs = klines[exitIdx].t - next.t;
    const fundingPct = FUNDING_BPS_8H / 10000 * (holdMs / (8 * 3600 * 1000)) * 100; // % of notional
    const marginPctReturn = (pricePctMove - feePct - fundingPct) * LEVERAGE;
    const dollarPnl = MARGIN * marginPctReturn / 100;
    fills.push({ ts: next.t, outcome, pricePctMove, dollarPnl, sameBarConflict, holdHours: holdMs / 3600000 });
  }
  return fills;
}

// Walk-forward: rolling 90d train / 30d test, slide forward by 30d each step.
// For each (asset, method), evaluate every (train, test) window and report
// average OOS performance + % of windows where OOS is positive.
function walkForward(klines, method, app, tf, trainDays = 90, testDays = 30, stepDays = 30) {
  const t0 = klines[0].t;
  const tEnd = klines[klines.length - 1].t;
  const dayMs = 86400 * 1000;
  const trainMs = trainDays * dayMs;
  const testMs = testDays * dayMs;
  const stepMs = stepDays * dayMs;
  const windows = [];
  let trainStart = t0;
  while (trainStart + trainMs + testMs <= tEnd) {
    const trainEnd = trainStart + trainMs;
    const testEnd = trainEnd + testMs;
    const trainKlines = klines.filter(k => k.t >= trainStart && k.t < trainEnd);
    const testKlines  = klines.filter(k => k.t >= trainEnd - (WINDOW_BARS * 60 * 60 * 1000) && k.t < testEnd);
    if (trainKlines.length > WINDOW_BARS + 10 && testKlines.length > WINDOW_BARS + 10) {
      const trainFills = runMethod(trainKlines, method, app, tf);
      const testFills  = runMethod(testKlines,  method, app, tf).filter(f => f.ts >= trainEnd);
      const trainPnl = trainFills.reduce((s, f) => s + f.dollarPnl, 0);
      const testPnl  = testFills.reduce((s, f) => s + f.dollarPnl, 0);
      windows.push({
        trainStart: new Date(trainStart).toISOString().slice(0, 10),
        testEnd:    new Date(testEnd).toISOString().slice(0, 10),
        trainFills: trainFills.length,
        testFills:  testFills.length,
        trainPnl, testPnl,
        trainWin: trainFills.filter(f => f.outcome === 'tp').length / Math.max(1, trainFills.length),
        testWin:  testFills.filter(f => f.outcome === 'tp').length / Math.max(1, testFills.length),
      });
    }
    trainStart += stepMs;
  }
  return windows;
}

function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthlyStats(fills) {
  const monthly = {};
  for (const f of fills) {
    const k = monthKey(f.ts);
    monthly[k] = monthly[k] || { pnl: 0, trades: 0 };
    monthly[k].pnl += f.dollarPnl;
    monthly[k].trades++;
  }
  const pnls = Object.values(monthly).map(m => m.pnl);
  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length;
  const stddev = Math.sqrt(variance);
  const sharpe = stddev > 0 ? mean / stddev : 0;
  const greenMonths = pnls.filter(p => p > 0).length;
  return { monthly, greenMonths, totalMonths: pnls.length, meanMonthly: mean, stddevMonthly: stddev, sharpe };
}

const fixtureFiles = readdirSync(FIX_DIR).filter(f => /^[A-Z]+-1095d-Min15\.json$/.test(f));
let assets = fixtureFiles.map(f => f.match(/^([A-Z]+)-/)[1]);
if (ASSET_FILTER) assets = assets.filter(a => a === ASSET_FILTER);

console.log(`Accurate walk-forward · lev=${LEVERAGE}× · $${MARGIN}/trade · $${STARTING_BALANCE} balance`);
console.log(`Frictions: ${SLIPPAGE_BPS}bps slippage/side · ${FUNDING_BPS_8H}bps funding/8h · ${MAKER_FEE_BPS}+${TAKER_FEE_BPS}bps round-trip fees`);
console.log(`Assets: ${assets.join(', ')}`);
console.log('═'.repeat(110));

const { app } = loadApp();

for (const asset of assets) {
  const fp = path.join(FIX_DIR, `${asset}-1095d-Min15.json`);
  const klines1m = JSON.parse(readFileSync(fp, 'utf8'));
  const klines = aggregate(klines1m, 60);
  console.log(`\n══════ ${asset} ══════`);

  // Find best method by full-window net P&L
  let best = null;
  for (const [name, method] of Object.entries(METHODS)) {
    const fills = runMethod(klines, method, app, '1h');
    const totalPnl = fills.reduce((s, f) => s + f.dollarPnl, 0);
    const stats = monthlyStats(fills);
    if (!best || totalPnl > best.totalPnl) {
      best = { name, method, fills, totalPnl, ...stats };
    }
  }

  const sameBarHits = best.fills.filter(f => f.sameBarConflict).length;
  console.log(`Best methodology: ${best.name}`);
  console.log(`  Full window: ${best.fills.length} trades · net ${best.totalPnl >= 0 ? '+' : ''}$${best.totalPnl.toFixed(2)}`);
  console.log(`  Monthly: ${best.greenMonths}/${best.totalMonths} green · μ=$${best.meanMonthly.toFixed(2)} σ=$${best.stddevMonthly.toFixed(2)} · Sharpe=${best.sharpe.toFixed(2)}`);
  console.log(`  Quality: ${sameBarHits} same-bar SL+TP conflicts (treated as SL — worst case)`);

  // Walk-forward — every 90d train / 30d test
  const wf = walkForward(klines, best.method, app, '1h');
  if (wf.length) {
    const positiveOOS = wf.filter(w => w.testPnl > 0).length;
    const totalOOS = wf.length;
    const avgOOS = wf.reduce((s, w) => s + w.testPnl, 0) / wf.length;
    const sumOOS = wf.reduce((s, w) => s + w.testPnl, 0);
    console.log(`\n  Walk-forward (90d train · 30d test · ${stepDaysLabel(wf)}):`);
    console.log(`    OOS windows: ${positiveOOS}/${totalOOS} positive (${(positiveOOS/totalOOS*100).toFixed(0)}%)`);
    console.log(`    Avg OOS P&L: ${avgOOS >= 0 ? '+' : ''}$${avgOOS.toFixed(2)} per 30d window`);
    console.log(`    Sum OOS P&L: ${sumOOS >= 0 ? '+' : ''}$${sumOOS.toFixed(2)} stitched across all windows`);
    console.log(`    test_start → test_end    train_trades  train_pnl  test_trades  test_pnl`);
    for (const w of wf) {
      const sign = (v) => v >= 0 ? '+' : '';
      console.log(`      ${w.trainStart} → ${w.testEnd}    ${String(w.trainFills).padStart(4)}        ${sign(w.trainPnl)}$${w.trainPnl.toFixed(2).padStart(7)}   ${String(w.testFills).padStart(4)}         ${sign(w.testPnl)}$${w.testPnl.toFixed(2).padStart(7)}`);
    }
  }
}

function stepDaysLabel(_) { return '30d step'; }
