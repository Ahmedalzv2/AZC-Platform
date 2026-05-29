// Mean-reversion (fade Donchian extremes) backtest with realistic MEXC fees
// and ANCHORED WALK-FORWARD validation. RESEARCH tooling — not wired to the
// live trader. The 5m FVG trend-scalp is net-negative after fees; the screen
// in PR #268/#269 showed fading 4h extremes is the only direction that turned
// net-positive in-sample. This validates whether that survives out-of-sample.
//
// Fee model (per leg): entry is a resting limit at the band → maker; TP is a
// resting limit at the mean → maker; SL is a stop → taker. MEXC charges
// ~0.075% taker on the live tape (maker is free on SOL/XRP). Flags let you
// stress all-taker. No lookahead: signal on bar i (close beyond band), enter
// at bar i+1 open, resolve from i+1; same-bar stop+tp tie breaks to STOP
// (pessimistic).
//
// Usage:
//   node tests/backtest-meanrev.mjs                 # walk-forward, realistic fees
//   node tests/backtest-meanrev.mjs --all-taker     # conservative (both legs taker)
//   node tests/backtest-meanrev.mjs --is            # single in-sample fit (no WF)

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures');
const TAKER = 0.00075;       // observed MEXC taker on the live tape
const BARS_PER = 48;         // 5m -> 4h
const ATR_N = 14;

// ── pure helpers (unit-tested in backtest-meanrev.test.mjs) ──────────────
export function resample(bars, per = BARS_PER) {
  const out = [];
  for (let i = 0; i + per <= bars.length; i += per) {
    const s = bars.slice(i, i + per);
    out.push({
      t: s[0].t, o: s[0].o,
      h: Math.max(...s.map(x => x.h)),
      l: Math.min(...s.map(x => x.l)),
      c: s[s.length - 1].c,
    });
  }
  return out;
}

export function atr(bars, i, n = ATR_N) {
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) {
    s += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
  }
  return s / n;
}

// Simulate the fade strategy over [from,to) of `bars`. Returns trade list with
// netR. takerRate applies to non-maker legs.
export function simulateMeanRev(bars, p, from = ATR_N + 1, to = bars.length) {
  const { don, atrMult, rr, makerEntry = true, makerTp = true, takerRate = TAKER, slipBps = 0 } = p;
  const slip = slipBps / 10000; // adverse slippage applied to taker fills
  const trades = [];
  let i = Math.max(from, don + 1, ATR_N + 1);
  while (i < to - 1) {
    const b = bars[i];
    const hh = Math.max(...bars.slice(i - don, i).map(x => x.h));
    const ll = Math.min(...bars.slice(i - don, i).map(x => x.l));
    const a = atr(bars, i);
    let dir = null;
    if (b.c > hh) dir = 'short';      // fade the upside extreme
    else if (b.c < ll) dir = 'long';  // fade the downside extreme
    if (dir && a > 0 && i + 1 < to) {
      const entry = bars[i + 1].o;    // next-open entry, no lookahead
      const risk = atrMult * a;
      const stop = dir === 'long' ? entry - risk : entry + risk;
      const tp = dir === 'long' ? entry + rr * risk : entry - rr * risk;
      let exitIdx = -1, exitPx = null, win = false;
      for (let j = i + 1; j < to; j++) {
        const x = bars[j];
        const hitStop = dir === 'long' ? x.l <= stop : x.h >= stop;
        const hitTp = dir === 'long' ? x.h >= tp : x.l <= tp;
        if (hitStop) { exitPx = stop; win = false; exitIdx = j; break; }   // stop first on ties
        if (hitTp) { exitPx = tp; win = true; exitIdx = j; break; }
      }
      if (exitIdx >= 0) {
        // Adverse slippage hits TAKER legs only. Stop exits are always taker
        // (market on trigger) and slip the worst — the realistic failure mode.
        // Maker entry / maker TP fill at their resting price (no slip).
        const sgn = dir === 'long' ? 1 : -1;
        const entryFill = makerEntry ? entry : entry * (1 + sgn * slip);     // buy higher / sell lower
        const exitFill = win
          ? (makerTp ? exitPx : exitPx * (1 - sgn * slip))                   // TP: sell lower / buy higher if taker
          : exitPx * (1 - sgn * slip);                                       // STOP (taker): always adverse
        const move = dir === 'long' ? exitFill - entryFill : entryFill - exitFill;
        const grossR = move / risk;
        const entryFee = makerEntry ? 0 : takerRate;
        const exitFee = win ? (makerTp ? 0 : takerRate) : takerRate;          // SL always taker
        const feeR = (entry * (entryFee + exitFee)) / risk;
        trades.push({ ts: b.t, dir, grossR, netR: grossR - feeR, win });
        i = exitIdx;
      }
    }
    i++;
  }
  return trades;
}

export function metrics(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winPct: 0, netR: 0, totalR: 0, maxDD: 0 };
  let eq = 0, peak = 0, maxDD = 0, wins = 0, totalR = 0;
  for (const t of trades) {
    totalR += t.netR; eq += t.netR;
    if (eq > peak) peak = eq;
    if (peak - eq > maxDD) maxDD = peak - eq;
    if (t.win) wins++;
  }
  return { n, winPct: wins / n * 100, netR: totalR / n, totalR, maxDD };
}

