// Trend+trail shadow lane (4h Donchian breakout + chandelier trail) — the lane
// that beat mean-rev on the matched 5y/all-taker test. Runs DRY alongside the
// mean-rev shadow so the deployment gate compares LIVE signal cadence, fill
// realism, regime behaviour, and modeled fee drag — not more backtests.
//
// Shadow-only by construction: it opens nothing on the exchange, simulating the
// position lifecycle in-memory from the SAME decideStep the backtest validated.
// Public klines only — no private creds, nothing to arm. Live execution is a
// separate, gated step; TREND_LIVE is read only to tag records, not to trade.
//
// Signals → trade-learnings/shadow/trend-signals.jsonl, health → .trend-state.
import { decideStep, tradeNetR, STRATEGY_PARAMS } from './strategy-trend-trail.mjs';
import { resampleTo4h } from './strategy-meanrev.mjs';
import { trendSignalRecord, buildTrendHealth } from './trend-shadow.mjs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, appendFile, writeFile, rename } from 'node:fs/promises';

const DRY_RUN = process.env.TREND_LIVE !== '1';   // tag only; this lane never trades
const BASKET = (process.env.TREND_BASKET || 'DOGE,SOL,XRP').split(',').map(s => `${s}_USDT`);
const CYCLE_MS = Number(process.env.TREND_CYCLE_MS || 60_000);
const COOLDOWN_MS = Number(process.env.TREND_COOLDOWN_MS || 0);   // backtest re-enters on next breakout
const STATE_DIR = path.resolve('./.trend-state');
const STOP_FLAG = path.join(STATE_DIR, 'stop.flag');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const SHADOW_DIR = path.resolve('./trade-learnings/shadow');
const SHADOW_LOG = path.join(SHADOW_DIR, 'trend-signals.jsonl');
const MIN_BARS = Math.max(STRATEGY_PARAMS.don, STRATEGY_PARAMS.atrN) + 2;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), '·', ...a);
const pub = (u) => fetch(u, { signal: AbortSignal.timeout(8000) }).then(r => r.json());

async function bars4h(symbol) {
  // Same construction as the live mean-rev lane so both shadows see one tape.
  const j = await pub(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Min60&limit=320`);
  const d = j?.data || {};
  if (!Array.isArray(d.time)) return [];
  let m60 = d.time.map((t, i) => ({ t: t * 1000, o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i] }));
  m60 = m60.slice(0, -1);                                                        // drop in-progress hour
  while (m60.length && new Date(m60[0].t).getUTCHours() % 4 !== 0) m60.shift();   // align to UTC 4h
  return resampleTo4h(m60, 4);
}

const positions = new Map();     // symbol -> { dir, entry, initialStop, atrAtEntry, hwm, lwm, lastBarTs }
const cooldownUntil = new Map(); // symbol -> ts
const actedBar = new Map();      // symbol -> last 4h bar ts a flat/entry decision was logged for
let cycleCount = 0;

async function recordShadow(rec) {
  if (!rec) return;
  try {
    await mkdir(SHADOW_DIR, { recursive: true });
    await appendFile(SHADOW_LOG, JSON.stringify(rec) + '\n');
  } catch (e) { log(`shadow-record err ${e.message}`); }
}

async function writeHealth(killed) {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    const health = buildTrendHealth({
      now: Date.now(), cycleCount, dryRun: DRY_RUN, killed, basket: BASKET,
      positions: [...positions.keys()], cooldowns: Object.fromEntries(cooldownUntil),
    });
    const tmp = `${STATE_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(health));
    await rename(tmp, STATE_FILE);
  } catch (e) { log(`health-write err ${e.message}`); }
}

async function stepSymbol(symbol) {
  if (Date.now() < (cooldownUntil.get(symbol) || 0)) return;
  const bars = await bars4h(symbol);
  if (bars.length < MIN_BARS) return;
  const i = bars.length - 1;
  const barTs = bars[i].t;
  const pos = positions.get(symbol) || null;

  if (pos) {
    if (barTs <= pos.lastBarTs) return;                       // no new closed bar to trail against
    const d = decideStep({ bars, i, position: pos, params: STRATEGY_PARAMS });
    if (d.action === 'close') {
      const { netR } = tradeNetR({ dir: pos.dir, entry: pos.entry, exit: d.exit, atrAtEntry: pos.atrAtEntry, params: STRATEGY_PARAMS });
      positions.delete(symbol);
      if (COOLDOWN_MS) cooldownUntil.set(symbol, Date.now() + COOLDOWN_MS);
      await recordShadow(trendSignalRecord({ now: Date.now(), d, barTs, symbol, dryRun: DRY_RUN, netR }));
      log(`${symbol}: 🔚 ${pos.dir} exit=${d.exit} (${d.win ? 'WIN' : 'LOSS'}) netR=${netR.toFixed(3)}`);
    } else if (d.action === 'hold') {
      pos.hwm = d.hwm; pos.lwm = d.lwm; pos.lastBarTs = barTs;
    }
    return;
  }

  if (actedBar.get(symbol) === barTs) return;                 // one entry decision per 4h bar
  const d = decideStep({ bars, i, position: null, params: STRATEGY_PARAMS });
  if (d.action === 'open') {
    positions.set(symbol, { dir: d.dir, entry: d.entry, initialStop: d.initialStop, atrAtEntry: d.atrAtEntry, hwm: d.entry, lwm: d.entry, lastBarTs: barTs });
    actedBar.set(symbol, barTs);
    await recordShadow(trendSignalRecord({ now: Date.now(), d, barTs, symbol, dryRun: DRY_RUN }));
    log(`${symbol}: 🟢 [SHADOW] would OPEN ${d.dir} entry=${d.entry} stop=${d.initialStop.toFixed(6)}`);
  } else if (d.action === 'flat' && d.regime === 'chop') {
    actedBar.set(symbol, barTs);
    await recordShadow(trendSignalRecord({ now: Date.now(), d, barTs, symbol, dryRun: DRY_RUN }));
  }
}

async function cycle() {
  cycleCount += 1;
  const killed = existsSync(STOP_FLAG);
  if (killed) { log('stop.flag present — monitoring only, no new entries'); await writeHealth(true); return; }
  for (const symbol of BASKET) {
    try { await stepSymbol(symbol); } catch (e) { log(`${symbol}: cycle error ${e.message}`); }
  }
  await writeHealth(false);
}

async function main() {
  log(`trend-trail shadow up · ${DRY_RUN ? 'DRY-RUN (no orders)' : 'TREND_LIVE tag set (still shadow — no live path)'} · basket=${BASKET.join(',')} · gate erMin=${STRATEGY_PARAMS.erMin} · cycle=${CYCLE_MS / 1000}s`);
  if (process.env.TREND_ONCE === '1') { await cycle(); log('single cycle done'); return; }
  for (;;) { try { await cycle(); } catch (e) { log('cycle FATAL', e.message); } await sleep(CYCLE_MS); }
}
main();
