// Replays the live azc-trader rules against the 90d 5m fixtures so we
// have a real expectancy number for the current methodology before we
// touch a single knob.
//
// Mirrors azc-trader.mjs exactly: HTF=1h SMA(20) bias, 5m unmitigated FVG
// retest, entry at FVG mid, SL at far edge + FVG_BUFFER_PCT*body with
// MIN_STOP_PCT floor, TP at RR*stopDist, killzone gate, per-symbol
// cooldown, MAX_HOLD_MS force-close. Walks tick-by-tick using each 5m
// bar's high/low to resolve TP/SL.
//
// Usage:
//   node tests/backtest-azc-trader.mjs                       (all assets, default rules)
//   node tests/backtest-azc-trader.mjs --asset=BTC           (one asset)
//   node tests/backtest-azc-trader.mjs --rr=2 --min-stop=0.0035  (vary knobs)
//
// Output: per-symbol fills/wins/losses/be, win rate, expectancy in R,
// then an aggregate row. Compare runs side-by-side to argue from data.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, 'fixtures');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.replace(/^--/, '').split('=');
  return [m[0], m[1] ?? true];
}));

// Tunable knobs — defaults mirror live azc-trader constants exactly.
const TF_MIN              = 5;
const HTF_MIN             = 60;
const LOOKBACK_BARS       = Number(args.lookback || 40);
const HTF_SMA_LEN         = Number(args.htfSma || 20);
const FVG_BUFFER_PCT      = Number(args['fvg-buffer'] || 0.10);
const TOUCH_TOLERANCE_PCT = Number(args.touch || 0.0008);
const MIN_FVG_BODY_PCT    = Number(args['min-fvg'] || 0.0010);
const MIN_STOP_PCT        = Number(args['min-stop'] || 0.0020);
const RR                  = Number(args.rr || 1.5);
const COOLDOWN_MS         = (Number(args.cooldown ?? 15)) * 60 * 1000;
const MAX_HOLD_MS         = (Number(args['max-hold'] ?? 60)) * 60 * 1000;
const KILLZONES_ENABLED   = !args['no-killzone'];
// Dynamic fee model — fees are computed PER TRADE from the actual balance,
// risk-sized qty, notional, and per-symbol MEXC fee rates. No more
// hardcoded 0.24%-of-everything assumption.
//
// Inputs the user controls:
//   --balance=N       starting account USDT (default 50)
//   --risk=N          risk fraction per trade (default 0.03 → 3%)
//   --lev=N           leverage (default 10)
//   --min-fee=N       MEXC's per-close fee floor in USDT (empirical 0.025)
//   --funding=N       per 8h boundary funding rate (default 0.0001 = 0.01%)
//   --no-fees         disable fee subtraction (for sanity checks)
//
// Per-symbol rates come from tests/contract-meta.json (snapshot of the
// /api/v1/contract/detail endpoint — SOL/XRP/LINK are zero-fee, others
// 0.01% maker / 0.04% taker).
// Entry is POST_ONLY maker → cost depends on symbol's maker rate.
// TP-win is closed via separate limit-maker order → maker rate.
// SL-loss is closed by MEXC's stop plan → taker rate.
// BE-timeout is closed by market order → taker rate.
import { readFileSync as _readFile } from 'node:fs';
const CONTRACT_META = JSON.parse(_readFile(path.join(__dirname, 'contract-meta.json'), 'utf8'));
const BALANCE             = Number(args.balance ?? 50);
const RISK_PCT            = Number(args.risk    ?? 0.03);
const LEVERAGE            = Number(args.lev     ?? 10);
const MIN_FEE_USD         = Number(args['min-fee'] ?? 0.025);
const FUNDING_PCT_PER_WIN = Number(args.funding ?? 0.0001);
const FEES_ENABLED        = !args['no-fees'];

