import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

// Minimal kline factory: { o, h, l, c }.
const kl = (o, h, l, c) => ({ o, h, l, c });

// Build a stable base series of N small-body candles around price `base`.
// ATR over this stretch is small, so any large body later reads as displacement.
function flat(n, base) {
  return Array.from({ length: n }, () =>
    kl(base, base + 0.2, base - 0.2, base + 0.05));
}

describe('_classifyPhase', () => {
  test('returns unknown for too-short series', () => {
    const { app } = loadApp();
    assert.equal(app._classifyPhase([]).phase, 'unknown');
    assert.equal(app._classifyPhase(flat(10, 100)).phase, 'unknown');
  });

  test('flat-range klines → consolidation', () => {
    const { app } = loadApp();
    const r = app._classifyPhase(flat(20, 100));
    assert.equal(r.phase, 'consolidation');
    assert.equal(r.dir, null);
  });

  test('latest candle is a big bull body → expansion bull', () => {
    const { app } = loadApp();
    const k = flat(18, 100);
    k.push(kl(100, 106, 99.8, 105)); // body = 5 vs ATR ≈ 0.2
    const r = app._classifyPhase(k);
    assert.equal(r.phase, 'expansion');
    assert.equal(r.dir, 'bull');
  });

  test('big bull body 5 bars ago, small pullback now → retracement bull', () => {
    const { app } = loadApp();
    const k = flat(15, 100);
    k.push(kl(100, 106, 99.8, 105)); // displacement
    // 4 small bearish pullback bars
    k.push(kl(105, 105.1, 104.5, 104.7));
    k.push(kl(104.7, 104.8, 104.2, 104.3));
    k.push(kl(104.3, 104.4, 103.9, 104.0));
    k.push(kl(104.0, 104.1, 103.7, 103.8));
    const r = app._classifyPhase(k);
    assert.equal(r.phase, 'retracement');
    assert.equal(r.dir, 'bull'); // expected continuation direction
  });

  test('big bull body then big bear body within last 3 bars → reversal-suspect bear', () => {
    const { app } = loadApp();
    const k = flat(15, 100);
    k.push(kl(100, 106, 99.8, 105)); // bull displacement
    k.push(kl(105, 105.2, 104.5, 104.8));
    k.push(kl(104.8, 105, 99, 99.5)); // bear displacement counter to prior
    const r = app._classifyPhase(k);
    assert.equal(r.phase, 'reversal-suspect');
    assert.equal(r.dir, 'bear');
  });

  test('big bull body then small bull continuation → continuation bull', () => {
    const { app } = loadApp();
    const k = flat(15, 100);
    k.push(kl(100, 106, 99.8, 105)); // displacement
    k.push(kl(105, 105.5, 104.9, 105.4));
    k.push(kl(105.4, 105.9, 105.3, 105.8));
    k.push(kl(105.8, 106.3, 105.7, 106.2));
    const r = app._classifyPhase(k);
    assert.equal(r.phase, 'continuation');
    assert.equal(r.dir, 'bull');
  });
});

describe('_analyzeKlines surfaces phase', () => {
  test('phase + phaseDir are present in the analyze output', () => {
    const { app } = loadApp();
    const k = flat(22, 100); // _analyzeKlines needs ≥22 bars
    k.push(kl(100, 106, 99.8, 105));
    const out = app._analyzeKlines(k);
    assert.equal(out.error, undefined);
    assert.equal(out.phase, 'expansion');
    assert.equal(out.phaseDir, 'bull');
  });
});
