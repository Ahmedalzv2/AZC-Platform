// Replays the live azc-trader rules against the {N}d 5m fixtures so we
// have a real expectancy number for the current methodology before we
// touch a single knob.
//
// Mirrors azc-trader.mjs exactly: HTF=1h SMA(20) bias, 5m unmitigated FVG
// retest, entry at FVG mid, SL at far edge + FVG_BUFFER_PCT*body with
// MIN_STOP_PCT floor, TP at RR*stopDist, killzone gate, per-symbol
// cooldown, MAX_HOLD_MS force-close. Walks tick-by-tick using each 5m
// bar's high/low to resolve TP/SL.
//
// Known modelling limitations:
//   1. TTL gate is bar-granular. checkPostOnlyTtlFill counts a fill if
//      the next 5m bar's range brackets the entry. Measured against
//      1m bars (tests/ttl-resolution-diag.mjs, 30d sample): the coarse
//      gate is purely OPTIMISTIC — it never misses a real fill, but
//      over-counts by ~17-22% (BTC worst at 36%, SOL/XRP best at 17%).
//      Means realistic-backtest dollar/R projections should be
//      discounted ~20% to compare against live execution.
//   2. resolve() assumes SL hits first when a bar's range spans both
//      SL and TP. Pessimistic in trending bars, accurate in chop.
//   3. Single regime — fixtures cover 90d or 365d ending today.
//      Conclusions don't generalise across market cycles.
//   4. Slippage is unmodelled. Live SL fills can be -1.06R from fast
//      adverse moves; backtest exits cleanly at SL.
//
// These bias the result in different directions and don't fully cancel.
// Treat per-trade R numbers as ±50% of the truth, not high-precision.
//
// Usage:
//   node tests/backtest-azc-trader.mjs                       (all assets, default rules)
//   node tests/backtest-azc-trader.mjs --asset=BTC           (one asset)
//   node tests/backtest-azc-trader.mjs --assets=SOL,XRP --days=365
//   node tests/backtest-azc-trader.mjs --rr=2 --min-stop=0.0035  (vary knobs)
//
// Output: per-symbol fills/wins/losses/be, win rate, expectancy in R,
// then an aggregate row. Compare runs side-by-side to argue from data.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildSetup, checkPostOnlyTtlFill } from '../trader-signal.mjs';
import { sizeTradeByRiskAndMargin } from '../trader-sizing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, 'fixtures');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.replace(/^--/, '').split('=');
  return [m[0], m[1] ?? true];
}));

// Defaults are imported from ../trader-config.mjs — the same module the
// live trader reads at boot. Pass a flag (e.g. --rr=1.5, --killzone) to
// explore non-production configs; the default proof matches what the
// trader is actually doing right now.
import * as CONFIG from '../trader-config.mjs';
const TF_MIN              = 5;
const HTF_MIN             = CONFIG.HTF_MIN;
const LOOKBACK_BARS       = Number(args.lookback || CONFIG.LOOKBACK_BARS);
const HTF_SMA_LEN         = Number(args.htfSma   || CONFIG.HTF_SMA);
const FVG_BUFFER_PCT      = Number(args['fvg-buffer'] || CONFIG.FVG_BUFFER_PCT);
const TOUCH_TOLERANCE_PCT = Number(args.touch    || CONFIG.TOUCH_TOLERANCE_PCT);
const MIN_FVG_BODY_PCT    = Number(args['min-fvg']  || CONFIG.MIN_FVG_BODY_PCT);
const MIN_STOP_PCT        = Number(args['min-stop'] || CONFIG.MIN_STOP_PCT);
const RR                  = Number(args.rr       || CONFIG.RR);
const COOLDOWN_MS         = (Number(args.cooldown ?? (CONFIG.COOLDOWN_MS / 60000))) * 60 * 1000;
const MAX_HOLD_MS         = (Number(args['max-hold'] ?? (CONFIG.MAX_HOLD_MS / 60000))) * 60 * 1000;
// Live trader does NOT gate by killzone (24/7 firing). Use --killzone to
// reintroduce the gate; --no-killzone is the explicit production default.
const KILLZONES_ENABLED   = args['killzone'] === true || args['killzone'] === 'true';
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
// Live trader uses graduated tiers (2%/3%/5%); backtest still simulates
// at one flat rate per run. Default to the TOP_2 tier (3%) since that's
// what the median fire historically lands in. Use --risk=0.05 to model
// the "best" tier.
const RISK_PCT            = Number(args.risk    ?? CONFIG.RISK_PCT_TOP_2);
const LEVERAGE            = Number(args.lev     ?? 10);
const MIN_FEE_USD         = Number(args['min-fee'] ?? 0.025);
const FUNDING_PCT_PER_WIN = Number(args.funding ?? 0.0001);
const FEES_ENABLED        = !args['no-fees'];
const SIDE_FILTER         = String(args['side'] || 'both').toLowerCase();
// --no-ttl disables the TTL fill gate — useful for sanity checks against
// the old idealised-fill numbers, never for shippable analysis.
const TTL_REALISTIC       = !args['no-ttl'];
// --ttl-bars=N controls how many 5m bars after fire we allow for the
// limit-order to fill. Default 1 ≈ matches the live 180s TTL (~60% of
// one bar; we round up to 1 since we can't sub-sample bars). Use 2-3 to
// model what happens if MAKER_ORDER_TTL_MS is increased.
const TTL_BARS            = Math.max(1, Number(args['ttl-bars'] ?? 1));
// --no-1m-fill disables the sub-bar 1m TTL gate. When 1m fixtures are
// available (tests/fixtures/{SYMBOL}-30d-Min1.json), the backtest uses
// them to model the real 180s TTL exactly instead of approximating with
// a 5m bar bracket. Per the 1m diagnostic, the 5m bracket over-counts
// fills by ~17-22%; 1m closes that gap.
const USE_1M_FILL         = !args['no-1m-fill'];
const TTL_MS              = 180_000;

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