// ── walk-forward runner ──────────────────────────────────────────────────
function loadSymbol(file) {
  const raw = JSON.parse(readFileSync(path.join(FIX, file), 'utf8'));
  return resample(raw.map(r => ({ t: r.t ?? r[0], o: +(r.o ?? r[1]), h: +(r.h ?? r[2]), l: +(r.l ?? r[3]), c: +(r.c ?? r[4]) })));
}

const GRID = [];
for (const don of [20, 30]) for (const atrMult of [2, 2.5]) for (const rr of [1.0, 1.2]) GRID.push({ don, atrMult, rr });

function main() {
  const args = process.argv.slice(2);
  const allTaker = args.includes('--all-taker');
  const isOnly = args.includes('--is');
  const slipBps = Number((args.find(a => a.startsWith('--slip=')) || '--slip=0').split('=')[1]) || 0;
  const feeOpts = { ...(allTaker ? { makerEntry: false, makerTp: false } : { makerEntry: true, makerTp: true }), slipBps };

  const symbols = readdirSync(FIX).filter(f => /-365d-Min5\.json$/.test(f)).map(f => ({ sym: f.split('-')[0], bars: loadSymbol(f) }));
  const FOLDS = 5;

  // Score a param set across all symbols over a [fracFrom,fracTo) slice.
  const scoreParams = (p, fracFrom, fracTo) => {
    let all = [];
    for (const { bars } of symbols) {
      const from = Math.floor(bars.length * fracFrom), to = Math.floor(bars.length * fracTo);
      all = all.concat(simulateMeanRev(bars, { ...p, ...feeOpts }, Math.max(from, ATR_N + 1), to));
    }
    return { trades: all, ...metrics(all) };
  };

  console.log(`MEAN-REVERSION walk-forward · 4h · fees=${allTaker ? 'ALL-TAKER (conservative)' : 'maker entry+TP, taker SL (realistic)'} · taker=${TAKER} · slip=${slipBps}bps`);
  console.log(`grid: ${GRID.length} param sets · ${symbols.length} symbols · ${FOLDS} folds (anchored expanding)\n`);

  if (isOnly) {
    // Pure in-sample fit on the full period — the OPTIMISTIC (overfit-prone) number.
    let best = null;
    for (const p of GRID) { const m = scoreParams(p, 0, 1); if (m.n >= 200 && (!best || m.netR > best.netR)) best = { p, ...m }; }
    console.log('IN-SAMPLE best:', JSON.stringify(best.p), `netR=${best.netR.toFixed(3)} win=${best.winPct.toFixed(1)}% n=${best.n} maxDD=${best.maxDD.toFixed(1)}R`);
    return;
  }

  // Anchored walk-forward: train on [0..k], pick best params, test on fold k+1.
  const osTrades = [];
  const chosen = [];
  for (let k = 1; k < FOLDS; k++) {
    const trainTo = k / FOLDS, testFrom = k / FOLDS, testTo = (k + 1) / FOLDS;
    let best = null;
    for (const p of GRID) {
      const m = scoreParams(p, 0, trainTo);
      if (m.n >= 80 && (!best || m.netR > best.netR)) best = { p, ...m };
    }
    if (!best) continue;
    // Apply chosen params to the unseen test fold.
    let foldOs = [];
    for (const { bars } of symbols) {
      const from = Math.floor(bars.length * testFrom), to = Math.floor(bars.length * testTo);
      foldOs = foldOs.concat(simulateMeanRev(bars, { ...best.p, ...feeOpts }, Math.max(from, ATR_N + 1), to));
    }
    const om = metrics(foldOs);
    chosen.push({ fold: k, p: best.p, isNetR: best.netR, os: om });
    osTrades.push(...foldOs);
    console.log(`fold ${k}: train→ ${JSON.stringify(best.p)} (IS netR=${best.netR.toFixed(3)}) | OS netR=${om.netR.toFixed(3)} win=${om.winPct.toFixed(1)}% n=${om.n}`);
  }

  const os = metrics(osTrades);
  console.log(`\n=== OUT-OF-SAMPLE (pooled across folds — the honest number) ===`);
  console.log(`netR/trade=${os.netR.toFixed(3)}  win=${os.winPct.toFixed(1)}%  trades=${os.n}  totalR=${os.totalR.toFixed(1)}  maxDD=${os.maxDD.toFixed(1)}R`);
  // Per-symbol OS breadth, using each fold's chosen params.
  console.log(`\nper-symbol OS:`);
  for (const { sym, bars } of symbols) {
    let st = [];
    for (const c of chosen) {
      const from = Math.floor(bars.length * (c.fold / FOLDS)), to = Math.floor(bars.length * ((c.fold + 1) / FOLDS));
      st = st.concat(simulateMeanRev(bars, { ...c.p, ...feeOpts }, Math.max(from, ATR_N + 1), to));
    }
    const m = metrics(st);
    console.log(`  ${sym.padEnd(5)} n=${String(m.n).padEnd(4)} win=${m.winPct.toFixed(0).padStart(3)}%  netR=${m.netR.toFixed(3)}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('backtest-meanrev.mjs')) main();
