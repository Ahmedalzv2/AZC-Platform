// Canonical 4h trend-follow + chandelier-trailing-stop strategy. This is the
// ONLY configuration that survived 3-year multi-regime walk-forward net of
// real MEXC fees (+0.061R OOS, PR #272) — fade/mean-reversion and fixed-RR
// breakout both failed out-of-sample. Pure + stateless so the backtester and
// the paper-forward harness share one source of truth.
//
// Entry: 4h close breaks the prior `don`-bar Donchian channel (continuation).
// Stop:  initial = entry ∓ atrMult·ATR; then a chandelier trail at
//        trail·ATR(entry) behind the high/low-water mark — let winners run.
// Exit:  trailing stop only (taker). No fixed take-profit.

export const STRATEGY_PARAMS = {
  tf: '4h',
  don: 30,        // Donchian lookback (WF-selected across folds)
  atrN: 14,
  atrMult: 2,     // initial stop distance in ATRs (= 1R)
  trail: 3,       // chandelier trail distance in ATRs
  riskPct: 0.005, // 0.5% per trade — sized to survive the ~81R backtest maxDD
  takerRate: 0.00075,
  slipBps: 10,
};

export function resample(bars, per) {
  const out = [];
  for (let i = 0; i + per <= bars.length; i += per) {
    const s = bars.slice(i, i + per);
    out.push({ t: s[0].t, o: s[0].o, h: Math.max(...s.map(x => x.h)), l: Math.min(...s.map(x => x.l)), c: s[s.length - 1].c });
  }
  return out;
}

export function atr(bars, i, n) {
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) {
    s += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
  }
  return s / n;
}

// Decide the action for the just-CLOSED bar at index i, given the current
// paper position (or null). Mirrors the validated backtest exactly: the stop
// is evaluated against the PRIOR high/low-water mark, which is then updated
// with this bar (no lookahead). Returns one of:
//   {action:'wait'}                         not enough history
//   {action:'flat'}                         no position, no signal
//   {action:'open', dir, entry, initialStop, atrAtEntry}
//   {action:'hold', stop, hwm, lwm}
//   {action:'close', exit, win, hwm, lwm}
export function decideStep({ bars, i, position, params = STRATEGY_PARAMS }) {
  const { don, atrN, atrMult, trail } = params;
  if (i < Math.max(don, atrN) + 1) return { action: 'wait' };
  const b = bars[i];
  const a = atr(bars, i, atrN);

  if (!position) {
    let hh = -Infinity, ll = Infinity;
    for (let k = i - don; k < i; k++) { if (bars[k].h > hh) hh = bars[k].h; if (bars[k].l < ll) ll = bars[k].l; }
    let dir = null;
    if (b.c > hh) dir = 'long';
    else if (b.c < ll) dir = 'short';
    if (!dir || !(a > 0)) return { action: 'flat' };
    const initialStop = dir === 'long' ? b.c - atrMult * a : b.c + atrMult * a;
    return { action: 'open', dir, entry: b.c, initialStop, atrAtEntry: a };
  }

  const trailDist = trail * position.atrAtEntry;
  const priorHwm = position.hwm ?? position.entry;
  const priorLwm = position.lwm ?? position.entry;
  if (position.dir === 'long') {
    const stop = Math.max(position.initialStop, priorHwm - trailDist);
    if (b.l <= stop) return { action: 'close', exit: stop, win: stop > position.entry, hwm: priorHwm, lwm: priorLwm };
    return { action: 'hold', stop, hwm: Math.max(priorHwm, b.h), lwm: Math.min(priorLwm, b.l) };
  } else {
    const stop = Math.min(position.initialStop, priorLwm + trailDist);
    if (b.h >= stop) return { action: 'close', exit: stop, win: stop < position.entry, hwm: priorHwm, lwm: priorLwm };
    return { action: 'hold', stop, hwm: Math.max(priorHwm, b.h), lwm: Math.min(priorLwm, b.l) };
  }
}

// Net R of a closed paper trade, modeling maker entry + taker trailing-stop
// exit + adverse slippage on the taker leg (same model as the backtest).
export function tradeNetR({ dir, entry, exit, atrAtEntry, params = STRATEGY_PARAMS }) {
  const risk = params.atrMult * atrAtEntry;
  const slip = (params.slipBps || 0) / 10000;
  const sgn = dir === 'long' ? 1 : -1;
  const exitFill = exit * (1 - sgn * slip);          // taker stop, adverse
  const move = dir === 'long' ? exitFill - entry : entry - exitFill;
  const grossR = move / risk;
  const feeR = (entry * params.takerRate) / risk;     // entry maker(0) + taker exit
  return { grossR, netR: grossR - feeR };
}