// Backtest wrapper around the pure setup builder in trader-signal.mjs.
// Adds the bar-walking warmup gate and the side filter — those are
// backtest-only concerns and don't belong in the live signal.
function buildCandidate(bars5, htfBarsUpTo, i, price) {
  if (i < LOOKBACK_BARS) return { skip: 'warmup-5m' };
  const window = bars5.slice(i - LOOKBACK_BARS, i + 1);
  const setup = buildSetup({
    bars5m: window,
    htfBars: htfBarsUpTo,
    price,
    config: {
      HTF_SMA: HTF_SMA_LEN, FVG_BUFFER_PCT, TOUCH_TOLERANCE_PCT,
      MIN_FVG_BODY_PCT, MIN_STOP_PCT, RR,
    },
  });
  if (setup.skip) return setup;
  if (SIDE_FILTER === 'long'  && setup.fvg.dir !== 'bull') return { skip: 'side-filter' };
  if (SIDE_FILTER === 'short' && setup.fvg.dir !== 'bear') return { skip: 'side-filter' };
  return {
    dir: setup.fvg.dir,
    entry: setup.entry,
    sl: setup.sl,
    tp: setup.tp,
    distPct: setup.distPct,
    fvgBodyPct: setup.fvgBodyPct,
    stopDist: setup.stopDist,
  };
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

// Load matching 1m fixture for sub-bar TTL fill modelling. Returns
// { bars1m, firstTs, lastTs } or null when no fixture exists. The 1m
// fixtures are pulled separately (npm run dump-fixtures --interval=Min1
// --days=30) and only exist for the live symbols (SOL/XRP/BTC).
function load1mFill(symKey) {
  if (!USE_1M_FILL) return null;
  try {
    const bars1m = JSON.parse(readFileSync(path.join(FIX_DIR, `${symKey}-30d-Min1.json`), 'utf8'));
    if (!Array.isArray(bars1m) || !bars1m.length) return null;
    return { bars1m, firstTs: bars1m[0].t, lastTs: bars1m[bars1m.length - 1].t };
  } catch (e) { return null; }
}

// Binary search: first 1m bar index with t >= ts.
function find1mStart(bars1m, ts) {
  let lo = 0, hi = bars1m.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (bars1m[m].t < ts) lo = m + 1;
    else hi = m;
  }
  return lo;
}

// Slice 1m bars whose t is in [tStart, tStart+TTL_MS). Caller passes
// these as `futureBars` to checkPostOnlyTtlFill.
function slice1mWindow(bars1m, tStart) {
  const start = find1mStart(bars1m, tStart);
  const end = find1mStart(bars1m, tStart + TTL_MS);
  return bars1m.slice(start, end);
}

