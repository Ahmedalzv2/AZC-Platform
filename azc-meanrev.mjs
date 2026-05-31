// Mean-reversion live executor (fade 4h Donchian extremes) — the fee-surviving
// lane. On each closed 4h bar, scans the basket; on a signal places a POST_ONLY
// maker entry carrying a taker stop, then a resting maker-limit TP after fill
// (the fee model the probe proved: maker fills ~0.04%, taker stop only on
// losers). One position per symbol, per-symbol cooldown, stop.flag kill switch,
// audit log to trade-learnings via the relay.
//
// SAFETY: DRY_RUN defaults ON — logs intents, places NOTHING. Arm live ONLY
// with MEANREV_LIVE=1. Risk 1%/trade, isolated, minimum size.
//
// MEXC sides: 1=open long, 3=open short, 4=close long, 2=close short.
import { callMexcSigned } from './mexc-signer.mjs';
import { planMeanRevTrade, resampleTo4h, MR_PARAMS } from './strategy-meanrev.mjs';
import { shadowSignalRecord, buildMeanRevHealth } from './meanrev-shadow.mjs';
import { sentimentShadow } from './trader-sentiment.mjs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, appendFile, writeFile, rename } from 'node:fs/promises';

const API_KEY = process.env.MEXC_API_KEY, API_SECRET = process.env.MEXC_API_SECRET;
const DRY_RUN = process.env.MEANREV_LIVE !== '1';
const BASKET = (process.env.MEANREV_BASKET || 'LTC,ADA,DOGE,SOL,XRP').split(',').map(s => `${s}_USDT`);
const RISK_PCT = Number(process.env.MEANREV_RISK || 0.01);
const LEVERAGE = Number(process.env.MEANREV_LEV || 10);
const CYCLE_MS = Number(process.env.MEANREV_CYCLE_MS || 60_000);
const ENTRY_TTL_MS = Number(process.env.MEANREV_ENTRY_TTL_MS || 15 * 60_000);
const COOLDOWN_MS = Number(process.env.MEANREV_COOLDOWN_MS || 4 * 3600_000);  // 1 bar
const STATE_DIR = path.resolve('./.meanrev-state');
const STOP_FLAG = path.join(STATE_DIR, 'stop.flag');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const SHADOW_DIR = path.resolve('./trade-learnings/shadow');
const SHADOW_LOG = path.join(SHADOW_DIR, 'meanrev-signals.jsonl');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), '·', ...a);

const sg = (o) => callMexcSigned({ apiKey: API_KEY, apiSecret: API_SECRET, ...o })
  .then(r => { try { return { ...r, json: JSON.parse(r.body) }; } catch { return { ...r, json: null }; } });
const pub = async (u, tries = 2) => {
  // MEXC public API is flaky; one slow response shouldn't blank a whole 4h bar
  for (let i = 0; ; i++) {
    try { return await fetch(u, { signal: AbortSignal.timeout(15000) }).then(r => r.json()); }
    catch (e) { if (i >= tries - 1) throw e; await sleep(1500); }
  }
};
const placeOrder = (body) => sg({ path: '/api/v1/private/order/submit', method: 'POST', body });
const cancelOrder = (id) => sg({ path: '/api/v1/private/order/cancel', method: 'POST', body: [String(id)] });

