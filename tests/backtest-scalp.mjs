// Standalone scalp-loop back-test.
//
// Replays historical 1m klines through _analyzeKlines + _suggestedEntryForTf
// + a configurable gate stack and simulates each fire forward to TP/SL.
//
// Output is multi-metric (per "All that Glitters" — Sharpe alone overfits):
//   total trades, win rate, expectancy % of margin, max drawdown %,
//   net $ on $0.20/trade
//
// 70/30 train/test split so the OOS numbers are untouched by tuning. A flag
// fires if OOS expectancy < 50% of IS — the classic overfit tell.
//
// Usage:
//   node tests/backtest-scalp.mjs --asset=SILVER --days=14
//   node tests/backtest-scalp.mjs --asset=SOL --days=30 --verbose
//
// Data is cached under tests/.backtest-cache/ for 6h.

import { loadApp } from './harness.mjs';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '.backtest-cache');
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.replace(/^--/, '').split('=');
  return [m[0], m[1] ?? true];
}));
const DAYS = Number(args.days || 14);
const ASSET = String(args.asset || 'SILVER').toUpperCase();
const VERBOSE = Boolean(args.verbose);
const WINDOW = 200;          // candles fed to _analyzeKlines per tick
const SIM_HORIZON = 60;      // candles to walk forward looking for TP/SL
const LEVERAGE = 200;        // trio default
const MARGIN_USD = 0.20;     // per fire
const HIGH_LEV_PROXIMITY_PCT = 0.50;

const CONTRACT_SYM = {
  SOL: 'SOL_USDT',
  SILVER: 'SILVER_USDT',
  GOLD: 'GOLD_USDT',
}[ASSET];
if (!CONTRACT_SYM) {
  console.error(`Unknown asset "${ASSET}". Use SOL, SILVER, or GOLD.`);
  process.exit(1);
}

