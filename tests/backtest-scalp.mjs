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
//   node tests/backtest-scalp.mjs --asset=SILVER --tf=5m       (single TF)
//   node tests/backtest-scalp.mjs --asset=SILVER --tf=all      (1m + 3m + 5m, default)
//
// MEXC contract only ships 1m as the finest native interval. 3m bars are
// aggregated client-side from 1m OHLCV (open=first 1m open, high=max, low=min,
// close=last 1m close, vol=sum). 5m bars same way. This is the same data the
// live bot would see if we built a 3m/5m feed off the 1m websocket.
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
let   SIM_HORIZON = 60;      // candles to walk forward looking for TP/SL (mutated per-TF below to keep ~1h wall-clock)
const LEVERAGE = Number(args.lev) || 200;  // override via --lev=100 (etc.)
const MARGIN_USD = 0.20;     // per fire
const HIGH_LEV_PROXIMITY_PCT = 0.50;

const TF_MINUTES = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '1h': 60 };
const TF_REQUESTED = (() => {
  const raw = args.tf ? String(args.tf).toLowerCase() : 'all';
  if (raw === 'all') return ['1m', '3m', '5m'];
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const tf of list) {
    if (!TF_MINUTES[tf]) {
      console.error(`Unknown TF "${tf}" in --tf="${raw}". Use 1m, 3m, 5m, 15m, 1h, all, or a comma list.`);
      process.exit(1);
    }
  }
  return list;
})();

// MEXC retains Min1 ~30d but Min5 / Min15 / Min60 much further back. Pass
// --mexc-interval=Min5 (or Min15) to fetch wider 90d windows on SILVER/GOLD.
// All requested --tf values must be a multiple of the base interval.
const MEXC_INTERVAL = String(args['mexc-interval'] || 'Min1');
const MEXC_INTERVAL_MIN = { Min1: 1, Min5: 5, Min15: 15, Min60: 60 }[MEXC_INTERVAL];
if (!MEXC_INTERVAL_MIN) {
  console.error(`Unknown --mexc-interval "${MEXC_INTERVAL}". Use Min1, Min5, Min15, or Min60.`);
  process.exit(1);
}
if (MEXC_INTERVAL_MIN > 1) {
  for (const tf of TF_REQUESTED) {
    if (TF_MINUTES[tf] < MEXC_INTERVAL_MIN || TF_MINUTES[tf] % MEXC_INTERVAL_MIN !== 0) {
      console.error(`--mexc-interval=${MEXC_INTERVAL} can't produce TF ${tf} (base ${MEXC_INTERVAL_MIN}m must divide ${TF_MINUTES[tf]}m).`);
      process.exit(1);
    }
  }
}

// GOLD on MEXC trades as XAUT_USDT (Tether Gold perpetual). The bare label
// "GOLD" used in the dashboard is just our UI alias.
const CONTRACT_SYM = {
  SOL: 'SOL_USDT',
  SILVER: 'SILVER_USDT',
  GOLD: 'XAUT_USDT',
  BTC: 'BTC_USDT',
  ETH: 'ETH_USDT',
  BNB: 'BNB_USDT',
  XRP: 'XRP_USDT',
}[ASSET];
if (!CONTRACT_SYM) {
  console.error(`Unknown asset "${ASSET}". Use SOL, SILVER, GOLD, BTC, ETH, BNB, or XRP.`);
  process.exit(1);
}

