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
  regimeN: 20,    // Kaufman efficiency-ratio lookback
  erMin: 0.35,    // only enter when ER >= this (trending); below = chop, stand aside.
                  // Fixed (not optimized): OOS +0.089R vs +0.061R ungated, and
                  // ~halves max drawdown (39%→23%). Whole 0.25–0.40 band behaves
                  // similarly, so it isn't curve-fit to one value.
  riskPct: 0.005, // 0.5% per trade
  maxPositions: 10, // portfolio cap: max concurrent open positions across the universe
  takerRate: 0.0006, // MEXC futures taker; modeled on BOTH legs (no free-maker assumption)
  slipBps: 10,       // adverse slippage per taker leg
};

// Kaufman Efficiency Ratio over the last n bars: |net move| / Σ|bar moves|.
// ~1 = clean directional trend, ~0 = choppy/ranging. The regime gate that
// keeps trend-following out of the chop where it gets whipsawed.
export function efficiencyRatio(bars, i, n) {
  if (i - n < 0) return 0;
  const net = Math.abs(bars[i].c - bars[i - n].c);
  let vol = 0;
  for (let k = i - n + 1; k <= i; k++) vol += Math.abs(bars[k].c - bars[k - 1].c);
  return vol > 0 ? net / vol : 0;
}

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
    // Regime gate: skip breakouts when the market is choppy (low ER).
    if (params.erMin > 0 && efficiencyRatio(bars, i, params.regimeN) < params.erMin) {
      return { action: 'flat', regime: 'chop' };
    }
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

// Gross R (pure price move, no costs) and net R (real MEXC fees + slippage on
// BOTH legs as taker — no free-maker assumption). Always returns both so the
// paper journal can show pnl with and without fees side by side.
export function tradeNetR({ dir, entry, exit, atrAtEntry, params = STRATEGY_PARAMS }) {
  const risk = params.atrMult * atrAtEntry;
  const grossMove = dir === 'long' ? exit - entry : entry - exit;
  const grossR = grossMove / risk;
  const slip = (params.slipBps || 0) / 10000;
  const costR = (entry * (2 * params.takerRate + 2 * slip)) / risk; // entry+exit taker + slip both
  return { grossR, netR: grossR - costR };
}