async function bars4h(symbol) {
  const j = await pub(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Min60&limit=320`);
  const d = j?.data || {};
  if (!Array.isArray(d.time)) return [];
  let m60 = d.time.map((t, i) => ({ t: t * 1000, o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i] }));
  m60 = m60.slice(0, -1);                                              // drop in-progress hour
  while (m60.length && new Date(m60[0].t).getUTCHours() % 4 !== 0) m60.shift();   // align to UTC 4h
  return resampleTo4h(m60, 4);
}
const ticker = (s) => pub(`https://contract.mexc.com/api/v1/contract/ticker?symbol=${s}`).then(j => j?.data);
const meta = (s) => pub(`https://contract.mexc.com/api/v1/contract/detail?symbol=${s}`).then(j => j?.data);
async function balance() { const a = await sg({ path: '/api/v1/private/account/assets', method: 'GET' }); return +((a.json?.data || []).find(x => x.currency === 'USDT')?.availableBalance) || 0; }
async function openPositions() { const r = await sg({ path: '/api/v1/private/position/open_positions', method: 'GET' }); return (r.json?.data || []).filter(p => +p.holdVol > 0); }
const snapper = (pu) => { const d = (String(pu).split('.')[1] || '').length; return v => Number((Math.round(v / pu) * pu).toFixed(d)); };

// In-memory lifecycle state (reconciles from exchange on boot/cycle).
const pending = new Map();      // symbol -> { orderId, plan, snap, expiresAt }
const positions = new Map();    // symbol -> { posId, plan, tpOrderId, snap }
const cooldownUntil = new Map();// symbol -> ts
const actedBar = new Map();     // symbol -> last 4h bar ts acted on
let cycleCount = 0;

async function writeHealth(killed) {
  // Atomic state.json each cycle so a relay endpoint can show liveness/mode
  // without journal-diving. Best-effort — never break the loop over it.
  try {
    await mkdir(STATE_DIR, { recursive: true });
    const health = buildMeanRevHealth({
      now: Date.now(), cycleCount, dryRun: DRY_RUN, killed, basket: BASKET,
      pending: [...pending.keys()], positions: [...positions.keys()],
      cooldowns: Object.fromEntries(cooldownUntil),
    });
    const tmp = `${STATE_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(health));
    await rename(tmp, STATE_FILE);
  } catch (e) { log(`health-write err ${e.message}`); }
}

async function recordShadow(plan, barTs, sentiment) {
  // Every decision (armed entry or skip) becomes one JSONL line so a shadow
  // run is reviewable instead of stdout-only. Best-effort — never break the
  // cycle over an audit write.
  try {
    await mkdir(SHADOW_DIR, { recursive: true });
    const rec = shadowSignalRecord({ now: Date.now(), plan, barTs, dryRun: DRY_RUN, sentiment });
    await appendFile(SHADOW_LOG, JSON.stringify(rec) + '\n');
  } catch (e) { log(`shadow-record err ${e.message}`); }
}

async function notifyLearn(plan, fillPx, exitPx, outcome) {
  // Best-effort audit to the relay's learnings; never throw into the loop.
  try {
    await fetch('https://tv-relay.srv1688368.hstgr.cloud/learn-trade', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(6000),
      body: JSON.stringify({ symbol: plan.symbol, side: plan.dir, lane: 'mexc-meanrev', entry: fillPx, exit: exitPx, sl: plan.stop, tp: plan.tp, outcome, strategy: 'meanrev-4h-fade' }),
    });
  } catch { /* relay down — skip */ }
}

async function placeEntry(plan, m) {
  const snap = snapper(m.priceUnit);
  if (DRY_RUN) { log(`${plan.symbol}: [DRY] would OPEN ${plan.dir} qty=${plan.qty} entry=${plan.entry} stop=${plan.stop} tp=${plan.tp}`); return; }
  const r = await placeOrder({ symbol: plan.symbol, price: plan.entry, vol: plan.qty, leverage: LEVERAGE, side: plan.sideOpen, type: 2, openType: 1, stopLossPrice: plan.stop });
  if (r.json?.success !== true) { log(`${plan.symbol}: entry REJECTED ${JSON.stringify(r.json || {}).slice(0, 120)}`); return; }
  pending.set(plan.symbol, { orderId: r.json.data, plan, snap, expiresAt: Date.now() + ENTRY_TTL_MS });
  log(`${plan.symbol}: 🟢 entry placed (maker) order=${r.json.data} ${plan.dir} qty=${plan.qty} @${plan.entry} stop=${plan.stop}`);
}

async function monitorPending(live) {
  for (const [symbol, pend] of pending) {
    const pos = live.find(p => p.symbol === symbol);
    if (pos) {                                  // filled → attach resting maker TP
      pending.delete(symbol);
      const { plan, snap } = pend;
      let tpOrderId = null;
      if (!DRY_RUN) {
        const tp = await placeOrder({ symbol, price: snap(plan.tp), vol: +pos.holdVol, leverage: LEVERAGE, side: plan.sideClose, type: 2, openType: 1 });
        tpOrderId = tp.json?.success === true ? tp.json.data : null;
        if (!tpOrderId) log(`${symbol}: ⚠️ maker-TP not placed ${JSON.stringify(tp.json || {}).slice(0, 100)} — exits via stop only`);
      }
      positions.set(symbol, { posId: pos.positionId, plan, tpOrderId, snap });
      log(`${symbol}: ✅ filled pos=${pos.positionId} @${pos.holdAvgPrice} — TP order=${tpOrderId}`);
    } else if (Date.now() > pend.expiresAt) {   // unfilled TTL → cancel (missed signal)
      pending.delete(symbol);
      if (!DRY_RUN) await cancelOrder(pend.orderId);
      log(`${symbol}: entry ${pend.orderId} TTL-expired unfilled — cancelled`);
    }
  }
}

async function reconcileClosed(live) {
  for (const [symbol, p] of positions) {
    if (live.find(x => String(x.positionId) === String(p.posId))) continue;  // still open
    positions.delete(symbol);
    cooldownUntil.set(symbol, Date.now() + COOLDOWN_MS);
    if (!DRY_RUN && p.tpOrderId) { try { await cancelOrder(p.tpOrderId); } catch { /* already gone */ } }
    // Read the close fill for the learning record.
    let exitPx = null, fillPx = p.plan.entry;
    try {
      const h = await sg({ path: '/api/v1/private/order/list/history_orders', method: 'GET', params: { symbol, page_num: 1, page_size: 20 } });
      const os = (h.json?.data || []).filter(o => o.state === 3);
      const close = os.find(o => o.side === p.plan.sideClose);
      const open = os.find(o => o.side === p.plan.sideOpen);
      if (close) exitPx = +close.dealAvgPrice;
      if (open) fillPx = +open.dealAvgPrice;
    } catch { /* keep nulls */ }
    const won = exitPx != null && (p.plan.dir === 'long' ? exitPx > fillPx : exitPx < fillPx);
    log(`${symbol}: 🔚 closed exit=${exitPx} (${won ? 'WIN' : 'LOSS'}) — cooldown ${(COOLDOWN_MS / 3600000).toFixed(0)}h`);
    await notifyLearn(p.plan, fillPx, exitPx, won ? 'win' : 'loss');
  }
}

async function cycle() {
  cycleCount += 1;
  const killed = existsSync(STOP_FLAG);
  const live = await openPositions();
  await monitorPending(live);
  await reconcileClosed(live);
  if (killed) { log('stop.flag present — monitoring only, no new entries'); await writeHealth(true); return; }
  const bal = await balance();
  const held = new Set(live.map(p => p.symbol));
  for (const symbol of BASKET) {
    if (held.has(symbol) || positions.has(symbol) || pending.has(symbol)) continue;
    if (Date.now() < (cooldownUntil.get(symbol) || 0)) continue;
    try {
      const [bars, tk, m] = await Promise.all([bars4h(symbol), ticker(symbol), meta(symbol)]);
      // MEXC ticker/detail flap returns no data -> skip this symbol, don't kill the cycle
      if (!tk?.lastPrice || !m?.priceUnit) continue;
      if (bars.length < MR_PARAMS.don + MR_PARAMS.atrN + 2) continue;
      const barTs = bars[bars.length - 1].t;
      if (actedBar.get(symbol) === barTs) continue;            // one decision per 4h bar
      const plan = planMeanRevTrade({ symbol, bars4h: bars, price: +tk.lastPrice, balance: bal, riskPct: RISK_PCT, leverage: LEVERAGE, meta: m });
      if (plan && !plan.skip) {
        // News veto is shadow-only here: log what it WOULD have done, never gate the fill.
        const sentiment = await sentimentShadow({ ticker: symbol.split('_')[0], dir: plan.dir });
        await recordShadow(plan, barTs, sentiment);
        actedBar.set(symbol, barTs); await placeEntry(plan, m);
      } else if (plan?.skip) {
        await recordShadow(plan, barTs);
        actedBar.set(symbol, barTs); log(`${symbol}: signal but skip=${plan.skip}`);
      }
    } catch (e) { log(`${symbol}: cycle error ${e.message}`); }
  }
  await writeHealth(false);
}

async function main() {
  if (!API_KEY || !API_SECRET) { log('FATAL: MEXC creds not set'); process.exit(2); }
  log(`mean-rev executor up · ${DRY_RUN ? 'DRY-RUN (no orders)' : '🔴 LIVE'} · basket=${BASKET.join(',')} · risk=${(RISK_PCT * 100).toFixed(1)}% · cycle=${CYCLE_MS / 1000}s`);
  if (process.env.MEANREV_ONCE === '1') { await cycle(); log('single cycle done'); return; }
  for (;;) { try { await cycle(); } catch (e) { log('cycle FATAL', e.message); } await sleep(CYCLE_MS); }
}
main();