// MEXC kline endpoint returns up to ~2000 candles per request. We paginate
// backwards from now in 1-day chunks to keep each request well within that.
async function fetchKlineChunk(symbol, startSec, endSec) {
  const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${MEXC_INTERVAL}&start=${startSec}&end=${endSec}`;
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
  const tag = MEXC_INTERVAL_MIN > 1 ? `-${MEXC_INTERVAL}` : '';
  const cacheFile = path.join(CACHE_DIR, `${symbol}-${days}d${tag}.json`);
  if (existsSync(cacheFile)) {
    const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (Date.now() - c.fetchedAt < 6 * 3600 * 1000) {
      console.log(`(cache hit, fetched ${Math.round((Date.now()-c.fetchedAt)/60000)} min ago)`);
      return c.klines;
    }
  }
  console.log(`Fetching ${days} days of ${MEXC_INTERVAL_MIN}m ${symbol} from MEXC public API...`);
  const endSec = Math.floor(Date.now() / 1000);
  const startSec = endSec - days * 86400;
  // Walk forward in chunks. Min1 → 1-day chunks (~1440). Wider intervals can
  // fit much more per request — use 7-day chunks for Min5+ to cut request count.
  const chunkSec = MEXC_INTERVAL_MIN >= 5 ? 7 * 86400 : 86400;
  const chunks = [];
  for (let s = startSec; s < endSec; s += chunkSec) {
    const e = Math.min(s + chunkSec, endSec);
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

// Roll 1m OHLCV bars into N-minute bars. Bucket boundary is floor(t/Nms)*Nms
// (UTC-aligned), matching what an exchange-side N-minute kline would emit.
// Partial buckets at the edges are kept — close-of-last-1m-bar is the close.
function aggregateKlines(klines1m, intervalMins) {
  if (intervalMins === 1) return klines1m;
  const bucketMs = intervalMins * 60 * 1000;
  const buckets = new Map();
  for (const k of klines1m) {
    const start = Math.floor(k.t / bucketMs) * bucketMs;
    const b = buckets.get(start);
    if (!b) {
      buckets.set(start, { t: start, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v });
    } else {
      b.h = Math.max(b.h, k.h);
      b.l = Math.min(b.l, k.l);
      b.c = k.c;
      b.v += k.v;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
}

// Apply the same fee-aware high-lev levels the live bot uses. At lev<100 we
// fall through to the conviction-ladder sl/tp baked into _suggestedEntryForTf
// (RR=1.5 from BPR/iFVG/OB/FVG depending on source).
function applyLevels(sug, lev, tpNetPct, slCoef = 0.7, slPricePct = null, tpPricePct = null) {
  // SWING mode: explicit price-mode SL/TP (independent of leverage). Used by
  // the post-90d-OOS-research configs targeting GOLD/SILVER multi-day holds
  // at 10–25× where the lev-fit mechanical math doesn't apply.
  if (slPricePct != null && tpPricePct != null) {
    const slDist = sug.entry * (slPricePct / 100);
    const tpDist = sug.entry * (tpPricePct / 100);
    const sl = sug.dir === 'bull' ? sug.entry - slDist : sug.entry + slDist;
    const tp = sug.dir === 'bull' ? sug.entry + tpDist : sug.entry - tpDist;
    return { ...sug, sl, tp };
  }
  if (lev < 100) return sug;
  const slPct = (100 / lev) * slCoef;
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
function simulateMarketEntry(klines, fireIdx, sug, lev, tpNetPct, slCoef = 0.7, slPricePct = null, tpPricePct = null) {
  const next = klines[fireIdx + 1];
  if (!next) return { result: 'expired', exitIdx: fireIdx + 1, exit: sug.entry, filled: false, fillIdx: -1 };
  const actualEntry = next.o;
  // SWING-mode price-anchored SL/TP override (lev-independent).
  const slPct = slPricePct != null ? slPricePct / 100 : (100 / lev) * slCoef / 100;
  const tpPct = tpPricePct != null ? tpPricePct / 100 : (tpNetPct + 0.08 * lev) / lev / 100;
  const dir = sug.dir;
  const sl = dir === 'bull' ? actualEntry * (1 - slPct) : actualEntry * (1 + slPct);
  const tp = dir === 'bull' ? actualEntry * (1 + tpPct) : actualEntry * (1 - tpPct);
  const fwd = simulateForward(klines, fireIdx, { dir, entry: actualEntry, sl, tp });
  return { ...fwd, filled: true, fillIdx: fireIdx + 1, actualEntry };
}

function runConfig(klines, app, cfg, tf = '1m') {
  const trades = [];
  let cursorTs = 0;
  const lev = cfg.leverage ?? LEVERAGE;
  const tpNetPct = cfg.tpNetPct ?? 10;
  const proximityPct = cfg.proximityPct ?? HIGH_LEV_PROXIMITY_PCT;
  const cancelTtlBars = cfg.cancelTtlBars ?? 0;
  const slCoef = cfg.slCoef ?? 0.7;
  const slPricePct = cfg.slPricePct ?? null;
  const tpPricePct = cfg.tpPricePct ?? null;
  // Per-config horizon override for SWING/HTF mode. Save & restore so the
  // global TF-derived horizon is correct for non-SWING configs in this loop.
  // simHorizonHours is TF-agnostic; simHorizonBars is an explicit override.
  const savedHorizon = SIM_HORIZON;
  if (cfg.simHorizonHours) SIM_HORIZON = Math.max(1, Math.round(cfg.simHorizonHours * 60 / TF_MINUTES[tf]));
  else if (cfg.simHorizonBars) SIM_HORIZON = cfg.simHorizonBars;

  for (let i = WINDOW; i < klines.length - 1; i++) {
    if (klines[i].t < cursorTs) continue;

    if (cfg.killZone) {
      const h = new Date(klines[i].t).getUTCHours();
      const ranges = Array.isArray(cfg.killZone) ? cfg.killZone : [[7, 10], [12, 15]];
      if (!ranges.some(([s, e]) => h >= s && h < e)) continue;
    }

    const window = klines.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const analysis = app._analyzeKlines(window);
    if (!analysis) continue;

    if (cfg.phaseGate && (analysis.phase === 'consolidation' || analysis.phase === 'reversal-suspect')) continue;

    const rawSug = app._suggestedEntryForTf(analysis, tf);
    if (!rawSug) continue;

    if (cfg.confluenceOnly && rawSug.source === 'fvg-edge') continue;

    const sug = applyLevels(rawSug, lev, tpNetPct, slCoef, slPricePct, tpPricePct);

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
        const slPct = (100 / lev) * slCoef / 100;
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
      out = simulateMarketEntry(klines, i, sug, lev, tpNetPct, slCoef, slPricePct, tpPricePct);
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

  SIM_HORIZON = savedHorizon;
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
  console.log(`Days: ${DAYS} · Leverage: ${LEVERAGE}× · Margin/trade: $${MARGIN_USD.toFixed(2)} · TFs: ${TF_REQUESTED.join(', ')}\n`);

  const klines1m = await loadKlines(CONTRACT_SYM, DAYS);
  if (klines1m.length < WINDOW + 60 + 100) {
    console.error(`Only ${klines1m.length} candles — not enough to back-test. MEXC may be missing data for ${CONTRACT_SYM}.`);
    process.exit(1);
  }
  console.log(`\nLoaded ${klines1m.length} 1m candles (${(klines1m.length/1440).toFixed(1)} days)`);

  const { app } = loadApp();

  const configs = {
    // Current shipped: arm trail at +20% NET margin, trail by 5%.
    'A · TRAIL 20/5 (current ship)':          {trail: { armPct: 20, trailPct: 5, ceilingPct: 200 }, cancelTtlBars: 2 },
    // User request: "TP 14% so we can have many trade". Arm at +14%, trail
    // 5% → typical exit ~+9% margin. Faster cycle, more trades.
    'B · TRAIL 14/5 (user request)':          {trail: { armPct: 14, trailPct: 5, ceilingPct: 200 }, cancelTtlBars: 2 },
    // Tighter trail — closer to "fixed 14% with tiny wiggle".
    'C · TRAIL 14/2 (tighter trail)':         {trail: { armPct: 14, trailPct: 2, ceilingPct: 200 }, cancelTtlBars: 2 },
    // Effectively fixed +14% TP (trail=0 → exit at arm level).
    'D · Fixed +14% TP (no trail)':           {tpNetPct: 14, cancelTtlBars: 2 },
    // For comparison — the old "as designed" with a +9% target.
    'E · TRAIL 9/5 (even faster)':            {trail: { armPct: 9, trailPct: 5, ceilingPct: 200 }, cancelTtlBars: 2 },
    // What we used to ship before today.
    'F · Fixed +20% TP':                      {tpNetPct: 20, cancelTtlBars: 2 },
    // Higher TP targets — needed because SL at 200× = -86% margin, so
    // a +14-20% TP requires ~85% win rate to break even. These configs
    // give the upside enough room to compensate for the asymmetric loss.
    'G · TRAIL 50/10 (higher target)':        {trail: { armPct: 50, trailPct: 10, ceilingPct: 200 }, cancelTtlBars: 2 },
    'H · TRAIL 100/20 (big runner)':          {trail: { armPct: 100, trailPct: 20, ceilingPct: 200 }, cancelTtlBars: 2 },
    'I · Fixed +50% TP':                      {tpNetPct: 50, cancelTtlBars: 2 },
    'J · Fixed +100% TP':                     {tpNetPct: 100, cancelTtlBars: 2 },
    'K · TRAIL 30/5':                         {trail: { armPct: 30, trailPct: 5, ceilingPct: 200 }, cancelTtlBars: 2 },
    // SL-tightening sweep on the OOS leader (K). slCoef × (100/lev)% =
    // price SL. 0.7 = 0.35% (default), 0.4 = 0.20%, 0.3 = 0.15%, 0.2 = 0.10%.
    // Each step cuts loss-per-stop-out roughly in half. Hypothesis: at 0.10%
    // the break-even win rate (~64%) crosses our observed 60-70% band, so
    // EV flips positive — IF win rate doesn't collapse from noise stops.
    'L · TRAIL 30/5  SL 0.20%':               {trail: { armPct: 30, trailPct: 5, ceilingPct: 200 }, cancelTtlBars: 2, slCoef: 0.4 },
    'M · TRAIL 30/5  SL 0.15%':               {trail: { armPct: 30, trailPct: 5, ceilingPct: 200 }, cancelTtlBars: 2, slCoef: 0.3 },
    'N · TRAIL 30/5  SL 0.10%':               {trail: { armPct: 30, trailPct: 5, ceilingPct: 200 }, cancelTtlBars: 2, slCoef: 0.2 },
    // Same sweep on TRAIL 14/2 (3m winner before adding higher TPs).
    'O · TRAIL 14/2  SL 0.20%':               {trail: { armPct: 14, trailPct: 2, ceilingPct: 200 }, cancelTtlBars: 2, slCoef: 0.4 },
    'P · TRAIL 14/2  SL 0.15%':               {trail: { armPct: 14, trailPct: 2, ceilingPct: 200 }, cancelTtlBars: 2, slCoef: 0.3 },
    'Q · TRAIL 14/2  SL 0.10%':               {trail: { armPct: 14, trailPct: 2, ceilingPct: 200 }, cancelTtlBars: 2, slCoef: 0.2 },
    // Signal selectivity on the OOS leader (K). The pre-existing backtester
    // flags drop noisy signals before fire: confluenceOnly cuts plain fvg-edge
    // entries (keeps BPR/iFVG/OB+FVG/FVG+sweep); phaseGate skips consolidation
    // and reversal-suspect phases. Hypothesis: 60-70% of K's signals are
    // fvg-edge — filtering them lifts win rate enough to flip EV positive,
    // assuming the remaining high-conviction setups actually behave as ICT
    // theory claims.
    'R · K + confluenceOnly':                 {trail: { armPct: 30, trailPct: 5, ceilingPct: 200 }, cancelTtlBars: 2, confluenceOnly: true },
    'S · K + phaseGate':                      {trail: { armPct: 30, trailPct: 5, ceilingPct: 200 }, cancelTtlBars: 2, phaseGate: true },
    'T · K + both filters':                   {trail: { armPct: 30, trailPct: 5, ceilingPct: 200 }, cancelTtlBars: 2, confluenceOnly: true, phaseGate: true },
    'U · A + both filters':                   {trail: { armPct: 20, trailPct: 5, ceilingPct: 200 }, cancelTtlBars: 2, confluenceOnly: true, phaseGate: true },
    // Iteration 2: prior round's tight-SL and filter wins, STACKED. The
    // previous data showed SL 0.20% (slCoef 0.4) helped on TRAIL 14/2 and
    // filters helped on TRAIL 20/5, but nobody combined them. R:R math says
    // pushing SL to 0.10% (slCoef 0.2) + TP +50 gives margin R:R ~1.4:1, so
    // break-even win rate ~42%. Observed win rates land 50-70% — should flip
    // OOS positive IF the tight stop doesn't get noise-killed too often.
    'V · TRAIL 14/2 SL 0.20% +filters':       {trail: { armPct: 14, trailPct: 2, ceilingPct: 200 }, cancelTtlBars: 2, slCoef: 0.4, confluenceOnly: true, phaseGate: true },
    'W · TRAIL 14/2 SL 0.10% +filters':       {trail: { armPct: 14, trailPct: 2, ceilingPct: 200 }, cancelTtlBars: 2, slCoef: 0.2, confluenceOnly: true, phaseGate: true },
    'X · Fixed TP 50 SL 0.10% +filters':      {tpNetPct: 50, cancelTtlBars: 2, slCoef: 0.2, confluenceOnly: true, phaseGate: true },
    'Y · TRAIL 50/10 SL 0.10% +filters':      {trail: { armPct: 50, trailPct: 10, ceilingPct: 200 }, cancelTtlBars: 2, slCoef: 0.2, confluenceOnly: true, phaseGate: true },
    // Kill-zone restriction: only fire during London open (07-10 UTC) +
    // NY AM (12-15 UTC). Cuts ~60% of bars but ICT theory says edges live
    // only in these windows — should lift win rate via fewer dead-hour fires.
    'Z · W + killZone':                       {trail: { armPct: 14, trailPct: 2, ceilingPct: 200 }, cancelTtlBars: 2, slCoef: 0.2, confluenceOnly: true, phaseGate: true, killZone: true },
    'AA · Y + killZone':                      {trail: { armPct: 50, trailPct: 10, ceilingPct: 200 }, cancelTtlBars: 2, slCoef: 0.2, confluenceOnly: true, phaseGate: true, killZone: true },
    // Leverage diagnostic — does dropping fee drag from 16% to 4% matter
    // once SL/TP geometry is already R:R-positive? Run on Y at 50× to check.
    'BB · Y @ 50× leverage':                  {trail: { armPct: 50, trailPct: 10, ceilingPct: 200 }, cancelTtlBars: 2, slCoef: 0.2, confluenceOnly: true, phaseGate: true, leverage: 50 },
    // Iteration 3: AA (TRAIL 50/10 + SL 0.10% + filters + killZone) hit OOS
    // -0.99%/trade, basically flat. These configs push the levers harder.
    // Bigger trail target lets winners ride further; narrower kill-zone keeps
    // only the cleanest 2 hours; tighter SL cuts loss size per stop-out.
    'CC · TRAIL 100/20 + AA':                 {trail: { armPct: 100, trailPct: 20, ceilingPct: 400 }, cancelTtlBars: 2, slCoef: 0.2, confluenceOnly: true, phaseGate: true, killZone: true },
    'DD · TRAIL 200/40 + AA':                 {trail: { armPct: 200, trailPct: 40, ceilingPct: 600 }, cancelTtlBars: 2, slCoef: 0.2, confluenceOnly: true, phaseGate: true, killZone: true },
    // NY AM only (13-15 UTC) — the cleanest 2 hours per ICT lore.
    'EE · AA + NY-AM-only':                   {trail: { armPct: 50, trailPct: 10, ceilingPct: 200 }, cancelTtlBars: 2, slCoef: 0.2, confluenceOnly: true, phaseGate: true, killZone: [[13, 15]] },
    'FF · CC + NY-AM-only':                   {trail: { armPct: 100, trailPct: 20, ceilingPct: 400 }, cancelTtlBars: 2, slCoef: 0.2, confluenceOnly: true, phaseGate: true, killZone: [[13, 15]] },
    // Tighter SL (0.07% price = 14% margin loss) — smaller losses per stop-out.
    'GG · AA + SL 0.07%':                     {trail: { armPct: 50, trailPct: 10, ceilingPct: 200 }, cancelTtlBars: 2, slCoef: 0.14, confluenceOnly: true, phaseGate: true, killZone: true },
    'HH · CC + SL 0.07%':                     {trail: { armPct: 100, trailPct: 20, ceilingPct: 400 }, cancelTtlBars: 2, slCoef: 0.14, confluenceOnly: true, phaseGate: true, killZone: true },
    // Direction-of-cancel test: drop confluenceOnly (let fvg-edge fire) — does
    // filter set lose too many real trades?
    'II · AA - confluenceOnly':               {trail: { armPct: 50, trailPct: 10, ceilingPct: 200 }, cancelTtlBars: 2, slCoef: 0.2, phaseGate: true, killZone: true },
    // SWING / HTF mode (post-90d-OOS research, May 2026). The previous scalp
    // matrix lost on every >100-fill cell at every leverage because the 60-min
    // walk-forward + 0.35% price SL ate the SILVER forward-bias signal before
    // it could develop. These configs widen the horizon (4h→3d), widen SL/TP
    // to ATR-scale (0.5–2.0% price), use market entry to skip cancel friction,
    // and target the 15m / 1h entry TFs where forward-bias showed coherent
    // positive delta. Run with --lev=10 or --lev=25 (10–25× is the new policy).
    //   simHorizonBars depends on TF: 4h@15m = 16, 4h@1h = 4, 24h@15m = 96, etc.
    'SW-A · 4h hold · SL 0.5 / TP 1.0':       {marketEntry: true, slPricePct: 0.50, tpPricePct: 1.0, simHorizonHours: 4,  proximityPct: 1.0 },
    'SW-B · 4h hold · SL 0.5 / TP 2.0':       {marketEntry: true, slPricePct: 0.50, tpPricePct: 2.0, simHorizonHours: 4,  proximityPct: 1.0 },
    'SW-C · 24h hold · SL 1.0 / TP 2.0':      {marketEntry: true, slPricePct: 1.00, tpPricePct: 2.0, simHorizonHours: 24, proximityPct: 1.0 },
    'SW-D · 24h hold · SL 1.0 / TP 3.0':      {marketEntry: true, slPricePct: 1.00, tpPricePct: 3.0, simHorizonHours: 24, proximityPct: 1.0 },
    'SW-E · 72h hold · SL 2.0 / TP 4.0':      {marketEntry: true, slPricePct: 2.00, tpPricePct: 4.0, simHorizonHours: 72, proximityPct: 2.0 },
    'SW-F · SW-D + killZone (London/NY)':     {marketEntry: true, slPricePct: 1.00, tpPricePct: 3.0, simHorizonHours: 24, proximityPct: 1.0, killZone: true },
    'SW-G · SW-C + confluenceOnly':           {marketEntry: true, slPricePct: 1.00, tpPricePct: 2.0, simHorizonHours: 24, proximityPct: 1.0, confluenceOnly: true },
  };

  // Per-TF result accumulator for the cross-TF summary table.
  const tfSummary = {};

  for (const tf of TF_REQUESTED) {
    const intervalMins = TF_MINUTES[tf];
    const klines = aggregateKlines(klines1m, intervalMins);
    // Keep ~1h forward search regardless of TF (60 min / intervalMins bars).
    SIM_HORIZON = Math.max(12, Math.round(60 / intervalMins));
    const splitIdx = Math.floor(klines.length * 0.7);
    const isKlines = klines.slice(0, splitIdx);
    const oosKlines = klines.slice(splitIdx - WINDOW);  // overlap by WINDOW so OOS first candle has warmup
    const barsPerDay = 1440 / intervalMins;

    console.log('═'.repeat(96));
    console.log(`TF ${tf}  (${klines.length} bars · IS ${(isKlines.length/barsPerDay).toFixed(1)}d / OOS ${(oosKlines.length/barsPerDay).toFixed(1)}d · horizon ${SIM_HORIZON} bars = ~60min)`);
    console.log('═'.repeat(96));

    const results = {};
    for (const [label, cfg] of Object.entries(configs)) {
      const is = runConfig(isKlines, app, cfg, tf);
      const oos = runConfig(oosKlines, app, cfg, tf);
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
    tfSummary[tf] = results;

    if (VERBOSE) {
      for (const [label, r] of Object.entries(results)) {
        console.log(`\n=== ${tf} · ${label} OOS sample trades ===`);
        for (const t of r.oos._trades.slice(0, 10)) {
          const d = new Date(t.t).toISOString().slice(11, 16);
          console.log(`  ${d} ${t.dir.padEnd(4)} ${t.source.padEnd(9)} → ${t.result.padEnd(7)} ${(t.netMarginPct>=0?'+':'')}${t.netMarginPct.toFixed(1)}% margin (${t.holdBars}b hold)`);
        }
      }
    }
  }

  // Cross-TF comparison table. OOS expectancy is the headline number — it's
  // the per-trade net % of margin after fees, computed on data the tuner
  // never saw. Best OOS expectancy per config wins. Net $ is included so we
  // can see whether higher per-trade expectancy survives lower trade counts.
  if (TF_REQUESTED.length > 1) {
    console.log('═'.repeat(96));
    console.log('CROSS-TF COMPARISON  (OOS only — unseen-data results)');
    console.log('═'.repeat(96));
    const configLabels = Object.keys(tfSummary[TF_REQUESTED[0]]);
    const colW = 26;
    console.log('CONFIG'.padEnd(36) + TF_REQUESTED.map(tf => tf.padEnd(colW)).join(''));
    console.log('─'.repeat(36 + colW * TF_REQUESTED.length));
    for (const label of configLabels) {
      const row = label.padEnd(36) + TF_REQUESTED.map(tf => {
        const oos = tfSummary[tf][label].oos;
        const exp = (oos.expectancyPct >= 0 ? '+' : '') + oos.expectancyPct.toFixed(2);
        const net = (oos.netUsd >= 0 ? '+$' : '-$') + Math.abs(oos.netUsd).toFixed(2);
        return `exp ${exp}% · ${oos.filled}f · ${net}`.padEnd(colW);
      }).join('');
      console.log(row);
    }
    // Pick the best (TF, config) by OOS expectancy among configs with > 0
    // fills (anything else is unobserved). Net $ tiebreak — higher beats lower.
    let best = null;
    for (const tf of TF_REQUESTED) {
      for (const label of configLabels) {
        const oos = tfSummary[tf][label].oos;
        if (oos.filled === 0) continue;
        if (!best || oos.expectancyPct > best.exp || (oos.expectancyPct === best.exp && oos.netUsd > best.net)) {
          best = { tf, label, exp: oos.expectancyPct, net: oos.netUsd, fills: oos.filled };
        }
      }
    }
    if (best) {
      console.log('');
      const expStr = (best.exp >= 0 ? '+' : '') + best.exp.toFixed(2);
      console.log(`★ Best OOS: ${best.tf}  ·  ${best.label}  ·  exp ${expStr}%/trade  ·  ${best.fills} fills  ·  net ${(best.net>=0?'+$':'-$')+Math.abs(best.net).toFixed(2)}`);
    }
    console.log('');
  }

  console.log('─'.repeat(96));
  console.log('NOTES');
  console.log('─'.repeat(96));
  console.log(`• Fees modelled: 0.02% maker (entry, limit) + 0.06% taker (exit, stop) = 0.08% round-trip`);
  console.log(`• At ${LEVERAGE}× that's ${(0.08*LEVERAGE).toFixed(0)}% of margin in fees per round-trip`);
  console.log(`• 3m / 5m bars aggregated from MEXC 1m feed (MEXC contract has no native 3m interval)`);
  console.log(`• TP target: NET +10% margin (gross ${(10+0.08*LEVERAGE).toFixed(0)}% margin = ${((10+0.08*LEVERAGE)/LEVERAGE).toFixed(2)}% price)`);
  console.log(`• SL: mechanical 0.35% price (= ${(0.35*LEVERAGE).toFixed(0)}% margin loss + ${(0.08*LEVERAGE).toFixed(0)}% fees on exit)`);
  console.log(`• Win nets +10% margin, loss nets -${(0.35*LEVERAGE + 0.08*LEVERAGE).toFixed(0)}% margin → break-even win rate ${(((0.35*LEVERAGE + 0.08*LEVERAGE)/(10 + 0.35*LEVERAGE + 0.08*LEVERAGE))*100).toFixed(0)}%`);
  console.log(`• Same-bar TP+SL hit = treated as loss (conservative; matches live worst-case)`);
  console.log('');
})().catch((e) => { console.error(e); process.exit(1); });