const KILLZONES_UTC = [
  { startH: 0,  startM: 0,  endH: 4,  endM: 0 },
  { startH: 7,  startM: 0,  endH: 10, endM: 0 },
  { startH: 12, startM: 30, endH: 16, endM: 0 },
  { startH: 18, startM: 30, endH: 22, endM: 0 },
];
function inKillzone(ts) {
  const d = new Date(ts);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return KILLZONES_UTC.some(z => {
    const s = z.startH * 60 + z.startM;
    const e = z.endH * 60 + z.endM;
    return m >= s && m < e;
  });
}

// Aggregate 5m bars → 1h bars (open=first, high=max, low=min, close=last).
function to1h(bars5) {
  const out = [];
  let bucket = null;
  for (const b of bars5) {
    const slot = Math.floor(b.t / (60 * 60 * 1000)) * 60 * 60 * 1000;
    if (!bucket || bucket.t !== slot) {
      if (bucket) out.push(bucket);
      bucket = { t: slot, o: b.o, h: b.h, l: b.l, c: b.c };
    } else {
      bucket.h = Math.max(bucket.h, b.h);
      bucket.l = Math.min(bucket.l, b.l);
      bucket.c = b.c;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

// EXACT copy of the live trader's detectUnmitigatedFvg.
function detectUnmitigatedFvg(bars) {
  if (bars.length < 3) return null;
  for (let i = bars.length - 1; i >= 2; i--) {
    const a = bars[i - 2], c = bars[i];
    let gap = null;
    if (a.h < c.l)      gap = { dir: 'bull', lo: a.h, hi: c.l };
    else if (a.l > c.h) gap = { dir: 'bear', lo: c.h, hi: a.l };
    if (!gap) continue;
    gap.mid = (gap.lo + gap.hi) / 2;
    gap.body = gap.hi - gap.lo;
    gap.formedAt = c.t;
    gap.formedIdx = i;
    let mitigated = false;
    for (let j = i + 1; j < bars.length; j++) {
      if (bars[j].l <= gap.mid && bars[j].h >= gap.mid) { mitigated = true; break; }
    }
    if (!mitigated) return gap;
  }
  return null;
}

// Build a candidate at bar index `i` looking back at 5m bars (with the
// matching rolling-window 1h SMA bias). Returns either { skip } or a
// fully-formed setup.
function buildCandidate(bars5, htfBarsUpTo, i, price) {
  if (i < LOOKBACK_BARS) return { skip: 'warmup-5m' };
  if (htfBarsUpTo.length < HTF_SMA_LEN) return { skip: 'htf-warmup' };

  const recent = htfBarsUpTo.slice(-HTF_SMA_LEN);
  const sma = recent.reduce((a, b) => a + b.c, 0) / recent.length;
  const htfDir = htfBarsUpTo[htfBarsUpTo.length - 1].c > sma ? 'bull' : 'bear';

  const window = bars5.slice(i - LOOKBACK_BARS, i + 1);
  const fvg = detectUnmitigatedFvg(window);
  if (!fvg) return { skip: 'no-fvg' };
  if (fvg.dir !== htfDir) return { skip: 'htf-disagree' };

  const fvgBodyPct = fvg.body / price;
  if (fvgBodyPct < MIN_FVG_BODY_PCT) return { skip: 'fvg-too-small' };

  const distPct = Math.abs((price - fvg.mid) / fvg.mid);
  if (distPct > TOUCH_TOLERANCE_PCT) return { skip: 'far-from-fvg' };

  const farEdge = fvg.dir === 'bull' ? fvg.lo : fvg.hi;
  const slDir   = fvg.dir === 'bull' ? -1 : 1;
  const entry   = fvg.mid;
  const slRaw   = farEdge + slDir * (fvg.body * FVG_BUFFER_PCT);
  const slMin   = entry + slDir * (price * MIN_STOP_PCT);
  const sl      = fvg.dir === 'bull' ? Math.min(slRaw, slMin) : Math.max(slRaw, slMin);
  const stopDist = Math.abs(entry - sl);
  if (!isFinite(stopDist) || stopDist <= 0)    return { skip: 'invalid-stop' };
  if (stopDist / price < MIN_STOP_PCT * 0.999) return { skip: 'stop-too-tight' };

  const tp = fvg.dir === 'bull' ? entry + stopDist * RR : entry - stopDist * RR;
  return { dir: fvg.dir, entry, sl, tp, distPct, fvgBodyPct, stopDist };
}

// Walk forward from open bar `i+1` until the next bar that crosses SL or
// TP, or MAX_HOLD_MS passes (BE). Conservative resolution: if a single
// bar's high/low spans both SL and TP, assume SL hit first (since we'd
// have set a stop loss at the exchange).
function resolve(bars5, dir, entry, sl, tp, startIdx) {
  const startTs = bars5[startIdx].t;
  for (let j = startIdx + 1; j < bars5.length; j++) {
    const b = bars5[j];
    if (b.t - startTs > MAX_HOLD_MS) {
      return { outcome: 'be', exitPrice: b.o, exitTs: b.t, holdBars: j - startIdx };
    }
    if (dir === 'bull') {
      const hitSl = b.l <= sl, hitTp = b.h >= tp;
      if (hitSl)          return { outcome: 'loss', exitPrice: sl, exitTs: b.t, holdBars: j - startIdx };
      if (hitTp)          return { outcome: 'win',  exitPrice: tp, exitTs: b.t, holdBars: j - startIdx };
    } else {
      const hitSl = b.h >= sl, hitTp = b.l <= tp;
      if (hitSl)          return { outcome: 'loss', exitPrice: sl, exitTs: b.t, holdBars: j - startIdx };
      if (hitTp)          return { outcome: 'win',  exitPrice: tp, exitTs: b.t, holdBars: j - startIdx };
    }
  }
  return { outcome: 'be', exitPrice: bars5[bars5.length - 1].c, exitTs: bars5[bars5.length - 1].t, holdBars: bars5.length - startIdx };
}

// Compute the qty the live trader would size at given balance, mirroring
// azc-trader.mjs's tryFire() math. Returns the qty + the resulting notional.
function sizeTrade(meta, entry, stopDist, balance, riskPct = RISK_PCT) {
  const stopDistUsdPerContract = meta.contractSize * stopDist;
  const riskUsd = balance * riskPct;
  let qty = Math.floor(riskUsd / stopDistUsdPerContract);
  if (qty < meta.minVol) qty = meta.minVol;
  const maxQtyByMargin = Math.floor((balance * 0.5 * LEVERAGE) / (meta.contractSize * entry));
  if (qty > maxQtyByMargin && maxQtyByMargin > 0) qty = maxQtyByMargin;
  const notional = qty * meta.contractSize * entry;
  return { qty, notional };
}

function backtestAsset(symbol, bars5) {
  const symKey = symbol.replace(/_USDT$/, '');
  const meta = CONTRACT_META[symKey];
  if (!meta) return null;  // unknown symbol — skip rather than crash
  const bars1h = to1h(bars5);
  // Map each 5m bar to "how many fully-closed 1h bars precede it" so the
  // rolling SMA only ever sees data the live trader would have had.
  const htfClosedAt = (ts5) => {
    // index of the latest 1h bar whose close time (slot + 1h) is <= ts5
    let idx = 0;
    for (let k = 0; k < bars1h.length; k++) {
      if (bars1h[k].t + 60 * 60 * 1000 <= ts5) idx = k + 1; else break;
    }
    return bars1h.slice(0, idx);
  };

  const trades = [];
  let cooldownUntil = 0;
  let i = LOOKBACK_BARS;
  while (i < bars5.length) {
    const b = bars5[i];
    if (b.t < cooldownUntil) { i++; continue; }
    if (KILLZONES_ENABLED && !inKillzone(b.t))    { i++; continue; }
    const cand = buildCandidate(bars5, htfClosedAt(b.t), i, b.c);
    if (cand.skip) { i++; continue; }
    const res = resolve(bars5, cand.dir, cand.entry, cand.sl, cand.tp, i);
    // Size the trade against current balance — matches live trader sizing
    const { qty, notional } = sizeTrade(meta, cand.entry, cand.stopDist, BALANCE);
    // 1R in $ — what one stop-distance worth of price movement is worth
    // against this position
    const oneR_usd = cand.stopDist * meta.contractSize * qty;
    const grossR =
      res.outcome === 'win'  ?  RR :
      res.outcome === 'loss' ? -1.0 :
      ((cand.dir === 'bull' ? (res.exitPrice - cand.entry) : (cand.entry - res.exitPrice)) / cand.stopDist);
    const grossUsd = grossR * oneR_usd;
    // Fee per side — entry maker, close depends on outcome.
    //   TP win  → limit-maker close → maker rate
    //   SL loss → MEXC stop plan triggers market → taker rate
    //   BE      → market-close timeout → taker rate
    //   Each side has a min-fee floor (empirical $0.025 from DOGE).
    const calcFee = (notional, rate) => Math.max(notional * rate, rate > 0 ? MIN_FEE_USD : 0);
    const feeOpen  = calcFee(notional, meta.makerFeeRate);
    const closeRate = res.outcome === 'win' ? meta.makerFeeRate : meta.takerFeeRate;
    const feeClose = calcFee(notional, closeRate);
    const startWindow = Math.floor(b.t / (8 * 3600 * 1000));
    const endWindow   = Math.floor(res.exitTs / (8 * 3600 * 1000));
    const windowsCrossed = Math.max(0, endWindow - startWindow);
    const fundingUsd = FUNDING_PCT_PER_WIN * windowsCrossed * notional;
    const totalFeeUsd = FEES_ENABLED ? (feeOpen + feeClose + fundingUsd) : 0;
    const netUsd = grossUsd - totalFeeUsd;
    const rMultiple = oneR_usd > 0 ? netUsd / oneR_usd : 0;
    trades.push({
      ts: b.t,
      dir: cand.dir,
      entry: cand.entry,
      sl: cand.sl,
      tp: cand.tp,
      ...res,
      qty, notional,
      grossR, grossUsd,
      feeOpen, feeClose, fundingUsd, totalFeeUsd,
      netUsd,
      rMultiple,
      session: sessionAt(b.t),
    });
    cooldownUntil = res.exitTs + COOLDOWN_MS;
    // Advance to the exit bar so we don't re-enter on the same FVG.
    while (i < bars5.length && bars5[i].t <= res.exitTs) i++;
  }
  return trades;
}

function sessionAt(ts) {
  const m = new Date(ts).getUTCHours() * 60 + new Date(ts).getUTCMinutes();
  for (const [n, z] of [['asia',KILLZONES_UTC[0]],['london',KILLZONES_UTC[1]],['ny-am',KILLZONES_UTC[2]],['late-ny',KILLZONES_UTC[3]]]) {
    const s = z.startH*60+z.startM, e = z.endH*60+z.endM;
    if (m >= s && m < e) return n;
  }
  return 'off';
}

function summarize(symbol, trades) {
  const wins   = trades.filter(t => t.outcome === 'win').length;
  const losses = trades.filter(t => t.outcome === 'loss').length;
  const bes    = trades.filter(t => t.outcome === 'be').length;
  const n = trades.length;
  const totalR = trades.reduce((a, t) => a + t.rMultiple, 0);
  const totalUsd = trades.reduce((a, t) => a + t.netUsd, 0);
  const totalFees = trades.reduce((a, t) => a + t.totalFeeUsd, 0);
  const avgNotional = n ? trades.reduce((a, t) => a + t.notional, 0) / n : 0;
  const winRate = n ? (wins / n) : 0;
  const expR = n ? (totalR / n) : 0;
  const expUsd = n ? (totalUsd / n) : 0;
  return { symbol, n, wins, losses, bes, winRate, totalR, expR, totalUsd, expUsd, totalFees, avgNotional };
}

const onlyAsset = args.asset ? String(args.asset).toUpperCase() : null;
const files = readdirSync(FIX_DIR)
  .filter(f => f.endsWith('-90d-Min5.json'))
  .filter(f => !onlyAsset || f.startsWith(onlyAsset + '-'));

if (!files.length) {
  console.error(`No fixtures found (looking for *-90d-Min5.json${onlyAsset ? ` matching ${onlyAsset}` : ''})`);
  process.exit(1);
}

console.log(`AZC trader backtest · 90d 5m fixtures · BALANCE=$${BALANCE} risk=${(RISK_PCT*100).toFixed(1)}% lev=${LEVERAGE}x`);
console.log(`Rules: HTF=${HTF_MIN}m SMA(${HTF_SMA_LEN}), MIN_FVG_BODY=${(MIN_FVG_BODY_PCT*100).toFixed(2)}%, MIN_STOP=${(MIN_STOP_PCT*100).toFixed(2)}%, RR=${RR}, TOUCH=${(TOUCH_TOLERANCE_PCT*100).toFixed(2)}%, COOLDOWN=${COOLDOWN_MS/60000}m, MAX_HOLD=${MAX_HOLD_MS/60000}m, killzone=${KILLZONES_ENABLED}, fees=${FEES_ENABLED}, min-fee=$${MIN_FEE_USD}`);
console.log('');
console.log('symbol   trades   wins  loss   BE    win%    netUSD     $/trade    notional    fees%gross');
console.log('-------  -------  ----  ----  ----  -----   --------   --------   ---------   ----------');

const rows = [];
for (const f of files) {
  const symbol = f.split('-')[0];
  const bars5 = JSON.parse(readFileSync(path.join(FIX_DIR, f), 'utf8'));
  const trades = backtestAsset(symbol, bars5);
  if (!trades) { continue; }  // no contract meta — skip
  const s = summarize(symbol, trades);
  rows.push(s);
  const grossUsd = trades.reduce((a, t) => a + t.grossUsd, 0);
  const feePctOfGross = grossUsd > 0 ? (s.totalFees / grossUsd * 100).toFixed(0) + '%' : '—';
  console.log(
    `${symbol.padEnd(7)}  ${String(s.n).padStart(7)}  ${String(s.wins).padStart(4)}  ${String(s.losses).padStart(4)}  ${String(s.bes).padStart(4)}  ${(s.winRate*100).toFixed(1).padStart(5)}%  $${s.totalUsd.toFixed(2).padStart(8)}  $${s.expUsd.toFixed(4).padStart(8)}   $${s.avgNotional.toFixed(0).padStart(7)}   ${feePctOfGross.padStart(9)}`
  );
}

const agg = rows.reduce((a, r) => ({
  n: a.n + r.n, wins: a.wins + r.wins, losses: a.losses + r.losses, bes: a.bes + r.bes,
  totalR: a.totalR + r.totalR, totalUsd: a.totalUsd + r.totalUsd, totalFees: a.totalFees + r.totalFees,
}), { n: 0, wins: 0, losses: 0, bes: 0, totalR: 0, totalUsd: 0, totalFees: 0 });
const aggWin = agg.n ? agg.wins / agg.n : 0;
const aggExpUsd = agg.n ? agg.totalUsd / agg.n : 0;
const aggExpR   = agg.n ? agg.totalR / agg.n : 0;
console.log('-------  -------  ----  ----  ----  -----   --------   --------   ---------   ----------');
console.log(
  `${'TOTAL'.padEnd(7)}  ${String(agg.n).padStart(7)}  ${String(agg.wins).padStart(4)}  ${String(agg.losses).padStart(4)}  ${String(agg.bes).padStart(4)}  ${(aggWin*100).toFixed(1).padStart(5)}%  $${agg.totalUsd.toFixed(2).padStart(8)}  $${aggExpUsd.toFixed(4).padStart(8)}`
);
console.log('');
console.log(`Net $ on $${BALANCE} starting: $${agg.totalUsd.toFixed(2)} after 90d (${((agg.totalUsd/BALANCE)*100).toFixed(1)}% return on bankroll)`);
console.log(`Per-trade R after fees: ${aggExpR.toFixed(3)}R · Win rate: ${(aggWin*100).toFixed(1)}% (BE at RR=${RR} is ${(100/(1+RR)).toFixed(1)}%)`);
console.log(`Total fees paid: $${agg.totalFees.toFixed(2)}`);
console.log(`Status: ${agg.totalUsd > 0 ? '✅ NET POSITIVE' : '❌ net negative'}`);
