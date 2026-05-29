// Rate the live paper strategy (strategy-trend-trail.decideStep) by replaying
// it over 3 years of UTC-aligned 4h history, and tune/validate the regime
// (efficiency-ratio) gate. Uses the SAME code the paper harness runs, so the
// rating reflects exactly what forward-testing will do.
//
//   node tests/rate-trend-trail.mjs            # sweep erMin: 3yr vs recent windows
//   node tests/rate-trend-trail.mjs --wf       # anchored walk-forward (pick erMin OOS)

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRATEGY_PARAMS, decideStep, tradeNetR } from '../strategy-trend-trail.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures');
const FOUR_H = 4 * 3600 * 1000;
const RISK = STRATEGY_PARAMS.riskPct;

function to4h(b) {
  const m = new Map();
  for (const x of b) { const k = Math.floor(x.t / FOUR_H) * FOUR_H; const e = m.get(k); if (!e) m.set(k, { t: k, o: x.o, h: x.h, l: x.l, c: x.c }); else { e.h = Math.max(e.h, x.h); e.l = Math.min(e.l, x.l); e.c = x.c; } }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

function replay(bars, params, from = 0, to = Infinity) {
  const trades = []; let pos = null;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].t < from || bars[i].t >= to) { if (bars[i].t >= to) break; continue; }
    const d = decideStep({ bars, i, position: pos, params });
    if (d.action === 'open') pos = { dir: d.dir, entry: d.entry, initialStop: d.initialStop, atrAtEntry: d.atrAtEntry, hwm: d.entry, lwm: d.entry };
    else if (d.action === 'hold' && pos) { pos.hwm = d.hwm; pos.lwm = d.lwm; }
    else if (d.action === 'close' && pos) { trades.push({ t: bars[i].t, netR: tradeNetR({ dir: pos.dir, entry: pos.entry, exit: d.exit, atrAtEntry: pos.atrAtEntry, params }).netR }); pos = null; }
  }
  return trades;
}

const SERIES = readdirSync(FIX).filter(f => /-1095d-Min60\.json$/.test(f))
  .map(f => to4h(JSON.parse(readFileSync(path.join(FIX, f), 'utf8'))));
if (!SERIES.length) { console.error('No -1095d-Min60 fixtures (run dump-fixtures --interval=Min60 --days=1095)'); process.exit(1); }

function pooled(params, from, to) {
  let all = [];
  for (const bars of SERIES) all = all.concat(replay(bars, params, from, to));
  return all.sort((a, b) => a.t - b.t);
}
function metrics(trades) {
  if (!trades.length) return { n: 0, win: 0, avgR: 0, eqMul: 1, maxDD: 0 };
  let eq = 1, peak = 1, maxDD = 0, wins = 0, sumR = 0;
  for (const t of trades) { eq *= (1 + RISK * t.netR); if (eq > peak) peak = eq; const dd = (peak - eq) / peak; if (dd > maxDD) maxDD = dd; if (t.netR > 0) wins++; sumR += t.netR; }
  return { n: trades.length, win: wins / trades.length * 100, avgR: sumR / trades.length, eqMul: eq, maxDD: maxDD * 100 };
}
const now = Math.max(...SERIES.map(s => s[s.length - 1].t));
const win = (params, days) => metrics(pooled(params, now - days * 86400 * 1000, Infinity));
const fmt = (m, days) => `n=${String(m.n).padEnd(4)} win=${m.win.toFixed(0)}% avgR=${m.avgR.toFixed(3)} $200→$${(200 * m.eqMul).toFixed(0)} (${((m.eqMul - 1) / (days / 30) * 100).toFixed(1)}%/mo) DD=${m.maxDD.toFixed(0)}%`;

if (process.argv.includes('--wf')) {
  // Anchored walk-forward over the pooled timeline: pick erMin on past, test next fold OOS.
  const ERS = [0, 0.2, 0.25, 0.3, 0.35, 0.4];
  const span = now - Math.min(...SERIES.map(s => s[0].t));
  const FOLDS = 6, foldMs = span / FOLDS, t0 = now - span;
  let os = [];
  for (let k = 1; k < FOLDS; k++) {
    const trainTo = t0 + k * foldMs, testTo = t0 + (k + 1) * foldMs;
    let best = null;
    for (const er of ERS) { const m = metrics(pooled({ ...STRATEGY_PARAMS, erMin: er }, 0, trainTo)); if (m.n >= 50 && (!best || m.avgR > best.avgR)) best = { er, ...m }; }
    const foldOs = pooled({ ...STRATEGY_PARAMS, erMin: best.er }, trainTo, testTo);
    os = os.concat(foldOs);
    console.log(`fold ${k}: erMin=${best.er} (IS avgR=${best.avgR.toFixed(3)}) | OS ${fmt(metrics(foldOs), foldMs / 86400000)}`);
  }
  console.log(`\n=== OUT-OF-SAMPLE with regime gate (honest) === ${fmt(metrics(os.sort((a, b) => a.t - b.t)), span / 86400000 * (FOLDS - 1) / FOLDS)}`);
} else {
  console.log('erMin sweep · 4h trend-trail · 0.5% risk · real fees+slip · decideStep replay\n');
  for (const er of [0, 0.2, 0.25, 0.30, 0.35, 0.40]) {
    const p = { ...STRATEGY_PARAMS, erMin: er };
    console.log(`erMin=${er.toFixed(2)}`);
    console.log(`  last 90d : ${fmt(win(p, 90), 90)}`);
    console.log(`  last 365d: ${fmt(win(p, 365), 365)}`);
    console.log(`  full 3yr : ${fmt(win(p, 1100), 1100)}`);
  }
}
