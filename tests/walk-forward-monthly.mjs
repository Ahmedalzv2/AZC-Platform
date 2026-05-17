// Per-asset methodology sweep + monthly P&L breakdown.
// Goal: prove a strategy is *consistent* (profitable most months, not just
// a few lucky ones), not just net-positive over a year.
//
// For each asset's best methodology, output:
//   - Monthly P&L curve (which months were green / red, by how much)
//   - Profitable-months ratio (e.g. 8/12 green)
//   - Worst month $ + best month $
//   - Rolling max-drawdown over time
//   - Final equity curve as a series

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
const FEE_PCT = (0.02 + 0.06) / 100 * LEVERAGE * 100;
const WINDOW_BARS = 200;

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
    const actualEntry = next.o;
    const sl = sug.dir === 'bear' ? actualEntry * (1 + method.sl / 100) : actualEntry * (1 - method.sl / 100);
    const tp = sug.dir === 'bear' ? actualEntry * (1 - method.tp / 100) : actualEntry * (1 + method.tp / 100);
    const tfMin = tf === '1h' ? 60 : 60;
    const maxBars = Math.round(method.holdH * 60 / tfMin);
    let exit = null, outcome = 'horizon';
    for (let j = i + 1; j <= Math.min(i + maxBars, klines.length - 1); j++) {
      const bar = klines[j];
      if (sug.dir === 'bear') {
        if (bar.h >= sl) { exit = sl; outcome = 'sl'; cursor = j + 1; break; }
        if (bar.l <= tp) { exit = tp; outcome = 'tp'; cursor = j + 1; break; }
      } else {
        if (bar.l <= sl) { exit = sl; outcome = 'sl'; cursor = j + 1; break; }
        if (bar.h >= tp) { exit = tp; outcome = 'tp'; cursor = j + 1; break; }
      }
    }
    if (!exit) {
      const lastIdx = Math.min(i + maxBars, klines.length - 1);
      exit = klines[lastIdx].c;
      cursor = lastIdx + 1;
    }
    const pricePctMove = sug.dir === 'bear'
      ? (actualEntry - exit) / actualEntry * 100
      : (exit - actualEntry) / actualEntry * 100;
    const marginPctReturn = pricePctMove * LEVERAGE - FEE_PCT;
    const dollarPnl = MARGIN * marginPctReturn / 100;
    fills.push({ ts: next.t, outcome, pricePctMove, dollarPnl, dir: sug.dir });
  }
  return fills;
}

function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function analyzeFills(fills) {
  // Monthly P&L
  const monthly = {};
  for (const f of fills) {
    const k = monthKey(f.ts);
    monthly[k] = monthly[k] || { pnl: 0, trades: 0, wins: 0, losses: 0 };
    monthly[k].pnl += f.dollarPnl;
    monthly[k].trades++;
    if (f.outcome === 'tp') monthly[k].wins++;
    if (f.outcome === 'sl') monthly[k].losses++;
  }
  // Equity curve + DD
  let balance = STARTING_BALANCE, peak = balance, maxDD = 0;
  const equity = [{ ts: fills[0]?.ts || 0, balance }];
  for (const f of fills) {
    balance += f.dollarPnl;
    if (balance > peak) peak = balance;
    const dd = (peak - balance) / peak * 100;
    if (dd > maxDD) maxDD = dd;
    equity.push({ ts: f.ts, balance });
  }
  const sortedMonths = Object.keys(monthly).sort();
  const greenMonths = sortedMonths.filter(m => monthly[m].pnl > 0).length;
  const monthlyPnls = sortedMonths.map(m => monthly[m].pnl);
  const bestMonth = Math.max(...monthlyPnls);
  const worstMonth = Math.min(...monthlyPnls);
  return { monthly, sortedMonths, greenMonths, totalMonths: sortedMonths.length, bestMonth, worstMonth, finalBalance: balance, netPnl: balance - STARTING_BALANCE, maxDD, equity };
}

const fixtureFiles = readdirSync(FIX_DIR).filter(f => /^[A-Z]+-365d-Min15\.json$/.test(f));
const assets = fixtureFiles.map(f => f.match(/^([A-Z]+)-/)[1]);

const { app } = loadApp();

console.log(`Monthly consistency check · lev=${LEVERAGE}× · $${MARGIN}/trade · $${STARTING_BALANCE} starting balance`);
console.log(`Assets with 365d data: ${assets.join(', ')}`);
console.log(`Missing (need 365d Min15 dump): BTC, GOLD`);
console.log('═'.repeat(110));

