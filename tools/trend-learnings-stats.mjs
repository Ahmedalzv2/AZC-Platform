// Textbook-standard significance + cost analysis for the 4h trend+trail lane,
// applying two methods from the financial-data-science notebooks to our own
// production code path (decideStep/tradeNetR over the 1825d fixtures):
//   - Jegadeesh-Titman: Newey-West (HAC) t-stats — iid SEs overstate
//     significance when trade returns cluster by regime.
//   - Perold implementation shortfall: gross alpha − cost = net, plus the
//     breakeven per-leg cost the edge can absorb before it dies.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRATEGY_PARAMS, decideStep, tradeNetR } from '../strategy-trend-trail.mjs';
import { neweyWestTStat, autoLag } from '../nw-tstat.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');
const FOUR_H = 4 * 3600 * 1000;
const to4h = (b) => { const m = new Map(); for (const x of b) { const k = Math.floor(x.t / FOUR_H) * FOUR_H; const e = m.get(k); if (!e) m.set(k, { t: k, o: x.o, h: x.h, l: x.l, c: x.c }); else { e.h = Math.max(e.h, x.h); e.l = Math.min(e.l, x.l); e.c = x.c; } } return [...m.values()].sort((a, b) => a.t - b.t); };
const load = (s) => to4h(JSON.parse(readFileSync(path.join(FIX, `${s}-1825d-Min60.json`), 'utf8')));

function replay(bars, P = STRATEGY_PARAMS) {
  const out = []; let pos = null;
  for (let i = 0; i < bars.length; i++) {
    const d = decideStep({ bars, i, position: pos, params: P });
    if (d.action === 'open') pos = { dir: d.dir, entry: d.entry, initialStop: d.initialStop, atrAtEntry: d.atrAtEntry, hwm: d.entry, lwm: d.entry };
    else if (d.action === 'hold' && pos) { pos.hwm = d.hwm; pos.lwm = d.lwm; }
    else if (d.action === 'close' && pos) {
      const { grossR, netR } = tradeNetR({ dir: pos.dir, entry: pos.entry, exit: d.exit, atrAtEntry: pos.atrAtEntry, params: P });
      const risk = P.atrMult * pos.atrAtEntry;          // 1R in price terms
      out.push({ t: bars[i].t, grossR, netR, K: pos.entry / risk }); // K = notional/risk drives cost
      pos = null;
    }
  }
  return out;
}
const basketTrades = (syms) => syms.flatMap(s => replay(load(s))).sort((a, b) => a.t - b.t);
const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);

function monthly(trades, key) {
  const m = new Map();
  for (const t of trades) { const d = new Date(t.t); const k = d.getUTCFullYear() * 12 + d.getUTCMonth(); m.set(k, (m.get(k) || 0) + t[key]); }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
}

const BASKETS = {
  'baseline5   ': ['ADA', 'DOGE', 'LTC', 'SOL', 'XRP'],
  'noLTC       ': ['ADA', 'DOGE', 'SOL', 'XRP'],
  'DOGE,SOL,XRP': ['DOGE', 'SOL', 'XRP'],
  'ADA,SOL,XRP ': ['ADA', 'SOL', 'XRP'],
};
const TAKER0 = STRATEGY_PARAMS.takerRate, SLIP0 = (STRATEGY_PARAMS.slipBps || 0) / 10000;
const perLeg0 = TAKER0 + SLIP0;                          // current cost per leg (price fraction)

console.log(`4h trend+trail · 5y · production decideStep/tradeNetR · Newey-West HAC + Perold shortfall`);
console.log(`current cost/leg = taker ${(TAKER0 * 1e4).toFixed(0)}bps + slip ${(SLIP0 * 1e4).toFixed(0)}bps = ${(perLeg0 * 1e4).toFixed(0)}bps\n`);

for (const [name, syms] of Object.entries(BASKETS)) {
  const tr = basketTrades(syms);
  const net = tr.map(t => t.netR), gross = tr.map(t => t.grossR);
  const mGross = mean(gross), mNet = mean(net), mK = mean(tr.map(t => t.K));
  const win = net.filter(x => x > 0).length / net.length * 100;

  const nwNet = neweyWestTStat(net, autoLag(net.length));
  const nwGross = neweyWestTStat(gross, autoLag(gross.length));
  const moNet = monthly(tr, 'netR');
  const nwMo = neweyWestTStat(moNet, 6);                 // JT uses maxlags=6 on monthly

  // Perold shortfall: cost_i = K_i * 2 * perLeg ; breakeven per-leg c* solves
  // mGross = mK * 2 * c*  ->  c* = mGross / (2*mK). Headroom vs current cost.
  const cStar = mGross / (2 * mK);
  const beTaker = cStar - SLIP0;                          // breakeven taker, holding slip fixed
  const mCost = mGross - mNet;

  console.log(`── ${name}  n=${net.length}  win=${win.toFixed(0)}%`);
  console.log(`   per-trade netR : mean ${mNet.toFixed(4)}  t_iid ${nwNet.tIid.toFixed(2)}  →  t_HAC ${nwNet.tHac.toFixed(2)} (lags ${nwNet.lags})  ${Math.abs(nwNet.tHac) > 1.96 ? 'SIG@5%' : 'not sig'}`);
  console.log(`   per-trade gross: mean ${mGross.toFixed(4)}  t_HAC ${nwGross.tHac.toFixed(2)}`);
  console.log(`   monthly netR   : ${nwMo.n} months  mean ${nwMo.mean.toFixed(3)}R/mo  t_HAC@6 ${nwMo.tHac.toFixed(2)}  ${Math.abs(nwMo.tHac) > 1.96 ? 'SIG@5%' : 'not sig'}`);
  console.log(`   shortfall      : alpha ${mGross.toFixed(4)} − cost ${mCost.toFixed(4)} = net ${mNet.toFixed(4)}  (cost ${(mCost / mGross * 100).toFixed(0)}% of alpha)`);
  console.log(`   breakeven cost : ${(cStar * 1e4).toFixed(1)}bps/leg vs ${(perLeg0 * 1e4).toFixed(0)}bps now → ${(cStar / perLeg0).toFixed(2)}× headroom · breakeven taker ${(beTaker * 1e4).toFixed(1)}bps\n`);
}
console.log('t_HAC|>1.96 ⇒ mean return significantly >0 at 5% after autocorrelation correction (JT/Newey-West).');
