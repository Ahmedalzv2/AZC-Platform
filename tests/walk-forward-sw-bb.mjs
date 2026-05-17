// Walk the SW-BB methodology forward through the full 365d kline fixture
// (no train/test split — just simulate every signal as it would have fired
// in production) and report the actual dollar P&L at the user's intended
// $100 starting balance + 25× leverage policy.
//
// Methodology (SW-BB final, from May 2026 sweep):
//   - Assets: ETH + SILVER (1h ICT analysis)
//   - Entry: market on ICT short signal (FVG/OB/iFVG/BPR)
//   - Filter: tfData.dir === 'bear' && analysis.score >= 2
//             && analysis.phase NOT in {consolidation, reversal-suspect}
//   - SL: 1.5% price · TP: 3.0% price · Hold horizon: 24h
//   - One-at-a-time per-asset cooldown: don't re-enter while in position
//   - Leverage: 25×

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadApp } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEVERAGE = 25;
const FEE_PCT_ROUND_TRIP_OF_MARGIN = (0.02 + 0.06) / 100 * LEVERAGE; // 0.02% in
const HOLD_HOURS = 24;
const SL_PRICE_PCT = 1.5;
const TP_PRICE_PCT = 3.0;
const TF_MIN = 60;        // 1h TF
const BASE_MIN = 15;      // Min15 fixture
const WINDOW_BARS = 200;  // bars fed to _analyzeKlines

const MARGIN_PER_TRADE_OPTIONS = [5, 10, 20, 50];  // try multiple sizings
const STARTING_BALANCE = 100;

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

function simulateTrade(klines, fireIdx, dir, entry) {
  // Market entry at next bar open; close at SL/TP/horizon. Returns
  // { exitPrice, exitIdx, outcome: 'tp'|'sl'|'horizon' }.
  const next = klines[fireIdx + 1];
  if (!next) return { exitPrice: entry, exitIdx: fireIdx + 1, outcome: 'horizon' };
  const actualEntry = next.o;
  const slPriceDelta = actualEntry * SL_PRICE_PCT / 100;
  const tpPriceDelta = actualEntry * TP_PRICE_PCT / 100;
  const sl = dir === 'bear' ? actualEntry + slPriceDelta : actualEntry - slPriceDelta;
  const tp = dir === 'bear' ? actualEntry - tpPriceDelta : actualEntry + tpPriceDelta;
  const maxBars = Math.round(HOLD_HOURS * 60 / TF_MIN);
  for (let j = fireIdx + 1; j <= Math.min(fireIdx + maxBars, klines.length - 1); j++) {
    const bar = klines[j];
    if (dir === 'bear') {
      // SL hit when high reaches SL; TP hit when low reaches TP. If both in
      // same bar, treat as SL (conservative).
      if (bar.h >= sl) return { actualEntry, exitPrice: sl, exitIdx: j, outcome: 'sl' };
      if (bar.l <= tp) return { actualEntry, exitPrice: tp, exitIdx: j, outcome: 'tp' };
    } else {
      if (bar.l <= sl) return { actualEntry, exitPrice: sl, exitIdx: j, outcome: 'sl' };
      if (bar.h >= tp) return { actualEntry, exitPrice: tp, exitIdx: j, outcome: 'tp' };
    }
  }
  // Horizon hit — close at market on the last in-window bar.
  const lastIdx = Math.min(fireIdx + maxBars, klines.length - 1);
  return { actualEntry, exitPrice: klines[lastIdx].c, exitIdx: lastIdx, outcome: 'horizon' };
}