// MEXC kline endpoint returns up to ~2000 candles per request. We paginate
// backwards from now in 1-day chunks to keep each request well within that.
async function fetchKlineChunk(symbol, startSec, endSec) {
  const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Min1&start=${startSec}&end=${endSec}`;
  const proxies = [
    (u) => u,
    (u) => 'https://corsproxy.io/?' + encodeURIComponent(u),
  ];
  for (const wrap of proxies) {
    try {
      const r = await fetch(wrap(url), { cache: 'no-store' });
      if (!r.ok) continue;
      const j = await r.json();
      const d = j?.data;
      if (d && Array.isArray(d.time) && d.time.length) {
        return d.time.map((t, i) => ({
          t: t * 1000,
          o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i],
          v: +(d.vol?.[i] || 0),
        }));
      }
      if (Array.isArray(d) && d.length) {
        return d.map((k) => ({
          t: +(k.t || k.time || 0) * 1000,
          o: +(k.o ?? k.open), h: +(k.h ?? k.high),
          l: +(k.l ?? k.low),  c: +(k.c ?? k.close),
          v: +(k.v ?? k.vol ?? 0),
        }));
      }
    } catch (e) { /* try next proxy */ }
  }
  return [];
}

async function loadKlines(symbol, days) {
  const cacheFile = path.join(CACHE_DIR, `${symbol}-${days}d.json`);
  if (existsSync(cacheFile)) {
    const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (Date.now() - c.fetchedAt < 6 * 3600 * 1000) {
      console.log(`(cache hit, fetched ${Math.round((Date.now()-c.fetchedAt)/60000)} min ago)`);
      return c.klines;
    }
  }
  console.log(`Fetching ${days} days of 1m ${symbol} from MEXC public API...`);
  const endSec = Math.floor(Date.now() / 1000);
  const startSec = endSec - days * 86400;
  // Walk forward in 1-day chunks (~1440 candles each).
  const chunks = [];
  for (let s = startSec; s < endSec; s += 86400) {
    const e = Math.min(s + 86400, endSec);
    const c = await fetchKlineChunk(symbol, s, e);
    chunks.push(c);
    process.stdout.write(`  ${new Date(s*1000).toISOString().slice(0,10)} → ${c.length} candles\n`);
  }
  // Deduplicate by timestamp, sort ascending.
  const byTs = new Map();
  for (const c of chunks) for (const k of c) byTs.set(k.t, k);
  const klines = Array.from(byTs.values()).sort((a, b) => a.t - b.t);
  writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), klines }));
  return klines;
}

// Apply the same fee-aware high-lev levels the live bot uses. At lev<100 we
// fall through to the conviction-ladder sl/tp baked into _suggestedEntryForTf
// (RR=1.5 from BPR/iFVG/OB/FVG depending on source).
function applyLevels(sug, lev, tpNetPct) {
  if (lev < 100) return sug;
  const slPct = (100 / lev) * 0.7;
  const feePctMargin = 0.08 * lev;
  const grossTpMarginPct = tpNetPct + feePctMargin;
  const tpPct = grossTpMarginPct / lev;
  const slDist = sug.entry * (slPct / 100);
  const tpDist = sug.entry * (tpPct / 100);
  const sl = sug.dir === 'bull' ? sug.entry - slDist : sug.entry + slDist;
  const tp = sug.dir === 'bull' ? sug.entry + tpDist : sug.entry - tpDist;
  return { ...sug, sl, tp };
}

// Walk forward from fireIdx+1 to fireIdx+SIM_HORIZON looking for TP-hit or
// SL-hit. If a candle's range crosses both in the same bar (unresolvable
// from OHLC alone), assume SL hit first — conservative per the paper's
// "expect worse OOS" recommendation.
function simulateForward(klines, fireIdx, sug) {
  const { dir, entry, sl, tp } = sug;
  for (let i = fireIdx + 1; i < Math.min(klines.length, fireIdx + 1 + SIM_HORIZON); i++) {
    const k = klines[i];
    if (dir === 'bull') {
      const hitSl = k.l <= sl;
      const hitTp = k.h >= tp;
      if (hitSl && hitTp) return { result: 'loss', exitIdx: i, exit: sl };
      if (hitSl) return { result: 'loss', exitIdx: i, exit: sl };
      if (hitTp) return { result: 'win',  exitIdx: i, exit: tp };
    } else {
      const hitSl = k.h >= sl;
      const hitTp = k.l <= tp;
      if (hitSl && hitTp) return { result: 'loss', exitIdx: i, exit: sl };
      if (hitSl) return { result: 'loss', exitIdx: i, exit: sl };
      if (hitTp) return { result: 'win',  exitIdx: i, exit: tp };
    }
  }
  return { result: 'expired', exitIdx: fireIdx + SIM_HORIZON, exit: entry };
}

// Model the unfilled-limit cancel behavior. cancelTtlBars=0 → legacy assumption
// "limit fills at signal-bar close". cancelTtlBars>0 → watch bars i+1..i+N for
// price to actually trade through sug.entry; if it doesn't, the order is
// cancelled (no fill, no PnL). 90s ≈ 1.5 bars at 1m → use 2 for "90s cancel ON",
// 1 for stricter "60s cancel". Cancellations count separately from win/loss.
function simulateWithFillModel(klines, fireIdx, sug, cancelTtlBars) {
  if (!cancelTtlBars || cancelTtlBars <= 0) {
    return { ...simulateForward(klines, fireIdx, sug), filled: true, fillIdx: fireIdx };
  }
  let fillIdx = -1;
  for (let j = fireIdx + 1; j <= Math.min(klines.length - 1, fireIdx + cancelTtlBars); j++) {
    const k = klines[j];
    const filled = sug.dir === 'bull' ? k.l <= sug.entry : k.h >= sug.entry;
    if (filled) { fillIdx = j; break; }
  }
  if (fillIdx < 0) {
    return { result: 'cancelled', exitIdx: fireIdx + cancelTtlBars, exit: sug.entry, filled: false, fillIdx: -1 };
  }
  return { ...simulateForward(klines, fillIdx, sug), filled: true, fillIdx };
}

// Trailing TP simulation. No fixed TP; once peak NET margin reaches armPct,
// trail closes when the bar retraces by trailPct margin from peak. Mirrors
// the live _trailingTakeProfit which polls every 5s and market-closes.
// Within-bar resolution: SL checked first (conservative), then peak updated
// from favorable extreme, then trail-trigger checked against unfavorable
// extreme using the new peak.
function simulateTrail(klines, fireIdx, sug, lev, armPct, trailPct, ceilingNetPct) {
  const { dir, entry, sl } = sug;
  const feeBurden = 0.08 * lev;
  let peakMarginPct = -Infinity;
  let armed = false;
  // Optional ceiling: a fixed TP on the order body that fires if price
  // reaches it before the trail does. Visible to the user in MEXC UI.
  let ceilingPrice = null;
  if (ceilingNetPct != null) {
    const ceilingGrossPriceMovePct = (ceilingNetPct + feeBurden) / lev;
    ceilingPrice = dir === 'bull'
      ? entry * (1 + ceilingGrossPriceMovePct / 100)
      : entry * (1 - ceilingGrossPriceMovePct / 100);
  }
  for (let i = fireIdx + 1; i < Math.min(klines.length, fireIdx + 1 + SIM_HORIZON); i++) {
    const k = klines[i];
    if (dir === 'bull' && k.l <= sl) return { result: 'loss', exitIdx: i, exit: sl, filled: true, fillIdx: fireIdx };
    if (dir === 'bear' && k.h >= sl) return { result: 'loss', exitIdx: i, exit: sl, filled: true, fillIdx: fireIdx };
    const favorablePrice = dir === 'bull' ? k.h : k.l;
    const pricePct = dir === 'bull'
      ? (favorablePrice - entry) / entry * 100
      : (entry - favorablePrice) / entry * 100;
    const netMarginPct = pricePct * lev - feeBurden;
    if (netMarginPct > peakMarginPct) peakMarginPct = netMarginPct;
    if (peakMarginPct >= armPct) armed = true;
    // Ceiling check: fixed TP order fires immediately when price touches it.
    // Conservative: ceiling fires BEFORE trail check (worst case for trail).
    if (ceilingPrice != null) {
      const ceilHit = dir === 'bull' ? k.h >= ceilingPrice : k.l <= ceilingPrice;
      if (ceilHit) return { result: 'win', exitIdx: i, exit: ceilingPrice, filled: true, fillIdx: fireIdx };
    }
    if (armed) {
      const exitNetMarginPct = peakMarginPct - trailPct;
      const exitGrossPriceMovePct = (exitNetMarginPct + feeBurden) / lev;
      const exitPrice = dir === 'bull'
        ? entry * (1 + exitGrossPriceMovePct / 100)
        : entry * (1 - exitGrossPriceMovePct / 100);
      const unfavorable = dir === 'bull' ? k.l : k.h;
      const triggered = dir === 'bull' ? unfavorable <= exitPrice : unfavorable >= exitPrice;
      if (triggered) return { result: 'win', exitIdx: i, exit: exitPrice, filled: true, fillIdx: fireIdx };
    }
  }
  return { result: 'expired', exitIdx: fireIdx + SIM_HORIZON, exit: entry, filled: true, fillIdx: fireIdx };
}

// Signal-aware cancel. Wait the full horizon for a fill, BUT cancel the
// limit the moment the bias-direction move plays out without us filling
// (price reaches TP without first retracing to FVG mid). Captures "trade
// thesis already happened, we missed it" — subsequent retracement to
// FVG mid would be a stale entry. No fixed-time cancel; only signal-state
// triggers it.
function simulateSignalCancel(klines, fireIdx, sug) {
  const { dir, entry, sl, tp } = sug;
  let fillIdx = -1;
  const limit = Math.min(klines.length - 1, fireIdx + SIM_HORIZON);
  for (let j = fireIdx + 1; j <= limit; j++) {
    const k = klines[j];
    if (dir === 'bull') {
      // Long limit below current. Fill when low touches entry. Missed-winner
      // when high reaches TP without the low ever touching entry first.
      if (k.l <= entry) { fillIdx = j; break; }
      if (k.h >= tp) return { result: 'missed-winner', exitIdx: j, exit: tp, filled: false, fillIdx: -1 };
    } else {
      // Short limit above current. Fill when high touches entry. Missed-winner
      // when low reaches TP without the high ever touching entry first.
      if (k.h >= entry) { fillIdx = j; break; }
      if (k.l <= tp) return { result: 'missed-winner', exitIdx: j, exit: tp, filled: false, fillIdx: -1 };
    }
  }
  if (fillIdx < 0) {
    return { result: 'expired-unfilled', exitIdx: limit, exit: entry, filled: false, fillIdx: -1 };
  }
  return { ...simulateForward(klines, fillIdx, sug), filled: true, fillIdx };
}

// Market-entry model. Live observation: the limit-at-FVG-mid approach
// systematically misses winners (price runs with the bias, never retraces).
// Market order fills at the open of bar i+1 (closest proxy for "live price
// when the signal evaluator fires" — the WS kline tick happens ~1s after
// signal-bar close). SL/TP are RE-ANCHORED to actualEntry to match what
// the live force-fire path does (sl = price × (1 - slPct), etc.) — without
// this the SL distance balloons when actualEntry drifts from sug.entry,
// producing impossible >100% margin losses (more than liquidation).
function simulateMarketEntry(klines, fireIdx, sug, lev, tpNetPct) {
  const next = klines[fireIdx + 1];
  if (!next) return { result: 'expired', exitIdx: fireIdx + 1, exit: sug.entry, filled: false, fillIdx: -1 };
  const actualEntry = next.o;
  const slPct = (100 / lev) * 0.7 / 100;             // 0.35% at 200×
  const tpPct = (tpNetPct + 0.08 * lev) / lev / 100; // includes round-trip fee
  const dir = sug.dir;
  const sl = dir === 'bull' ? actualEntry * (1 - slPct) : actualEntry * (1 + slPct);
  const tp = dir === 'bull' ? actualEntry * (1 + tpPct) : actualEntry * (1 - tpPct);
  const fwd = simulateForward(klines, fireIdx, { dir, entry: actualEntry, sl, tp });
  return { ...fwd, filled: true, fillIdx: fireIdx + 1, actualEntry };
}

function runConfig(klines, app, cfg) {
  const trades = [];
  let cursorTs = 0;
  const lev = cfg.leverage ?? LEVERAGE;
  const tpNetPct = cfg.tpNetPct ?? 10;
  const proximityPct = cfg.proximityPct ?? HIGH_LEV_PROXIMITY_PCT;
  const cancelTtlBars = cfg.cancelTtlBars ?? 0;

  for (let i = WINDOW; i < klines.length - 1; i++) {
    if (klines[i].t < cursorTs) continue;

    const window = klines.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const analysis = app._analyzeKlines(window);
    if (!analysis) continue;

    if (cfg.phaseGate && (analysis.phase === 'consolidation' || analysis.phase === 'reversal-suspect')) continue;

    const rawSug = app._suggestedEntryForTf(analysis, '1m');
    if (!rawSug) continue;

    if (cfg.confluenceOnly && rawSug.source === 'fvg-edge') continue;

    const sug = applyLevels(rawSug, lev, tpNetPct);

    const livePrice = klines[i].c;
    const distPct = Math.abs((livePrice - sug.entry) / sug.entry) * 100;
    if (distPct > proximityPct) continue;

    // Pick exit model. Trail + market = ship-likely combo (100% fill via
    // market entry, trail handles exit). Trail + 90s = current live shape
    // (limit fills if price retraces, trail handles exit). Etc.
    let out;
    if (cfg.trail && cfg.marketEntry) {
      const next = klines[i + 1];
      if (!next) {
        out = { result: 'expired', exitIdx: i + 1, exit: sug.entry, filled: false, fillIdx: -1 };
      } else {
        const actualEntry = next.o;
        // Re-anchor SL to actual fill price (mirrors live force-fire math).
        const slPct = (100 / lev) * 0.7 / 100;
        const newSl = sug.dir === 'bull' ? actualEntry * (1 - slPct) : actualEntry * (1 + slPct);
        out = { ...simulateTrail(klines, i + 1, { ...sug, entry: actualEntry, sl: newSl }, lev, cfg.trail.armPct, cfg.trail.trailPct, cfg.trail.ceilingPct), actualEntry };
      }
    } else if (cfg.trail && cancelTtlBars > 0) {
      let fillIdx = -1;
      for (let j = i + 1; j <= Math.min(klines.length - 1, i + cancelTtlBars); j++) {
        const k = klines[j];
        const filled = sug.dir === 'bull' ? k.l <= sug.entry : k.h >= sug.entry;
        if (filled) { fillIdx = j; break; }
      }
      out = fillIdx < 0
        ? { result: 'cancelled', exitIdx: i + cancelTtlBars, exit: sug.entry, filled: false, fillIdx: -1 }
        : { ...simulateTrail(klines, fillIdx, sug, lev, cfg.trail.armPct, cfg.trail.trailPct, cfg.trail.ceilingPct), fillIdx };
    } else if (cfg.trail) {
      out = simulateTrail(klines, i, sug, lev, cfg.trail.armPct, cfg.trail.trailPct, cfg.trail.ceilingPct);
    } else if (cfg.marketEntry) {
      out = simulateMarketEntry(klines, i, sug, lev, tpNetPct);
    } else if (cfg.signalCancel) {
      out = simulateSignalCancel(klines, i, sug);
    } else {
      out = simulateWithFillModel(klines, i, sug, cancelTtlBars);
    }
    if (!out.filled) {
      trades.push({
        i, t: klines[i].t, dir: sug.dir, source: sug.source,
        entry: sug.entry, sl: sug.sl, tp: sug.tp, exit: sug.entry,
        result: 'cancelled', holdBars: out.exitIdx - i, netMarginPct: 0,
      });
      cursorTs = klines[Math.min(out.exitIdx, klines.length - 1)].t + 1;
      continue;
    }

    // For market entry, use the actual fill price (next bar's open) so
    // slippage is captured in PnL. For limit, sug.entry IS the fill.
    const fillEntry = out.actualEntry ?? sug.entry;
    const priceMovePct = ((out.exit - fillEntry) / fillEntry) * 100 * (sug.dir === 'bull' ? 1 : -1);
    const grossMarginPct = priceMovePct * lev;
    const feeMarginPct = 0.08 * lev;
    const netMarginPct = grossMarginPct - feeMarginPct;

    trades.push({
      i, t: klines[i].t, dir: sug.dir, source: sug.source,
      entry: sug.entry, sl: sug.sl, tp: sug.tp, exit: out.exit,
      result: out.result, holdBars: out.exitIdx - i,
      netMarginPct,
    });
    cursorTs = klines[Math.min(out.exitIdx, klines.length - 1)].t + 1;
  }

  return summarize(trades);
}

function summarize(trades) {
  const wins = trades.filter((t) => t.result === 'win').length;
  const losses = trades.filter((t) => t.result === 'loss').length;
  const expired = trades.filter((t) => t.result === 'expired').length;
  const cancelled = trades.filter((t) => t.result === 'cancelled').length;
  const filled = trades.length - cancelled;
  const totalNetMarginPct = trades.reduce((a, t) => a + t.netMarginPct, 0);
  // Expectancy is per FIRED trade (signals that produced an outcome). Cancelled
  // limits never opened a position, so they don't dilute the per-trade number.
  const expectancyPct = filled ? totalNetMarginPct / filled : 0;
  // Equity curve in margin units (each trade adds netMarginPct% of $0.20 margin).
  let peak = 0, trough = 0, equity = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.netMarginPct;
    if (equity > peak) { peak = equity; trough = equity; }
    if (equity < trough) trough = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  const netUsd = (totalNetMarginPct / 100) * MARGIN_USD;
  return {
    trades: trades.length, filled, wins, losses, expired, cancelled,
    winRate: filled ? wins / (wins + losses || 1) : 0,
    cancelRate: trades.length ? cancelled / trades.length : 0,
    expectancyPct, totalNetMarginPct, maxDdPct: maxDD,
    netUsd, _trades: trades,
  };
}

function fmt(s) {
  const cancelStr = s.cancelled > 0 ? ` · cncl ${(s.cancelRate*100).toFixed(0)}%` : '';
  return `${String(s.filled).padStart(4)} fills (${String(s.trades).padStart(4)} sigs${cancelStr}) · win ${String((s.winRate*100).toFixed(0)).padStart(2)}% · exp ${(s.expectancyPct >= 0 ? '+' : '') + s.expectancyPct.toFixed(2)}%/trade · MDD -${s.maxDdPct.toFixed(0)}% · net ${(s.netUsd >= 0 ? '+$' : '-$') + Math.abs(s.netUsd).toFixed(2)}`;
}

(async function main() {
  console.log(`\n═══ Scalp back-test: ${ASSET} (${CONTRACT_SYM}) ═══`);
  console.log(`Days: ${DAYS} · Leverage: ${LEVERAGE}× · Margin/trade: $${MARGIN_USD.toFixed(2)} · Horizon: ${SIM_HORIZON}m\n`);

  const klines = await loadKlines(CONTRACT_SYM, DAYS);
  if (klines.length < WINDOW + SIM_HORIZON + 100) {
    console.error(`Only ${klines.length} candles — not enough to back-test. MEXC may be missing data for ${CONTRACT_SYM}.`);
    process.exit(1);
  }
  console.log(`\nLoaded ${klines.length} 1m candles (${(klines.length/1440).toFixed(1)} days)`);
  const splitIdx = Math.floor(klines.length * 0.7);
  const isKlines = klines.slice(0, splitIdx);
  const oosKlines = klines.slice(splitIdx - WINDOW);  // overlap by WINDOW so OOS first candle has warmup
  console.log(`Split: ${(isKlines.length/1440).toFixed(1)}d IS  /  ${(oosKlines.length/1440).toFixed(1)}d OOS (with warmup)\n`);

  const { app } = loadApp();

  const configs = {
    // Baseline: trail-only, no visible ceiling (current ship — what user
    // sees as "no TP" on the MEXC order surface).
    'A · TRAIL 20/5, no ceiling (current)':   { leverage: 200, trail: { armPct: 20, trailPct: 5 }, cancelTtlBars: 2 },
    // Proposed fix: same trail, but with a visible ceiling TP on the order.
    // Ceiling fires if price runs straight through it without retracing
    // 5% from peak first. Capped upside vs no ceiling.
    'B · TRAIL 20/5 + ceiling 100':           { leverage: 200, trail: { armPct: 20, trailPct: 5, ceilingPct: 100 }, cancelTtlBars: 2 },
    'C · TRAIL 20/5 + ceiling 200':           { leverage: 200, trail: { armPct: 20, trailPct: 5, ceilingPct: 200 }, cancelTtlBars: 2 },
    'D · TRAIL 20/5 + ceiling 500':           { leverage: 200, trail: { armPct: 20, trailPct: 5, ceilingPct: 500 }, cancelTtlBars: 2 },
    // Sanity check: very tight ceiling = same as fixed TP, no trail benefit.
    'E · TRAIL 20/5 + ceiling 30 (tight)':    { leverage: 200, trail: { armPct: 20, trailPct: 5, ceilingPct: 30 }, cancelTtlBars: 2 },
    // For comparison — old fixed +20 TP.
    'F · Fixed +20 TP, 90s fill':             { leverage: 200, tpNetPct: 20, cancelTtlBars: 2 },
  };

  console.log('─'.repeat(96));
  console.log('CONFIG                              IS / OOS results');
  console.log('─'.repeat(96));

  const results = {};
  for (const [label, cfg] of Object.entries(configs)) {
    const is = runConfig(isKlines, app, cfg);
    const oos = runConfig(oosKlines, app, cfg);
    results[label] = { is, oos };
    console.log(`${label.padEnd(36)}`);
    console.log(`  IS  : ${fmt(is)}`);
    console.log(`  OOS : ${fmt(oos)}`);
    if (is.expectancyPct > 0 && oos.expectancyPct < is.expectancyPct * 0.5) {
      console.log(`  ⚠  OOS expectancy < 50% of IS — overfit-suspect per "All that Glitters"`);
    }
    if (oos.expectancyPct < 0) {
      console.log(`  ✗  OOS expectancy NEGATIVE — strategy loses money out-of-sample`);
    }
    console.log('');
  }

  console.log('─'.repeat(96));
  console.log('NOTES');
  console.log('─'.repeat(96));
  console.log(`• Fees modelled: 0.02% maker (entry, limit) + 0.06% taker (exit, stop) = 0.08% round-trip`);
  console.log(`• At ${LEVERAGE}× that's ${(0.08*LEVERAGE).toFixed(0)}% of margin in fees per round-trip`);
  console.log(`• TP target: NET +10% margin (gross ${(10+0.08*LEVERAGE).toFixed(0)}% margin = ${((10+0.08*LEVERAGE)/LEVERAGE).toFixed(2)}% price)`);
  console.log(`• SL: mechanical 0.35% price (= ${(0.35*LEVERAGE).toFixed(0)}% margin loss + ${(0.08*LEVERAGE).toFixed(0)}% fees on exit)`);
  console.log(`• Win nets +10% margin, loss nets -${(0.35*LEVERAGE + 0.08*LEVERAGE).toFixed(0)}% margin → break-even win rate ${(((0.35*LEVERAGE + 0.08*LEVERAGE)/(10 + 0.35*LEVERAGE + 0.08*LEVERAGE))*100).toFixed(0)}%`);
  console.log(`• Same-bar TP+SL hit = treated as loss (conservative; matches live worst-case)`);
  console.log('');

  if (VERBOSE) {
    for (const [label, r] of Object.entries(results)) {
      console.log(`\n=== ${label} OOS sample trades ===`);
      for (const t of r.oos._trades.slice(0, 10)) {
        const d = new Date(t.t).toISOString().slice(11, 16);
        console.log(`  ${d} ${t.dir.padEnd(4)} ${t.source.padEnd(9)} → ${t.result.padEnd(7)} ${(t.netMarginPct>=0?'+':'')}${t.netMarginPct.toFixed(1)}% margin (${t.holdBars}m hold)`);
      }
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
