// Mean-reversion (fade 4h Donchian extremes) — the live signal, extracted as
// a pure module so the trader and the backtest share one source of truth and
// can't silently diverge (the lesson from trader-signal.mjs). Logic is a
// faithful port of tests/backtest-meanrev.mjs simulateMeanRev().
//
// Edge (365d anchored walk-forward, OOS, fade=true): +0.090R/trade at real
// maker/taker, +0.060R/trade under all-taker worst case; 8/10 symbols and
// 4/5 folds positive. Survives fees because it's ~1 trade/symbol/week on 4h
// — the opposite of the fee-dead 5m FVG scalp.

import { sizeTradeByRiskAndMargin } from './trader-sizing.mjs';

export const BARS_PER_4H = 48;        // 5m -> 4h
export const MR_ATR_N = 14;

// Walk-forward most-recent-fold winners (folds 4-5): don=30, atrMult=2, rr=1.2.
export const MR_PARAMS = { don: 30, atrMult: 2, rr: 1.2, atrN: MR_ATR_N, fade: true };

export function resampleTo4h(bars, per = BARS_PER_4H) {
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

export function atr(bars, i, n = MR_ATR_N) {
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) {
    s += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
  }
  return s / n;
}

// Evaluate the LAST CLOSED 4h bar. Returns null (no signal) or
// { dir, atr, risk, rr, refClose }. `risk` is the entry-to-stop distance in
// price units; the executor derives stop/tp from the live entry via
// buildMeanRevLevels (entry is "next open" in backtest terms = fill price live).
export function meanRevSignal(bars, params = MR_PARAMS) {
  const { don, atrMult, rr, atrN = MR_ATR_N, fade = true } = params;
  const i = bars.length - 1;
  if (i < Math.max(don, atrN)) return null;          // need don history + ATR warmup
  const hh = Math.max(...bars.slice(i - don, i).map(x => x.h));
  const ll = Math.min(...bars.slice(i - don, i).map(x => x.l));
  const a = atr(bars, i, atrN);
  if (!(a > 0)) return null;
  const c = bars[i].c;
  let dir = null;
  if (c > hh) dir = fade ? 'short' : 'long';          // fade the upside extreme
  else if (c < ll) dir = fade ? 'long' : 'short';     // fade the downside extreme
  if (!dir) return null;
  return { dir, atr: a, risk: atrMult * a, rr, refClose: c };
}

// Stop/TP from a concrete entry price + a signal. Stop one ATR-risk away,
// TP rr*risk toward the mean.
export function buildMeanRevLevels(entry, sig) {
  const stop = sig.dir === 'long' ? entry - sig.risk : entry + sig.risk;
  const tp   = sig.dir === 'long' ? entry + sig.rr * sig.risk : entry - sig.rr * sig.risk;
  return { stop, tp };
}

// Full pure trade plan: signal + live price + balance + contract spec ->
// an exchange-ready order intent, or null (no signal) / {skip} (unsizable).
// MEXC sides: 1=open long, 3=open short, 4=close long, 2=close short.
export function planMeanRevTrade({ symbol, bars4h, price, balance, riskPct, leverage, meta, params = MR_PARAMS }) {
  const sig = meanRevSignal(bars4h, params);
  if (!sig) return null;
  const pu = Number(meta.priceUnit);
  const dec = (String(pu).split('.')[1] || '').length;
  const snap = v => Number((Math.round(v / pu) * pu).toFixed(dec));
  const entry = snap(price);
  let { stop, tp } = buildMeanRevLevels(entry, sig);
  stop = snap(stop); tp = snap(tp);
  const stopDistUsdPerContract = Math.abs(entry - stop) * Number(meta.contractSize);
  if (!(stopDistUsdPerContract > 0)) return { skip: 'zero-stop-dist', symbol };
  const sized = sizeTradeByRiskAndMargin({
    balance, riskPct, leverage, entry, stopDistUsdPerContract,
    contractSize: meta.contractSize, minVol: meta.minVol,
  });
  if (!sized.qty || sized.qty <= 0) return { skip: sized.reason || 'unsized', symbol };
  return {
    symbol, dir: sig.dir,
    sideOpen:  sig.dir === 'long' ? 1 : 3,
    sideClose: sig.dir === 'long' ? 4 : 2,
    entry, stop, tp, qty: sized.qty,
    riskUsd: sized.riskUsd, atr: sig.atr,
  };
}