async function runAsset(asset, fixturePath, app) {
  const klines1m = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const klines = aggregate(klines1m, TF_MIN);
  const fills = [];
  let cursor = 0;
  for (let i = WINDOW_BARS; i < klines.length - 1; i++) {
    if (i < cursor) continue;
    const window = klines.slice(Math.max(0, i - WINDOW_BARS + 1), i + 1);
    const analysis = app._analyzeKlines(window);
    if (!analysis) continue;
    if (analysis.phase === 'consolidation' || analysis.phase === 'reversal-suspect') continue;
    if ((analysis.score || 0) < 2) continue;
    const sug = app._suggestedEntryForTf(analysis, '1h');
    if (!sug || sug.dir !== 'bear') continue;
    // Proximity gate — only fire when live close is within 1% of the FVG mid.
    // Matches what the live scalpMonitorTick would actually do.
    const distPct = Math.abs((klines[i].c - sug.entry) / sug.entry) * 100;
    if (distPct > 1.0) continue;
    const trade = simulateTrade(klines, i, 'bear', klines[i].c);
    fills.push({
      ts: klines[i + 1].t,
      asset,
      entry: trade.actualEntry,
      exit: trade.exitPrice,
      outcome: trade.outcome,
      // Price move % from short entry (positive = profit).
      pricePctMove: (trade.actualEntry - trade.exitPrice) / trade.actualEntry * 100,
    });
    cursor = trade.exitIdx + 1; // one-at-a-time per asset
  }
  return fills;
}

const fixtures = {
  ETH:    path.join(__dirname, 'fixtures/ETH-365d-Min15.json'),
  SILVER: path.join(__dirname, 'fixtures/SILVER-365d-Min15.json'),
};

const { app } = loadApp();
const allFills = [];
for (const [asset, fp] of Object.entries(fixtures)) {
  const fills = await runAsset(asset, fp, app);
  allFills.push(...fills);
  console.log(`${asset}: ${fills.length} trades`);
}
allFills.sort((a, b) => a.ts - b.ts);

const firstDate = new Date(allFills[0].ts).toISOString().slice(0, 10);
const lastDate  = new Date(allFills[allFills.length - 1].ts).toISOString().slice(0, 10);
const days = (allFills[allFills.length - 1].ts - allFills[0].ts) / (86400 * 1000);

console.log(`\nTotal trades: ${allFills.length}`);
console.log(`Window: ${firstDate} → ${lastDate} (${days.toFixed(0)} days)`);

const wins = allFills.filter(f => f.outcome === 'tp').length;
const losses = allFills.filter(f => f.outcome === 'sl').length;
const horizons = allFills.filter(f => f.outcome === 'horizon').length;
console.log(`Wins (TP): ${wins} (${(wins/allFills.length*100).toFixed(1)}%)`);
console.log(`Losses (SL): ${losses} (${(losses/allFills.length*100).toFixed(1)}%)`);
console.log(`Horizon exits: ${horizons} (${(horizons/allFills.length*100).toFixed(1)}%)`);

console.log(`\nP&L SIMULATION — starting $${STARTING_BALANCE} balance, ${LEVERAGE}× leverage`);
console.log('═'.repeat(75));
for (const margin of MARGIN_PER_TRADE_OPTIONS) {
  let balance = STARTING_BALANCE;
  let peak = STARTING_BALANCE;
  let maxDD = 0;
  let netPnl = 0;
  for (const f of allFills) {
    // Profit/loss in margin terms: pricePctMove × leverage = margin %
    // Fees: round-trip fee × leverage = % of margin
    const marginPctReturn = f.pricePctMove * LEVERAGE - FEE_PCT_ROUND_TRIP_OF_MARGIN * 100;
    const dollarPnl = margin * marginPctReturn / 100;
    balance += dollarPnl;
    netPnl += dollarPnl;
    if (balance > peak) peak = balance;
    const dd = (peak - balance) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  const apr = (balance / STARTING_BALANCE - 1) * (365 / days) * 100;
  console.log(`  Margin $${String(margin).padStart(3)} / trade · Final $${balance.toFixed(2).padStart(8)} · Net P&L $${netPnl.toFixed(2).padStart(7)} · Max DD ${maxDD.toFixed(1).padStart(5)}% · APR ${apr.toFixed(0).padStart(5)}%`);
}