// Per-asset best methodology
for (const asset of assets) {
  const fp = path.join(FIX_DIR, `${asset}-365d-Min15.json`);
  const klines1m = JSON.parse(readFileSync(fp, 'utf8'));
  const klines = aggregate(klines1m, 60);
  // Find best method for this asset
  let best = null;
  for (const [name, method] of Object.entries(METHODS)) {
    const fills = runMethod(klines, method, app, '1h');
    const a = analyzeFills(fills);
    if (!best || a.netPnl > best.netPnl) best = { name, fills, ...a };
  }
  console.log(`\n${asset}  best methodology: ${best.name}`);
  console.log(`  Total: ${best.fills.length} trades · Final $${best.finalBalance.toFixed(2)} · Net ${best.netPnl >= 0 ? '+' : ''}$${best.netPnl.toFixed(2)} · Max DD ${best.maxDD.toFixed(1)}%`);
  console.log(`  Consistency: ${best.greenMonths}/${best.totalMonths} green months · best month +$${best.bestMonth.toFixed(2)} · worst month ${best.worstMonth >= 0 ? '+' : ''}$${best.worstMonth.toFixed(2)}`);
  console.log(`  Monthly breakdown:`);
  for (const m of best.sortedMonths) {
    const d = best.monthly[m];
    const winPct = d.trades ? (d.wins / d.trades * 100).toFixed(0) + '%' : '—';
    const sign = d.pnl >= 0 ? '+' : '';
    const bar = d.pnl >= 0
      ? '█'.repeat(Math.min(40, Math.round(d.pnl / 2))).padEnd(40)
      : ' '.repeat(40 - Math.min(40, Math.round(-d.pnl / 2))) + '▒'.repeat(Math.min(40, Math.round(-d.pnl / 2)));
    console.log(`    ${m}  ${String(d.trades).padStart(3)}t  ${winPct.padStart(4)}  ${sign}$${d.pnl.toFixed(2).padStart(7)}  ${bar}`);
  }
}

// Portfolio aggregate: merge all per-asset fills, compute combined monthly
console.log('\n' + '═'.repeat(110));
console.log('PORTFOLIO — best methodology per asset, combined timeline');
console.log('═'.repeat(110));
const allFills = [];
for (const asset of assets) {
  const fp = path.join(FIX_DIR, `${asset}-365d-Min15.json`);
  const klines1m = JSON.parse(readFileSync(fp, 'utf8'));
  const klines = aggregate(klines1m, 60);
  let best = null;
  for (const [name, method] of Object.entries(METHODS)) {
    const fills = runMethod(klines, method, app, '1h');
    const a = analyzeFills(fills);
    if (!best || a.netPnl > best.netPnl) best = { name, fills, ...a };
  }
  for (const f of best.fills) allFills.push({ ...f, asset });
}
allFills.sort((a, b) => a.ts - b.ts);
const portfolio = analyzeFills(allFills);
console.log(`Combined: ${allFills.length} trades · Final $${portfolio.finalBalance.toFixed(2)} · Net ${portfolio.netPnl >= 0 ? '+' : ''}$${portfolio.netPnl.toFixed(2)} · Max DD ${portfolio.maxDD.toFixed(1)}%`);
console.log(`Consistency: ${portfolio.greenMonths}/${portfolio.totalMonths} green months · best month +$${portfolio.bestMonth.toFixed(2)} · worst month ${portfolio.worstMonth >= 0 ? '+' : ''}$${portfolio.worstMonth.toFixed(2)}`);
console.log(`\nPortfolio monthly breakdown:`);
for (const m of portfolio.sortedMonths) {
  const d = portfolio.monthly[m];
  const winPct = d.trades ? (d.wins / d.trades * 100).toFixed(0) + '%' : '—';
  const sign = d.pnl >= 0 ? '+' : '';
  const bar = d.pnl >= 0
    ? '█'.repeat(Math.min(40, Math.round(d.pnl / 5))).padEnd(40)
    : ' '.repeat(40 - Math.min(40, Math.round(-d.pnl / 5))) + '▒'.repeat(Math.min(40, Math.round(-d.pnl / 5)));
  console.log(`  ${m}  ${String(d.trades).padStart(3)}t  ${winPct.padStart(4)}  ${sign}$${d.pnl.toFixed(2).padStart(7)}  ${bar}`);
}
