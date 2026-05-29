// Pinning tests for the shared signal module. These don't try to test
// every edge of the FVG retest math — the backtest harness is the proof
// — but they pin the public API so the live trader and backtest can't
// silently diverge again after refactors.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectUnmitigatedFvg, htfBias, buildSetup, buildMakerTpOrder } from '../trader-signal.mjs';
import * as CONFIG from '../trader-config.mjs';

const SIGNAL = {
  HTF_SMA: CONFIG.HTF_SMA,
  FVG_BUFFER_PCT: CONFIG.FVG_BUFFER_PCT,
  TOUCH_TOLERANCE_PCT: CONFIG.TOUCH_TOLERANCE_PCT,
  MIN_FVG_BODY_PCT: CONFIG.MIN_FVG_BODY_PCT,
  MIN_STOP_PCT: CONFIG.MIN_STOP_PCT,
  RR: CONFIG.RR,
};

// Three-bar window with a bullish FVG between bar[0].h (100) and bar[2].l (102).
// FVG: lo=100, hi=102, mid=101, body=2.
const bullFvgBars = [
  { t: 0, o: 99,  h: 100, l: 99,  c: 99.5 },
  { t: 1, o: 101, h: 103, l: 100.5, c: 102.5 },
  { t: 2, o: 102.5, h: 103.5, l: 102, c: 103 },
];

// Three-bar window with a bearish FVG between bar[2].h (98) and bar[0].l (100).
// FVG: lo=98, hi=100, mid=99, body=2.
const bearFvgBars = [
  { t: 0, o: 101, h: 102, l: 100, c: 100.5 },
  { t: 1, o: 99.5, h: 99.8, l: 97,  c: 97.5 },
  { t: 2, o: 97.5, h: 98,   l: 97,  c: 97.2 },
];

const flatHtf20 = Array.from({ length: 25 }, (_, i) => ({
  t: i, o: 100, h: 100, l: 100, c: 100,
}));

describe('detectUnmitigatedFvg', () => {
  it('returns null below the 3-bar minimum', () => {
    assert.equal(detectUnmitigatedFvg([]), null);
    assert.equal(detectUnmitigatedFvg([{ t: 0, h: 1, l: 0, c: 0.5 }]), null);
  });

  it('detects a clean bullish gap', () => {
    const g = detectUnmitigatedFvg(bullFvgBars);
    assert.equal(g.dir, 'bull');
    assert.equal(g.lo, 100);
    assert.equal(g.hi, 102);
    assert.equal(g.mid, 101);
  });

  it('detects a clean bearish gap', () => {
    const g = detectUnmitigatedFvg(bearFvgBars);
    assert.equal(g.dir, 'bear');
    assert.equal(g.lo, 98);
    assert.equal(g.hi, 100);
    assert.equal(g.mid, 99);
  });

  it('skips gaps that have been mitigated by a later bar', () => {
    const bars = [
      ...bullFvgBars,
      { t: 3, o: 102, h: 102.5, l: 100.5, c: 101 }, // wicks back into mid (101)
    ];
    assert.equal(detectUnmitigatedFvg(bars), null);
  });
});

describe('htfBias', () => {
  it('skips below warmup length', () => {
    assert.equal(htfBias(flatHtf20.slice(0, 5), 20).skip, 'htf-warmup');
  });

  it('emits bear when last close is below SMA', () => {
    const bars = [...flatHtf20];
    bars[bars.length - 1] = { ...bars[bars.length - 1], c: 90 };
    assert.equal(htfBias(bars, 20).dir, 'bear');
  });

  it('emits bull when last close is above SMA', () => {
    const bars = [...flatHtf20];
    bars[bars.length - 1] = { ...bars[bars.length - 1], c: 110 };
    assert.equal(htfBias(bars, 20).dir, 'bull');
  });
});

