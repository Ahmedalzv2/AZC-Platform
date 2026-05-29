// Paper-forward harness for the validated 4h trend-trail strategy
// (strategy-trend-trail.mjs). Forward-tests the +0.061R backtest edge on LIVE
// MEXC prices WITHOUT placing orders or authenticating — pure simulation, so
// it's safe to run alongside the (paused) live trader. Compares realized
// forward net-R against the backtest expectation before any capital.
//
// Run once (cron/systemd every ~1h):  node paper-trader.mjs
// Continuous:                          node paper-trader.mjs --loop=3600
//
// State: .paper-state/state.json + paper-trades.jsonl journal. Reads only the
// public contract kline endpoint. No MEXC keys, no order submission, ever.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRATEGY_PARAMS, decideStep, tradeNetR } from './strategy-trend-trail.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '.paper-state');
const STATE = path.join(DIR, 'state.json');
const JOURNAL = path.join(DIR, 'paper-trades.jsonl');
const SYMBOLS = ['AAVE', 'ADA', 'ALGO', 'APT', 'ARB', 'ATOM', 'AVAX', 'BCH', 'BNB', 'BTC', 'DOGE', 'DOT', 'ETC', 'ETH', 'ICP', 'LINK', 'LTC', 'NEAR', 'RUNE', 'SOL', 'SUI', 'TRX', 'UNI', 'XRP'];
const MAX_POSITIONS = STRATEGY_PARAMS.maxPositions;  // portfolio cap on concurrent positions
const FOUR_H = 4 * 3600 * 1000;
const BANKROLL0 = 200;

const log = (...a) => console.log(new Date().toISOString(), '·', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchKlines1h(sym, days = 20) {
  const end = Math.floor(Date.now() / 1000), start = end - days * 86400;
  const url = `https://contract.mexc.com/api/v1/contract/kline/${sym}_USDT?interval=Min60&start=${start}&end=${end}`;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      const j = await r.json();
      const d = j?.data;
      if (d?.time?.length) return d.time.map((t, i) => ({ t: t * 1000, o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i] }));
    } catch { await sleep(400); }
  }
  return [];
}

// UTC-aligned 4h candles from 1h bars. Only CLOSED buckets (bucket end <= now).
function to4hClosed(bars1h, now) {
  const buckets = new Map();
  for (const b of bars1h) {
    const k = Math.floor(b.t / FOUR_H) * FOUR_H;
    const e = buckets.get(k);
    if (!e) buckets.set(k, { t: k, o: b.o, h: b.h, l: b.l, c: b.c });
    else { e.h = Math.max(e.h, b.h); e.l = Math.min(e.l, b.l); e.c = b.c; }
  }
  return [...buckets.values()].filter(b => b.t + FOUR_H <= now).sort((a, b) => a.t - b.t);
}

function loadState() {
  if (existsSync(STATE)) { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch {} }
  return { positions: {}, lastBarTs: {}, stats: { n: 0, wins: 0, totalR: 0, equityUsd: BANKROLL0, grossEquityUsd: BANKROLL0 } };
}

function recordTrade(state, sym, pos, exit, closedTs) {
  const { netR, grossR } = tradeNetR({ dir: pos.dir, entry: pos.entry, exit, atrAtEntry: pos.atrAtEntry });
  const r = STRATEGY_PARAMS.riskPct;
  const pnlUsd = state.stats.equityUsd * r * netR;
  const grossUsd = state.stats.grossEquityUsd * r * grossR;
  state.stats.equityUsd += pnlUsd;
  state.stats.grossEquityUsd += grossUsd;
  state.stats.n += 1;
  if (netR > 0) state.stats.wins += 1;
  state.stats.totalR += netR;
  const rec = { ts: closedTs, sym, dir: pos.dir, entry: pos.entry, exit, openedTs: pos.openedTs, grossR: +grossR.toFixed(3), netR: +netR.toFixed(3), grossUsd: +grossUsd.toFixed(3), pnlUsd: +pnlUsd.toFixed(3), grossEquityUsd: +state.stats.grossEquityUsd.toFixed(2), equityUsd: +state.stats.equityUsd.toFixed(2) };
  appendFileSync(JOURNAL, JSON.stringify(rec) + '\n');
  log(`[paper-close] ${sym} ${pos.dir} netR=${netR.toFixed(2)} grossR=${grossR.toFixed(2)} | net=$${state.stats.equityUsd.toFixed(2)} gross=$${state.stats.grossEquityUsd.toFixed(2)}`);
}

async function runOnce() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const state = loadState();
  const now = Date.now();
  for (const sym of SYMBOLS) {
    const bars1h = await fetchKlines1h(sym);
    if (bars1h.length < 200) { log(`[skip] ${sym} thin data (${bars1h.length})`); continue; }
    const bars = to4hClosed(bars1h, now);
    if (bars.length < STRATEGY_PARAMS.don + STRATEGY_PARAMS.atrN + 2) continue;
    const last = state.lastBarTs[sym] || 0;
    let startIdx = bars.findIndex(b => b.t > last);
    if (startIdx < 0) startIdx = bars.length;           // nothing new
    // On first run, seed at the most recent bar only (don't replay history as
    // paper fills — forward test starts now).
    if (!state.lastBarTs[sym]) startIdx = bars.length - 1;
    for (let i = Math.max(startIdx, STRATEGY_PARAMS.don + STRATEGY_PARAMS.atrN + 1); i < bars.length; i++) {
      const pos = state.positions[sym] || null;
      const d = decideStep({ bars, i, position: pos });
      if (d.action === 'open') {
        const openCount = Object.values(state.positions).filter(Boolean).length;
        if (openCount >= MAX_POSITIONS) {
          log(`[paper-skip-cap] ${sym} ${d.dir} — ${openCount}/${MAX_POSITIONS} positions open`);
        } else {
          state.positions[sym] = { dir: d.dir, entry: d.entry, initialStop: d.initialStop, atrAtEntry: d.atrAtEntry, hwm: d.entry, lwm: d.entry, openedTs: bars[i].t };
          log(`[paper-open] ${sym} ${d.dir} entry=${d.entry} stop=${d.initialStop.toFixed(6)} (${openCount + 1}/${MAX_POSITIONS})`);
        }
      } else if (d.action === 'hold' && pos) {
        pos.hwm = d.hwm; pos.lwm = d.lwm; pos.stop = d.stop;
      } else if (d.action === 'close' && pos) {
        recordTrade(state, sym, pos, d.exit, bars[i].t);
        state.positions[sym] = null;
      }
      state.lastBarTs[sym] = bars[i].t;
    }
  }
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  const s = state.stats;
  const open = Object.entries(state.positions).filter(([, p]) => p).map(([k]) => k);
  log(`[paper-stats] trades=${s.n} win=${s.n ? (s.wins / s.n * 100).toFixed(0) : 0}% | NET=$${s.equityUsd.toFixed(2)} GROSS=$${(s.grossEquityUsd ?? BANKROLL0).toFixed(2)} (start $${BANKROLL0}) | open=${open.length}/${MAX_POSITIONS} [${open.join(',')}]`);
  return state;
}

const loopArg = process.argv.find(a => a.startsWith('--loop='));
if (loopArg) {
  const sec = Math.max(300, Number(loopArg.split('=')[1]) || 3600);
  log(`[paper] loop every ${sec}s · ${SYMBOLS.length} symbols · 4h trend-trail · NO real orders`);
  for (;;) { try { await runOnce(); } catch (e) { log('[paper-err]', e.message); } await sleep(sec * 1000); }
} else {
  await runOnce();
}
