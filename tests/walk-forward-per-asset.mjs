// Per-asset methodology sweep — for each asset in tests/fixtures/, run
// every candidate methodology forward through the full 365d window and
// report which one produces the best dollar P&L at $10/trade margin.
//
// Usage:
//   node tests/walk-forward-per-asset.mjs                 (all assets, default $10 margin)
//   node tests/walk-forward-per-asset.mjs --margin=20     (override per-trade margin)
//   node tests/walk-forward-per-asset.mjs --lev=10        (override leverage)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
const FEE_PCT_OF_MARGIN_ROUND_TRIP = (0.02 + 0.06) / 100 * LEVERAGE * 100; // %
const WINDOW_BARS = 200;
const TF_MIN = 60;        // 1h analysis
const BASE_MIN = 15;      // Min15 fixture

// Candidate methodologies. Built from the iter 1-12 sweep findings.
const METHODS = {
  'SW-BB (24h 1.5/3.0 short s≥2)':         { dir: 'bear', scoreMin: 2, phase: true, sl: 1.5, tp: 3.0, holdH: 24 },
  'SW-MM (48h 1.5/3.0 short s≥2)':         { dir: 'bear', scoreMin: 2, phase: true, sl: 1.5, tp: 3.0, holdH: 48 },
  'SW-NN (72h 1.5/3.0 short s≥2)':         { dir: 'bear', scoreMin: 2, phase: true, sl: 1.5, tp: 3.0, holdH: 72 },
  'SW-OO (48h 2.0/3.0 short s≥2)':         { dir: 'bear', scoreMin: 2, phase: true, sl: 2.0, tp: 3.0, holdH: 48 },
  'SW-KK (24h 2.0/3.0 short s≥2)':         { dir: 'bear', scoreMin: 2, phase: true, sl: 2.0, tp: 3.0, holdH: 24 },
  'SW-W  (24h 1.5/3.0 short phase)':       { dir: 'bear',               phase: true, sl: 1.5, tp: 3.0, holdH: 24 },
  'SW-O  (24h 1.5/3.0 both phase)':        {                            phase: true, sl: 1.5, tp: 3.0, holdH: 24 },
  'SW-M  (48h 1.5/3.0 both phase)':        {                            phase: true, sl: 1.5, tp: 3.0, holdH: 48 },
  'SW-V  (24h 1.5/3.0 long phase s≥2)':    { dir: 'bull', scoreMin: 2, phase: true, sl: 1.5, tp: 3.0, holdH: 24 },
  'SW-V2 (48h 1.5/3.0 long phase s≥2)':    { dir: 'bull', scoreMin: 2, phase: true, sl: 1.5, tp: 3.0, holdH: 48 },
  'SW-VW (24h 2.0/3.0 long phase s≥2)':    { dir: 'bull', scoreMin: 2, phase: true, sl: 2.0, tp: 3.0, holdH: 24 },
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

function simulateTrade(klines, fireIdx, dir, holdH) {
  const next = klines[fireIdx + 1];
  if (!next) return null;
  const actualEntry = next.o;
  const slPriceDelta = actualEntry * (dir === 'bear' ? 1.5 : 1.5) / 100;
  // SL/TP delta is the method's, not hardcoded. Pull from caller.
  return { actualEntry };
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
    // Proximity gate
    const distPct = Math.abs((klines[i].c - sug.entry) / sug.entry) * 100;
    if (distPct > 1.0) continue;
    // Simulate
    const next = klines[i + 1];
    if (!next) continue;
    const actualEntry = next.o;
    const sl = sug.dir === 'bear' ? actualEntry * (1 + method.sl / 100) : actualEntry * (1 - method.sl / 100);
    const tp = sug.dir === 'bear' ? actualEntry * (1 - method.tp / 100) : actualEntry * (1 + method.tp / 100);
    const maxBars = Math.round(method.holdH * 60 / TF_MIN);
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
    fills.push({ ts: next.t, outcome, pricePctMove });
  }
  // Compute dollar P&L
  let balance = STARTING_BALANCE;
  let peak = STARTING_BALANCE;
  let maxDD = 0;
  for (const f of fills) {
    const marginPctReturn = f.pricePctMove * LEVERAGE - FEE_PCT_OF_MARGIN_ROUND_TRIP;
    const dollarPnl = MARGIN * marginPctReturn / 100;
    balance += dollarPnl;
    if (balance > peak) peak = balance;
    const dd = (peak - balance) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  const wins = fills.filter(f => f.outcome === 'tp').length;
  const losses = fills.filter(f => f.outcome === 'sl').length;
  const horizons = fills.filter(f => f.outcome === 'horizon').length;
  return { fills: fills.length, wins, losses, horizons, finalBalance: balance, netPnl: balance - STARTING_BALANCE, maxDD };
}

// Discover all 365d fixtures (extend to BTC/GOLD if user dumps them later).
const fixtureFiles = readdirSync(FIX_DIR).filter(f => /^[A-Z]+-365d-Min15\.json$/.test(f));
const assets = fixtureFiles.map(f => f.match(/^([A-Z]+)-/)[1]);

console.log(`Per-asset methodology sweep · lev=${LEVERAGE}× · $${MARGIN}/trade · $${STARTING_BALANCE} starting balance`);
console.log(`Assets: ${assets.join(', ')}`);
console.log(`Methodologies: ${Object.keys(METHODS).length}`);
console.log('═'.repeat(120));

const { app } = loadApp();
const perAssetBest = {};
const allRows = [];

for (const asset of assets) {
  const fp = path.join(FIX_DIR, `${asset}-365d-Min15.json`);
  const klines1m = JSON.parse(readFileSync(fp, 'utf8'));
  const klines = aggregate(klines1m, TF_MIN);
  console.log(`\n${asset}  (${klines.length} 1h bars)`);
  console.log('  ' + 'method'.padEnd(40) + ' fills  TP/SL/Hor    win%  final$    P&L     maxDD');
  console.log('  ' + '─'.repeat(105));
  const rows = [];
  for (const [name, method] of Object.entries(METHODS)) {
    const r = runMethod(klines, method, app, '1h');
    rows.push({ asset, method: name, ...r });
    allRows.push({ asset, method: name, ...r });
    const winPct = r.fills ? (r.wins / r.fills * 100).toFixed(0) : '—';
    const finalStr = `$${r.finalBalance.toFixed(2)}`.padStart(8);
    const pnlStr   = `${r.netPnl >= 0 ? '+' : ''}$${r.netPnl.toFixed(2)}`.padStart(8);
    const ddStr    = `${r.maxDD.toFixed(1)}%`.padStart(6);
    console.log(`  ${name.padEnd(40)} ${String(r.fills).padStart(5)}   ${String(r.wins).padStart(3)}/${String(r.losses).padStart(3)}/${String(r.horizons).padStart(3)}   ${String(winPct).padStart(3)}%  ${finalStr}  ${pnlStr}  ${ddStr}`);
  }
  rows.sort((a, b) => b.netPnl - a.netPnl);
  perAssetBest[asset] = rows[0];
}

console.log('\n' + '═'.repeat(120));
console.log(`PORTFOLIO — best methodology per asset, combined`);
console.log('═'.repeat(120));
let totalPnl = 0;
let totalFills = 0;
console.log('  asset   best methodology                          fills   win%   net P&L');
console.log('  ' + '─'.repeat(105));
for (const [asset, best] of Object.entries(perAssetBest)) {
  const winPct = best.fills ? (best.wins / best.fills * 100).toFixed(0) : '—';
  const pnlStr = `${best.netPnl >= 0 ? '+' : ''}$${best.netPnl.toFixed(2)}`.padStart(8);
  console.log(`  ${asset.padEnd(7)} ${best.method.padEnd(42)} ${String(best.fills).padStart(5)}   ${String(winPct).padStart(3)}%  ${pnlStr}`);
  totalPnl += best.netPnl;
  totalFills += best.fills;
}
console.log('  ' + '─'.repeat(105));
console.log(`  COMBINED PORTFOLIO   ${''.padEnd(42)} ${String(totalFills).padStart(5)}        ${(totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(2)}`);

// Also: which methodology is best on AVERAGE across all assets (universal config)?
console.log('\n' + '═'.repeat(120));
console.log('UNIVERSAL CONFIG — same methodology across every asset (which one rules them all?)');
console.log('═'.repeat(120));
const universal = {};
for (const r of allRows) {
  universal[r.method] = universal[r.method] || { netPnl: 0, fills: 0, methods: [] };
  universal[r.method].netPnl += r.netPnl;
  universal[r.method].fills  += r.fills;
}
const univSorted = Object.entries(universal).sort((a, b) => b[1].netPnl - a[1].netPnl);
console.log('  methodology'.padEnd(45) + 'sum fills   sum net P&L');
console.log('  ' + '─'.repeat(75));
for (const [name, agg] of univSorted) {
  console.log(`  ${name.padEnd(43)} ${String(agg.fills).padStart(5)}    ${(agg.netPnl >= 0 ? '+' : '') + '$' + agg.netPnl.toFixed(2).padStart(8)}`);
}
