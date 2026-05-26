// Pure signal logic shared by the live trader and the proof backtest.
//
// Live trader (azc-trader.mjs) and backtest (tests/backtest-azc-trader.mjs)
// used to carry hand-mirrored copies of detectUnmitigatedFvg + the FVG
// retest math. Drift between them silently invalidates the proof — the
// backtest no longer measures what production is doing. This module is
// the single source so the next config tweak is reflected in both.
//
// No I/O, no constants, no env reads — every threshold is passed in.

export function detectUnmitigatedFvg(bars) {
  if (bars.length < 3) return null;
  for (let i = bars.length - 1; i >= 2; i--) {
    const a = bars[i - 2], c = bars[i];
    let gap = null;
    if (a.h < c.l)      gap = { dir: 'bull', lo: a.h, hi: c.l };
    else if (a.l > c.h) gap = { dir: 'bear', lo: c.h, hi: a.l };
    if (!gap) continue;
    gap.mid = (gap.lo + gap.hi) / 2;
    gap.body = gap.hi - gap.lo;
    gap.formedAt = c.t;
    gap.formedIdx = i;
    let mitigated = false;
    for (let j = i + 1; j < bars.length; j++) {
      if (bars[j].l <= gap.mid && bars[j].h >= gap.mid) { mitigated = true; break; }
    }
    if (!mitigated) return gap;
  }
  return null;
}

export function htfBias(htfBars, smaLen) {
  if (!htfBars || htfBars.length < smaLen) return { skip: 'htf-warmup' };
  const recent = htfBars.slice(-smaLen);
  const sma = recent.reduce((a, b) => a + b.c, 0) / recent.length;
  const dir = htfBars[htfBars.length - 1].c > sma ? 'bull' : 'bear';
  return { dir, sma };
}

// Returns { skip, ... } if a gate fails, or the prepared setup
// { fvg, htfDir, entry, sl, tp, stopDist, fvgBodyPct, distPct }.
//
// Entry is the FVG mid. SL = farEdge + body*fvgBufferPct, floored so that
// stopDist/price >= minStopPct. TP = entry +/- stopDist*rr. Caller layers
// per-symbol gates (cooldown, side filter, contract sizing) on top.
export function buildSetup({ bars5m, htfBars, price, config }) {
  const c = config || {};
  const FVG_BUFFER_PCT      = c.FVG_BUFFER_PCT;
  const TOUCH_TOLERANCE_PCT = c.TOUCH_TOLERANCE_PCT;
  const MIN_FVG_BODY_PCT    = c.MIN_FVG_BODY_PCT;
  const MIN_STOP_PCT        = c.MIN_STOP_PCT;
  const RR                  = c.RR;
  const HTF_SMA             = c.HTF_SMA;

  const bias = htfBias(htfBars, HTF_SMA);
  if (bias.skip) return bias;

  const fvg = detectUnmitigatedFvg(bars5m);
  if (!fvg) return { skip: 'no-fvg' };
  if (fvg.dir !== bias.dir) return { skip: 'htf-disagree' };

  const fvgBodyPct = fvg.body / price;
  if (fvgBodyPct < MIN_FVG_BODY_PCT) return { skip: 'fvg-too-small', fvgBodyPct };

  const distPct = Math.abs((price - fvg.mid) / fvg.mid);
  if (distPct > TOUCH_TOLERANCE_PCT) return { skip: 'far-from-fvg', distPct };

  const farEdge = fvg.dir === 'bull' ? fvg.lo : fvg.hi;
  const slDir   = fvg.dir === 'bull' ? -1 : 1;
  const entry   = fvg.mid;
  const slRaw   = farEdge + slDir * (fvg.body * FVG_BUFFER_PCT);
  const slMin   = entry + slDir * (price * MIN_STOP_PCT);
  const sl      = fvg.dir === 'bull' ? Math.min(slRaw, slMin) : Math.max(slRaw, slMin);
  const stopDist = Math.abs(entry - sl);
  if (!isFinite(stopDist) || stopDist <= 0) return { skip: 'invalid-stop' };
  // FP epsilon — when slMin binds, stopDist is mathematically equal to
  // price * MIN_STOP_PCT, but the subtraction rounds to ~1e-17 below.
  // Without the epsilon the strict < would silently kick out ~5% of
  // otherwise-valid setups (109/2300 on the 90d ARB fixture alone).
  if (stopDist / price < MIN_STOP_PCT - 1e-12) return { skip: 'stop-too-tight' };

  const tp = fvg.dir === 'bull' ? entry + stopDist * RR : entry - stopDist * RR;
  return { fvg, htfDir: bias.dir, entry, sl, tp, stopDist, fvgBodyPct, distPct };
}
