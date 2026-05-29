import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resample, atr, simulateMeanRev, metrics } from './backtest-meanrev.mjs';

const bar = (t, o, h, l, c) => ({ t, o, h, l, c });

describe('meanrev pure helpers', () => {
  it('resample aggregates OHLC over the window', () => {
    const b = [bar(0, 1, 2, 0.5, 1.5), bar(1, 1.5, 3, 1, 2), bar(2, 2, 2.5, 1.8, 2.2), bar(3, 2.2, 4, 2, 3)];
    const out = resample(b, 2);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { t: 0, o: 1, h: 3, l: 0.5, c: 2 });
    assert.deepEqual(out[1], { t: 2, o: 2, h: 4, l: 1.8, c: 3 });
  });

  it('resample drops a trailing partial window', () => {
    const b = [bar(0, 1, 1, 1, 1), bar(1, 1, 1, 1, 1), bar(2, 1, 1, 1, 1)];
    assert.equal(resample(b, 2).length, 1);
  });

  it('atr averages true range', () => {
    // flat 1-wide bars → TR=1 each → ATR=1
    const b = Array.from({ length: 5 }, (_, i) => bar(i, 10, 10.5, 9.5, 10));
    assert.ok(Math.abs(atr(b, 4, 3) - 1) < 1e-9);
  });

  it('metrics computes netR, winPct, and max drawdown', () => {
    const t = [{ netR: 1, win: true }, { netR: -1, win: false }, { netR: -1, win: false }, { netR: 2, win: true }];
    const m = metrics(t);
    assert.equal(m.n, 4);
    assert.equal(m.winPct, 50);
    assert.equal(m.totalR, 1);
    assert.ok(Math.abs(m.netR - 0.25) < 1e-9);
    assert.equal(m.maxDD, 2); // peak +1 then down to -1
  });

  it('metrics is empty-safe', () => {
    assert.deepEqual(metrics([]), { n: 0, winPct: 0, netR: 0, totalR: 0, maxDD: 0 });
  });

  it('simulateMeanRev fades a downside extreme into a reversion win', () => {
    // 20 flat bars, one spike DOWN (new donchian low), then revert up to TP.
    const bars = [];
    for (let i = 0; i < 22; i++) bars.push(bar(i, 100, 100.5, 99.5, 100));
    bars[21] = bar(21, 100, 100, 95, 95);      // close 95 < 20-bar low → fade long signal
    bars.push(bar(22, 95, 96, 94.5, 95.5));     // entry bar (next open 95)
    for (let i = 23; i < 30; i++) bars.push(bar(i, 96, 110, 95.5, 108)); // reverts up → hits TP
    const trades = simulateMeanRev(bars, { don: 20, atrMult: 2, rr: 1, makerEntry: true, makerTp: true });
    assert.ok(trades.length >= 1, 'should open at least one fade trade');
    assert.equal(trades[0].dir, 'long');
    assert.ok(Number.isFinite(trades[0].netR));
  });
});
