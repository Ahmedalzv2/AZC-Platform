// Diagnostic: how accurate is the realistic backtest's bar-bracket TTL
// gate vs the real 180s TTL?
//
// Method: for every fire on the 5m timeframe over the last 30d (the
// window where we have both 5m AND 1m fixtures), check
//   (A) 5m gate: bar i+1's range touches FVG mid
//   (B) real-TTL gate: any 1m bar in [t_close, t_close + 180s] touches mid
//
// The output answers "is my coarse gate over- or under-counting fills?"
// without needing to port the full backtest.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildSetup, checkPostOnlyTtlFill } from '../trader-signal.mjs';
import * as CONFIG from '../trader-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, 'fixtures');

const TTL_MS = 180_000;
const ASSETS = ['SOL', 'XRP', 'BTC'];
const LOOKBACK_BARS = CONFIG.LOOKBACK_BARS;

function to1h(bars5) {
  const out = [];
  let bucket = null;
  for (const b of bars5) {
    const slot = Math.floor(b.t / 3_600_000) * 3_600_000;
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

function htfClosedAt(bars1h, ts5) {
  let idx = 0;
  for (const b of bars1h) {
    if (b.t + 3_600_000 <= ts5) idx++;
    else break;
  }
  return bars1h.slice(0, idx);
}

// Touch within bars1m where bar.t is in [tStart, tStart+TTL_MS).
function touchesIn1m(bars1m, startIdx, tStart, dir, mid) {
  for (let j = startIdx; j < bars1m.length; j++) {
    const b = bars1m[j];
    if (b.t >= tStart + TTL_MS) return false;
    if (b.t < tStart) continue;
    const hits = dir === 'bull' ? (b.l <= mid) : (b.h >= mid);
    if (hits) return true;
  }
  return false;
}

function findStart1mIdx(bars1m, ts) {
  // Binary search for the first 1m bar with t >= ts.
  let lo = 0, hi = bars1m.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (bars1m[m].t < ts) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function analyseAsset(symbol) {
  // 5m source: slice the last 30d out of the 365d-Min5 fixture so the
  // window matches the 30d-Min1.
  const f5 = path.join(FIX_DIR, `${symbol}-365d-Min5.json`);
  const f1 = path.join(FIX_DIR, `${symbol}-30d-Min1.json`);
  let bars5, bars1m;
  try { bars5 = JSON.parse(readFileSync(f5, 'utf8')); }
  catch (e) { console.log(`skip ${symbol}: no 365d-Min5 fixture`); return null; }
  try { bars1m = JSON.parse(readFileSync(f1, 'utf8')); }
  catch (e) { console.log(`skip ${symbol}: no 30d-Min1 fixture`); return null; }

  // Trim 5m to the window covered by 1m (first 1m bar onward).
  const t1mStart = bars1m[0].t;
  bars5 = bars5.filter(b => b.t >= t1mStart);
  const bars1h = to1h(bars5);

  let fires = 0;
  let coarseFill = 0;   // (A) 5m bar i+1 brackets mid
  let realFill = 0;     // (B) 1m bar within 180s brackets mid
  let bothFill = 0;
  let coarseOnly = 0;   // A but not B
  let realOnly = 0;     // B but not A

  const cfg = {
    HTF_SMA: CONFIG.HTF_SMA, FVG_BUFFER_PCT: CONFIG.FVG_BUFFER_PCT,
    TOUCH_TOLERANCE_PCT: CONFIG.TOUCH_TOLERANCE_PCT,
    MIN_FVG_BODY_PCT: CONFIG.MIN_FVG_BODY_PCT,
    MIN_STOP_PCT: CONFIG.MIN_STOP_PCT, RR: CONFIG.RR,
  };

  for (let i = LOOKBACK_BARS; i < bars5.length - 1; i++) {
    const b = bars5[i];
    const window = bars5.slice(i - LOOKBACK_BARS, i + 1);
    const setup = buildSetup({ bars5m: window, htfBars: htfClosedAt(bars1h, b.t), price: b.c, config: cfg });
    if (setup.skip) continue;

    // (A) coarse 5m bar bracket using the shared helper
    const aFill = checkPostOnlyTtlFill({
      dir: setup.fvg.dir, entry: setup.entry, fireBarClose: b.c,
      futureBars: bars5.slice(i + 1, i + 2),
      ttlBars: 1,
    });

    // (B) real 180s TTL via 1m bars. Fire bar closes at b.t + 5min.
    // PO validity is the same check as (A) — we only ask about the fill
    // gate's accuracy, so apply PO validity here too.
    const validPO = setup.fvg.dir === 'bull' ? (b.c >= setup.entry) : (b.c <= setup.entry);
    let bFilled = false;
    if (validPO) {
      const tFireClose = b.t + 5 * 60_000;
      const start1m = findStart1mIdx(bars1m, tFireClose);
      bFilled = touchesIn1m(bars1m, start1m, tFireClose, setup.fvg.dir, setup.entry);
    }

    fires += 1;
    if (aFill.filled) coarseFill += 1;
    if (bFilled) realFill += 1;
    if (aFill.filled && bFilled) bothFill += 1;
    if (aFill.filled && !bFilled) coarseOnly += 1;
    if (!aFill.filled && bFilled) realOnly += 1;
  }

  return { symbol, fires, coarseFill, realFill, bothFill, coarseOnly, realOnly };
}

console.log('symbol  fires   coarse(A)  real-180s(B)  both  A∧¬B (over)  B∧¬A (under)  A→B accuracy');
console.log('------  ------  ---------  ------------  ----  -----------  -----------  -------------');
let totFires=0, totA=0, totB=0, totBoth=0, totAOnly=0, totBOnly=0;
for (const sym of ASSETS) {
  const r = analyseAsset(sym);
  if (!r) continue;
  totFires += r.fires; totA += r.coarseFill; totB += r.realFill;
  totBoth += r.bothFill; totAOnly += r.coarseOnly; totBOnly += r.realOnly;
  const accuracy = r.coarseFill > 0 ? (r.bothFill / r.coarseFill * 100).toFixed(1) + '%' : '—';
  console.log(`${r.symbol.padEnd(6)}  ${String(r.fires).padStart(6)}  ${String(r.coarseFill).padStart(9)}  ${String(r.realFill).padStart(12)}  ${String(r.bothFill).padStart(4)}  ${String(r.coarseOnly).padStart(11)}  ${String(r.realOnly).padStart(11)}  ${accuracy.padStart(13)}`);
}
console.log('------  ------  ---------  ------------  ----  -----------  -----------  -------------');
const accAll = totA > 0 ? (totBoth / totA * 100).toFixed(1) + '%' : '—';
console.log(`TOTAL   ${String(totFires).padStart(6)}  ${String(totA).padStart(9)}  ${String(totB).padStart(12)}  ${String(totBoth).padStart(4)}  ${String(totAOnly).padStart(11)}  ${String(totBOnly).padStart(11)}  ${accAll.padStart(13)}`);
console.log('');
console.log('Reading:');
console.log('  A→B accuracy = of trades the coarse gate counts as filled, what % actually fill within real 180s TTL');
console.log('  A∧¬B (over)  = coarse counts as filled, real TTL would TTL-cancel — coarse is too OPTIMISTIC');
console.log('  B∧¬A (under) = real TTL would fill, coarse missed it — coarse is too PESSIMISTIC');
