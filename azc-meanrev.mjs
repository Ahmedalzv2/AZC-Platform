// Mean-reversion live executor (fade 4h Donchian extremes) — the fee-surviving
// lane. Scans the basket on each closed 4h bar; on a signal places a maker-limit
// entry, then a maker-limit TP + taker stop (same exit model proven in the FVG
// lane). One position per symbol, kill switch, audit log.
//
// SAFETY: DRY_RUN defaults ON — logs intents, places NOTHING. Arm live only
// with MEANREV_LIVE=1 (explicit). Risk 1%/trade, isolated, minimum size.
import { callMexcSigned } from './mexc-signer.mjs';
import { planMeanRevTrade, resampleTo4h, MR_PARAMS } from './strategy-meanrev.mjs';

const API_KEY = process.env.MEXC_API_KEY, API_SECRET = process.env.MEXC_API_SECRET;
const DRY_RUN = process.env.MEANREV_LIVE !== '1';     // live ONLY when explicitly armed
const BASKET = (process.env.MEANREV_BASKET || 'LTC,ADA,DOGE,SOL,XRP').split(',').map(s => `${s}_USDT`);
const RISK_PCT = Number(process.env.MEANREV_RISK || 0.01);
const LEVERAGE = Number(process.env.MEANREV_LEV || 10);
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), '·', ...a);

const sg = (o) => callMexcSigned({ apiKey: API_KEY, apiSecret: API_SECRET, ...o })
  .then(r => { try { return JSON.parse(r.body); } catch { return { raw: r.body }; } });
const pub = (u) => fetch(u, { signal: AbortSignal.timeout(8000) }).then(r => r.json());

// Build CLOSED 4h candles from Min60 klines, aligned to UTC 4h boundaries.
async function bars4h(symbol) {
  const j = await pub(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Min60&limit=320`);
  const d = j?.data || {};
  if (!Array.isArray(d.time)) return [];
  let m60 = d.time.map((t, i) => ({ t: t * 1000, o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i] }));
  m60 = m60.slice(0, -1);                                   // drop in-progress hour
  while (m60.length && new Date(m60[0].t).getUTCHours() % 4 !== 0) m60.shift();  // align
  const c4 = resampleTo4h(m60, 4);
  // drop a trailing partial 4h (only keep full 4-hour groups)
  return c4;
}

async function ticker(symbol) { return (await pub(`https://contract.mexc.com/api/v1/contract/ticker?symbol=${symbol}`))?.data; }
async function meta(symbol) { const j = await pub(`https://contract.mexc.com/api/v1/contract/detail?symbol=${symbol}`); return j?.data; }
async function balance() { const a = await sg({ path: '/api/v1/private/account/assets', method: 'GET' }); return +((a?.data || []).find(x => x.currency === 'USDT')?.availableBalance) || 0; }
async function openSymbols() { const r = await sg({ path: '/api/v1/private/position/open_positions', method: 'GET' }); return new Set((r?.data || []).filter(p => +p.holdVol > 0).map(p => p.symbol)); }

async function scanOnce() {
  log(`mean-rev scan · ${DRY_RUN ? 'DRY-RUN (no orders)' : 'LIVE'} · basket=${BASKET.join(',')} · risk=${(RISK_PCT * 100).toFixed(1)}% · params don=${MR_PARAMS.don}/atr×${MR_PARAMS.atrMult}/rr=${MR_PARAMS.rr}`);
  const bal = await balance();
  const held = await openSymbols();
  log(`balance=$${bal.toFixed(2)} · open positions: ${[...held].join(',') || 'none'}`);
  for (const symbol of BASKET) {
    try {
      const [bars, tk, m] = await Promise.all([bars4h(symbol), ticker(symbol), meta(symbol)]);
      if (bars.length < MR_PARAMS.don + MR_PARAMS.atrN + 2) { log(`${symbol}: insufficient 4h history (${bars.length})`); continue; }
      if (held.has(symbol)) { log(`${symbol}: already in position — skip`); continue; }
      const price = +tk.lastPrice;
      const plan = planMeanRevTrade({ symbol, bars4h: bars, price, balance: bal, riskPct: RISK_PCT, leverage: LEVERAGE, meta: m });
      if (!plan) { log(`${symbol}: no signal (last 4h close ${bars[bars.length - 1].c}, inside channel)`); continue; }
      if (plan.skip) { log(`${symbol}: SIGNAL but skip=${plan.skip}`); continue; }
      log(`${symbol}: 🎯 ${plan.dir.toUpperCase()} signal — entry=${plan.entry} stop=${plan.stop} tp=${plan.tp} qty=${plan.qty} risk=$${plan.riskUsd.toFixed(2)}`);
      if (!DRY_RUN) {
        log(`${symbol}: LIVE placement not yet wired in this build — intent logged, no order. (next PR)`);
      }
    } catch (e) { log(`${symbol}: scan error ${e.message}`); }
  }
  log('scan complete.');
}

scanOnce().catch(e => { log('FATAL', e.message); process.exit(1); });
