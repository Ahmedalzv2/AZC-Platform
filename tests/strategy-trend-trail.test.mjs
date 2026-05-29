import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideStep, tradeNetR, efficiencyRatio, STRATEGY_PARAMS } from '../strategy-trend-trail.mjs';

const P = { don: 5, atrN: 3, atrMult: 2, trail: 3 };
const bar = (t, o, h, l, c) => ({ t, o, h, l, c });
// flat base series of `n` ~1-wide bars around `px`.
const base = (n, px = 100) => Array.from({ length: n }, (_, i) => bar(i, px, px + 0.5, px - 0.5, px));

describe('decideStep — entry', () => {
  it('waits until enough history', () => {
    assert.equal(decideStep({ bars: base(3), i: 2, position: null, params: P }).action, 'wait');
  });

  it('opens long when close breaks the prior Donchian high', () => {
    const bars = base(8);
    bars[7] = bar(7, 100, 106, 99.5, 105); // close 105 > prior 5-bar high (~100.5)
    const d = decideStep({ bars, i: 7, position: null, params: P });
    assert.equal(d.action, 'open');
    assert.equal(d.dir, 'long');
    assert.equal(d.entry, 105);
    assert.ok(d.initialStop < 105 && d.atrAtEntry > 0);
  });

  it('opens short when close breaks the prior Donchian low', () => {
    const bars = base(8);
    bars[7] = bar(7, 100, 100.5, 94, 95);
    const d = decideStep({ bars, i: 7, position: null, params: P });
    assert.equal(d.action, 'open');
    assert.equal(d.dir, 'short');
    assert.ok(d.initialStop > 95);
  });

  it('stays flat with no breakout', () => {
    assert.equal(decideStep({ bars: base(8), i: 7, position: null, params: P }).action, 'flat');
  });
});

describe('decideStep — manage open position', () => {
  const pos = { dir: 'long', entry: 100, initialStop: 96, atrAtEntry: 2, hwm: 100, lwm: 100 };

  it('holds and ratchets the high-water mark while price rises', () => {
    const bars = base(8); bars[7] = bar(7, 101, 110, 100.5, 109);
    const d = decideStep({ bars, i: 7, position: pos, params: P });
    assert.equal(d.action, 'hold');
    assert.equal(d.hwm, 110);
    assert.equal(d.stop, 96); // prior hwm 100 - 3*2=94 < initialStop 96 → initialStop
  });

  it('closes when price hits the trailed stop', () => {
    // prior hwm raised to 120 → trail stop = 120 - 6 = 114; bar dips to 113.
    const p2 = { ...pos, hwm: 120 };
    const bars = base(8); bars[7] = bar(7, 119, 119, 113, 114);
    const d = decideStep({ bars, i: 7, position: p2, params: P });
    assert.equal(d.action, 'close');
    assert.equal(d.exit, 114);          // 120 - 3*2
    assert.equal(d.win, true);          // 114 > entry 100
  });

  it('closes a loser at the initial stop', () => {
    const bars = base(8); bars[7] = bar(7, 99, 99, 95, 95.5);
    const d = decideStep({ bars, i: 7, position: pos, params: P });
    assert.equal(d.action, 'close');
    assert.equal(d.exit, 96);
    assert.equal(d.win, false);
  });
});

describe('regime gate (efficiency ratio)', () => {
  it('ER ~1 for a clean trend, ~0 for chop', () => {
    const trend = Array.from({ length: 11 }, (_, i) => bar(i, 100 + i, 100 + i, 100 + i, 100 + i));
    assert.ok(efficiencyRatio(trend, 10, 10) > 0.95);
    const chop = Array.from({ length: 11 }, (_, i) => bar(i, 100, 100, 100, i % 2 ? 101 : 100));
    assert.ok(efficiencyRatio(chop, 10, 10) < 0.3);
  });

  it('skips a breakout when the regime is choppy', () => {
    const G = { don: 5, atrN: 3, atrMult: 2, trail: 3, regimeN: 6, erMin: 0.35 };
    // oscillating series (low ER) that still prints a breakout close on the last bar
    const bars = Array.from({ length: 9 }, (_, i) => bar(i, 100, 100.6, 99.4, i % 2 ? 100.5 : 99.6));
    bars[8] = bar(8, 100, 101.2, 99.5, 101);   // breaks prior high but chop regime
    const d = decideStep({ bars, i: 8, position: null, params: G });
    assert.equal(d.action, 'flat');
    assert.equal(d.regime, 'chop');
  });
});

describe('tradeNetR', () => {
  it('a +2R winner nets below 2R after taker fee + slip', () => {
    // risk = atrMult(2)·atrAtEntry(2) = 4; exit +8 from entry = +2R gross.
    const { grossR, netR } = tradeNetR({ dir: 'long', entry: 100, exit: 108, atrAtEntry: 2 });
    assert.ok(grossR > 1.9 && grossR <= 2.0);  // slip shaves a hair off 2.0
    assert.ok(netR < grossR);                  // fee drag
  });
});
