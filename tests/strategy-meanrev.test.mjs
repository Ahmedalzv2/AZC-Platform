// Pins the live mean-reversion signal so the trader and backtest can't drift.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { meanRevSignal, buildMeanRevLevels, resampleTo4h } from '../strategy-meanrev.mjs';

// 31 calm bars in a tight 100-101 channel, then a final bar that closes a
// known distance beyond it. don=20 window sees the channel; ATR is steady.
function channel(n = 31) {
  const b = [];
  for (let i = 0; i < n; i++) b.push({ t: i, o: 100.4, h: 101, l: 100, c: 100.5 });
  return b;
}
const P = { don: 20, atrMult: 2, rr: 1.2, atrN: 14, fade: true };

describe('meanRevSignal (fade 4h extremes)', () => {
  it('close above Donchian high → SHORT (fade the upside)', () => {
    const bars = channel(); bars.push({ t: 99, o: 101, h: 102, l: 101, c: 101.5 }); // c > hh(101)
    const s = meanRevSignal(bars, P);
    assert.equal(s.dir, 'short');
    assert.ok(s.risk > 0 && s.atr > 0);
  });
  it('close below Donchian low → LONG (fade the downside)', () => {
    const bars = channel(); bars.push({ t: 99, o: 100, h: 100, l: 98, c: 99 }); // c < ll(100)
    const s = meanRevSignal(bars, P);
    assert.equal(s.dir, 'long');
  });
  it('close inside the channel → no signal', () => {
    const bars = channel(); bars.push({ t: 99, o: 100.5, h: 100.8, l: 100.2, c: 100.5 });
    assert.equal(meanRevSignal(bars, P), null);
  });
  it('too little history → no signal', () => {
    assert.equal(meanRevSignal(channel(10), P), null);
  });
  it('levels: short stop is above entry, TP below, sized by risk/rr', () => {
    const sig = { dir: 'short', risk: 2, rr: 1.2 };
    const { stop, tp } = buildMeanRevLevels(100, sig);
    assert.equal(stop, 102);          // entry + risk
    assert.equal(tp, 100 - 2.4);      // entry - rr*risk
  });
  it('resampleTo4h folds 48 5m bars into one 4h bar (OHLC)', () => {
    const m5 = Array.from({ length: 48 }, (_, i) => ({ t: i, o: i === 0 ? 10 : 11, h: 10 + i, l: 5, c: i === 47 ? 20 : 12 }));
    const [bar] = resampleTo4h(m5);
    assert.equal(bar.o, 10); assert.equal(bar.c, 20);
    assert.equal(bar.h, 57); assert.equal(bar.l, 5);
  });
});