// Compute the qty the live trader would size at given balance, mirroring
// azc-trader.mjs's tryFire() math. Returns the qty + the resulting notional.
function sizeTrade(meta, entry, stopDist, balance, riskPct = RISK_PCT) {
  return sizeTradeByRiskAndMargin({
    balance,
    riskPct,
    leverage: LEVERAGE,
    entry,
    stopDistUsdPerContract: meta.contractSize * stopDist,
    contractSize: meta.contractSize,
    minVol: meta.minVol,
  });
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

  const fill1m = load1mFill(symKey);
  const trades = [];
  let cooldownUntil = 0;
  let ttlCancels = 0;
  let fill1mUsed = 0;
  let fill5mFallback = 0;
  let i = LOOKBACK_BARS;
  while (i < bars5.length) {
    const b = bars5[i];
    if (b.t < cooldownUntil) { i++; continue; }
    if (KILLZONES_ENABLED && !inKillzone(b.t))    { i++; continue; }
    const cand = buildCandidate(bars5, htfClosedAt(b.t), i, b.c);
    if (cand.skip) { i++; continue; }
    // Live POST_ONLY-at-FVG-mid with 180s TTL — see checkPostOnlyTtlFill
    // in trader-signal.mjs. Backtest mirrors live order placement so
    // expectancy reflects only fills that would have actually happened.
    if (TTL_REALISTIC) {
      const tFireClose = b.t + 5 * 60_000;
      // Use 1m data when its window covers this fire's full TTL window;
      // otherwise fall back to the coarse 5m bar bracket. The 1m gate is
      // accurate to the second; the 5m gate over-counts by ~17-22% (per
      // tests/ttl-resolution-diag.mjs).
      let fill;
      const have1m = fill1m && tFireClose >= fill1m.firstTs && tFireClose + TTL_MS <= fill1m.lastTs;
      if (have1m) {
        const futureBars = slice1mWindow(fill1m.bars1m, tFireClose);
        fill = checkPostOnlyTtlFill({
          dir: cand.dir, entry: cand.entry, fireBarClose: b.c,
          futureBars, ttlBars: futureBars.length,
        });
        fill1mUsed += 1;
      } else {
        fill = checkPostOnlyTtlFill({
          dir: cand.dir, entry: cand.entry, fireBarClose: b.c,
          futureBars: bars5.slice(i + 1, i + 1 + TTL_BARS),
          ttlBars: TTL_BARS,
        });
        fill5mFallback += 1;
      }
      if (!fill.filled) { ttlCancels += 1; i++; continue; }
      // Resolution starts from the 5m bar containing the fill. For the
      // 1m path, we assume bar i+1 owns the fill (sub-bar timing isn't
      // modelled in resolve()); for the 5m path, step i to fillBar - 1.
      if (!have1m && fill.fillBarOffset > 1) i += fill.fillBarOffset - 1;
    }
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
  trades.ttlCancels = ttlCancels;
  trades.fill1mUsed = fill1mUsed;
  trades.fill5mFallback = fill5mFallback;
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
const onlyAssets = args.assets
  ? new Set(String(args.assets).split(',').map(s => s.trim().toUpperCase()).filter(Boolean))
  : null;
const onlyDays = args.days ? String(args.days) : null;
const files = readdirSync(FIX_DIR)
  .filter(f => /-\d+d-Min5\.json$/.test(f))
  .filter(f => !onlyAsset || f.startsWith(onlyAsset + '-'))
  .filter(f => !onlyAssets || onlyAssets.has(f.split('-')[0]))
  .filter(f => !onlyDays || f.includes(`-${onlyDays}d-Min5.json`));

if (!files.length) {
  console.error(`No fixtures found (looking for *-d-Min5.json${onlyAsset ? ` matching ${onlyAsset}` : ''})`);
  process.exit(1);
}

// Production-config banner — printed at top so a verifier can read it
// and confirm at a glance what was simulated. Anything missing from this
// line means it isn't part of the proof.
const PROD_BANNER = [
  `AZC trader backtest · ${onlyDays || 'all'}d 5m fixtures · BALANCE=$${BALANCE} risk=${(RISK_PCT*100).toFixed(1)}% lev=${LEVERAGE}x`,
  `Production-matching defaults imported from trader-config.mjs:`,
  `  RR=${RR}  MAX_HOLD=${MAX_HOLD_MS/60000}m  COOLDOWN=${COOLDOWN_MS/60000}m  killzone=${KILLZONES_ENABLED}  side=${SIDE_FILTER}`,
  `  HTF=${HTF_MIN}m SMA(${HTF_SMA_LEN})  MIN_FVG_BODY=${(MIN_FVG_BODY_PCT*100).toFixed(2)}%  MIN_STOP=${(MIN_STOP_PCT*100).toFixed(2)}%  TOUCH=${(TOUCH_TOLERANCE_PCT*100).toFixed(2)}%`,
  `  fees=${FEES_ENABLED}  min-fee=$${MIN_FEE_USD}  funding=${(FUNDING_PCT_PER_WIN*100).toFixed(3)}%/8h`,
].join('\n');
console.log(PROD_BANNER);
console.log('');
console.log('symbol   trades   wins  loss   BE    win%    netUSD     $/trade    totalR    R/trade    fees%gross');
console.log('-------  -------  ----  ----  ----  -----   --------   --------   --------  --------   ----------');

const rows = [];
const allTrades = [];
let totalTtlCancels = 0;
let totalFill1m = 0;
let totalFill5m = 0;
for (const f of files) {
  const symbol = f.split('-')[0];
  const bars5 = JSON.parse(readFileSync(path.join(FIX_DIR, f), 'utf8'));
  const trades = backtestAsset(symbol, bars5);
  if (!trades) { continue; }  // no contract meta — skip
  totalTtlCancels += (trades.ttlCancels || 0);
  totalFill1m += (trades.fill1mUsed || 0);
  totalFill5m += (trades.fill5mFallback || 0);
  for (const t of trades) allTrades.push({ ...t, symbol });
  const s = summarize(symbol, trades);
  rows.push(s);
  const grossUsd = trades.reduce((a, t) => a + t.grossUsd, 0);
  const feePctOfGross = grossUsd > 0 ? (s.totalFees / grossUsd * 100).toFixed(0) + '%' : '—';
  console.log(
    `${symbol.padEnd(7)}  ${String(s.n).padStart(7)}  ${String(s.wins).padStart(4)}  ${String(s.losses).padStart(4)}  ${String(s.bes).padStart(4)}  ${(s.winRate*100).toFixed(1).padStart(5)}%  $${s.totalUsd.toFixed(2).padStart(8)}  $${s.expUsd.toFixed(4).padStart(8)}  ${s.totalR.toFixed(2).padStart(7)}R  ${s.expR.toFixed(3).padStart(6)}R   ${feePctOfGross.padStart(9)}`
  );
}

const agg = rows.reduce((a, r) => ({
  n: a.n + r.n, wins: a.wins + r.wins, losses: a.losses + r.losses, bes: a.bes + r.bes,
  totalR: a.totalR + r.totalR, totalUsd: a.totalUsd + r.totalUsd, totalFees: a.totalFees + r.totalFees,
}), { n: 0, wins: 0, losses: 0, bes: 0, totalR: 0, totalUsd: 0, totalFees: 0 });
const aggWin = agg.n ? agg.wins / agg.n : 0;
const aggExpUsd = agg.n ? agg.totalUsd / agg.n : 0;
const aggExpR   = agg.n ? agg.totalR / agg.n : 0;
console.log('-------  -------  ----  ----  ----  -----   --------   --------   --------  --------   ----------');
console.log(
  `${'TOTAL'.padEnd(7)}  ${String(agg.n).padStart(7)}  ${String(agg.wins).padStart(4)}  ${String(agg.losses).padStart(4)}  ${String(agg.bes).padStart(4)}  ${(aggWin*100).toFixed(1).padStart(5)}%  $${agg.totalUsd.toFixed(2).padStart(8)}  $${aggExpUsd.toFixed(4).padStart(8)}  ${agg.totalR.toFixed(2).padStart(7)}R  ${aggExpR.toFixed(3).padStart(6)}R`
);
console.log('');

// Side split — required by Hermes verification spec. Lets the LONG vs
// SHORT call be answered from this output without re-running.
function splitSummary(label, trades) {
  if (!trades.length) return `${label.padEnd(7)}  n=0  (no trades)`;
  const wins = trades.filter(t => t.outcome === 'win').length;
  const losses = trades.filter(t => t.outcome === 'loss').length;
  const bes = trades.filter(t => t.outcome === 'be').length;
  const totalR = trades.reduce((a, t) => a + t.rMultiple, 0);
  const totalUsd = trades.reduce((a, t) => a + t.netUsd, 0);
  const wr = (wins + losses) ? wins / (wins + losses) : 0;
  return `${label.padEnd(7)}  n=${String(trades.length).padStart(4)}  W=${String(wins).padStart(3)} L=${String(losses).padStart(3)} BE=${String(bes).padStart(3)}  wr=${(wr*100).toFixed(1).padStart(5)}%  netR=${totalR.toFixed(2).padStart(7)}R  R/trade=${(totalR/trades.length).toFixed(3).padStart(6)}R  netUSD=$${totalUsd.toFixed(2).padStart(7)}`;
}
const longTrades  = allTrades.filter(t => t.dir === 'bull');
const shortTrades = allTrades.filter(t => t.dir === 'bear');
console.log('Side split:');
console.log('  ' + splitSummary('LONG',  longTrades));
console.log('  ' + splitSummary('SHORT', shortTrades));
console.log('');
console.log(`Net $ on $${BALANCE} starting: $${agg.totalUsd.toFixed(2)} after ${onlyDays || 'all'}d (${((agg.totalUsd/BALANCE)*100).toFixed(1)}% return on bankroll)`);
console.log(`Per-trade R after fees: ${aggExpR.toFixed(3)}R · Win rate: ${(aggWin*100).toFixed(1)}% (BE at RR=${RR} is ${(100/(1+RR)).toFixed(1)}%)`);
console.log(`Total fees paid: $${agg.totalFees.toFixed(2)}`);
console.log(`TTL cancels (no fill within 180s): ${totalTtlCancels} (would-have-fired but order timed out)${TTL_REALISTIC ? '' : ' — TTL gate DISABLED via --no-ttl'}`);
if (TTL_REALISTIC) {
  const totalFills = totalFill1m + totalFill5m;
  const pct1m = totalFills > 0 ? (totalFill1m / totalFills * 100).toFixed(0) : '0';
  console.log(`Fill resolution: ${totalFill1m} fires via 1m bars (${pct1m}% accurate to 180s), ${totalFill5m} via 5m bracket fallback`);
}
console.log(`Status: ${agg.totalUsd > 0 ? '✅ NET POSITIVE' : '❌ net negative'}`);

// Machine-readable summary — npm run eval consumes this to diff against
// the checked-in baseline so config tweaks can be argued from data, not
// memory. --json=- writes to stdout, --json=path writes to a file.
if (args.json) {
  const sideSum = (trades) => {
    const w = trades.filter(t => t.outcome === 'win').length;
    const l = trades.filter(t => t.outcome === 'loss').length;
    const r = trades.reduce((a, t) => a + t.rMultiple, 0);
    return { n: trades.length, wins: w, losses: l, totalR: r, expectancyR: trades.length ? r / trades.length : 0 };
  };
  const bySession = {};
  for (const t of allTrades) {
    const k = t.session || 'off';
    (bySession[k] ||= []).push(t);
  }
  const summary = {
    config: { BALANCE, RR, MAX_HOLD_MS, COOLDOWN_MS, HTF_SMA_LEN, FVG_BUFFER_PCT, TOUCH_TOLERANCE_PCT, MIN_FVG_BODY_PCT, MIN_STOP_PCT, KILLZONES_ENABLED, SIDE_FILTER, FEES_ENABLED, RISK_PCT },
    aggregate: { trades: agg.n, wins: agg.wins, losses: agg.losses, bes: agg.bes, winRate: aggWin, expectancyR: aggExpR, totalR: agg.totalR, netUsd: agg.totalUsd, totalFees: agg.totalFees },
    sides: { long: sideSum(longTrades), short: sideSum(shortTrades) },
    bySession: Object.fromEntries(Object.entries(bySession).map(([k, v]) => [k, sideSum(v)])),
    bySymbol: Object.fromEntries(rows.map(r => [r.symbol, { trades: r.n, wins: r.wins, losses: r.losses, bes: r.bes, winRate: r.winRate, expectancyR: r.expR, totalR: r.totalR, netUsd: r.totalUsd }])),
  };
  const out = JSON.stringify(summary, null, 2);
  if (args.json === true || args.json === '-') {
    process.stdout.write('\n' + out + '\n');
  } else {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(args.json, out);
    console.log(`\nJSON summary written to ${args.json}`);
  }
}

// --trades-json=<path> dumps the per-trade list so downstream analyses
// (regime classification, funding-rate joins, etc.) don't need to
// re-replay the strategy. Pure data export — no behaviour change.
if (args['trades-json']) {
  const slim = allTrades.map(t => ({
    symbol: t.symbol,
    ts: t.ts,
    exitTs: t.exitTs,
    dir: t.dir,
    outcome: t.outcome,
    rMultiple: t.rMultiple,
    netUsd: t.netUsd,
    entry: t.entry,
    sl: t.sl,
    tp: t.tp,
    session: t.session,
  }));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(args['trades-json'], JSON.stringify(slim));
  console.log(`Per-trade JSON written to ${args['trades-json']} (${slim.length} trades)`);
}