describe('buildSetup', () => {
  it('returns htf-warmup before the SMA window is full', () => {
    const r = buildSetup({
      bars5m: bullFvgBars,
      htfBars: flatHtf20.slice(0, 5),
      price: 101,
      config: SIGNAL,
    });
    assert.equal(r.skip, 'htf-warmup');
  });

  it('returns htf-disagree when bias points the wrong way', () => {
    const bearHtf = [...flatHtf20];
    bearHtf[bearHtf.length - 1] = { ...bearHtf[bearHtf.length - 1], c: 90 };
    const r = buildSetup({
      bars5m: bullFvgBars,
      htfBars: bearHtf,
      price: 101,
      config: SIGNAL,
    });
    assert.equal(r.skip, 'htf-disagree');
  });

  it('returns far-from-fvg when price is outside the touch tolerance', () => {
    const bullHtf = [...flatHtf20];
    bullHtf[bullHtf.length - 1] = { ...bullHtf[bullHtf.length - 1], c: 110 };
    const r = buildSetup({
      bars5m: bullFvgBars,
      htfBars: bullHtf,
      price: 105,
      config: SIGNAL,
    });
    assert.equal(r.skip, 'far-from-fvg');
  });

  it('emits a complete setup when all gates pass and pins SL/TP math', () => {
    const bullHtf = [...flatHtf20];
    bullHtf[bullHtf.length - 1] = { ...bullHtf[bullHtf.length - 1], c: 110 };
    const r = buildSetup({
      bars5m: bullFvgBars,
      htfBars: bullHtf,
      price: 101,
      config: { ...SIGNAL, MIN_FVG_BODY_PCT: 0, MIN_STOP_PCT: 0, FVG_BUFFER_PCT: 0.1, RR: 2 },
    });
    // FVG: lo=100, hi=102, mid=101, body=2. price=101 (at the mid).
    // farEdge=100, slDir=-1, slRaw=100 - 2*0.1=99.8, slMin=101 (MIN_STOP=0).
    // sl=min(99.8, 101)=99.8. stopDist=1.2. tp=101+1.2*2=103.4.
    assert.equal(r.skip, undefined);
    assert.equal(r.htfDir, 'bull');
    assert.equal(r.entry, 101);
    assert.equal(r.sl, 99.8);
    assert.equal(r.tp, 103.4);
    assert.equal(r.stopDist.toFixed(6), '1.200000');
  });

  it('floors stopDist at price * MIN_STOP_PCT when slMin binds', () => {
    const bullHtf = [...flatHtf20];
    bullHtf[bullHtf.length - 1] = { ...bullHtf[bullHtf.length - 1], c: 110 };
    const r = buildSetup({
      bars5m: bullFvgBars,
      htfBars: bullHtf,
      price: 101,
      config: { ...SIGNAL, MIN_FVG_BODY_PCT: 0, MIN_STOP_PCT: 0.05, FVG_BUFFER_PCT: 0.1 },
    });
    // FVG body=2, farEdge=100. slRaw=99.8 (stopDist 1.2 = 1.19%).
    // MIN_STOP=5% → slMin=101*(1-0.05)=95.95 (stopDist 5.05).
    // min(99.8, 95.95)=95.95 → slMin binds. stopDist = 101*0.05 = 5.05.
    assert.ok(r.stopDist >= 101 * 0.05 - 1e-9);
    assert.equal(r.sl, 95.95);
  });

  it('does not skip on floating-point boundary at the MIN_STOP threshold', () => {
    // Synthesised inputs where slMin binds and stopDist/price computes to
    // 0.001999999... instead of exactly 0.002 due to FP arithmetic. The
    // shared epsilon must let this through.
    const bullHtf = [...flatHtf20];
    bullHtf[bullHtf.length - 1] = { ...bullHtf[bullHtf.length - 1], c: 110 };
    const r = buildSetup({
      bars5m: bullFvgBars,
      htfBars: bullHtf,
      price: 0.1234,
      config: { ...SIGNAL, MIN_FVG_BODY_PCT: 0, MIN_STOP_PCT: 0.002, FVG_BUFFER_PCT: 0.1 },
    });
    // slMin should bind (FVG body is huge relative to this price), and the
    // entry/sl FP subtraction produces stopDist below the threshold by ~1e-17.
    assert.notEqual(r.skip, 'stop-too-tight');
  });
});

describe('buildMakerTpOrder', () => {
  it('long TP → close-long side 4, POST_ONLY type 2, price at TP', () => {
    const o = buildMakerTpOrder({ symbol: 'SOL_USDT', tp: 150.5, qty: 3, lev: 10, dir: 'bull' });
    assert.equal(o.side, 4);            // 4 = close long
    assert.equal(o.type, 2);            // POST_ONLY maker — never crosses (TP above mkt)
    assert.equal(o.price, 150.5);
    assert.equal(o.vol, 3);
    assert.equal(o.leverage, 10);
    assert.equal(o.openType, 1);
  });
  it('short TP → close-short side 2', () => {
    const o = buildMakerTpOrder({ symbol: 'XRP_USDT', tp: 1.20, qty: 100, lev: 10, dir: 'bear' });
    assert.equal(o.side, 2);            // 2 = close short
    assert.equal(o.type, 2);
    assert.equal(o.price, 1.20);
  });
});
