import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trendSignalRecord, buildTrendHealth } from '../trend-shadow.mjs';

const openStep = { action: 'open', dir: 'long', entry: 150.2, initialStop: 147.0, atrAtEntry: 1.6 };

test('trend signal record: open step becomes entry, preserves levels + tags lane', () => {
  const r = trendSignalRecord({ now: 1000, d: openStep, barTs: 900, symbol: 'SOL_USDT', dryRun: true });
  assert.equal(r.decision, 'entry');
  assert.equal(r.symbol, 'SOL_USDT');
  assert.equal(r.dir, 'long');
  assert.equal(r.entry, 150.2);
  assert.equal(r.stop, 147.0);
  assert.equal(r.atr, 1.6);
  assert.equal(r.tp, undefined);            // trend trails — no fixed TP
  assert.equal(r.dryRun, true);
  assert.equal(r.barTs, 900);
  assert.equal(r.ts, 1000);
  assert.equal(r.strategy, 'trend-trail-4h');
});

test('trend signal record: close step becomes exit, carries exit + win', () => {
  const r = trendSignalRecord({ now: 2000, d: { action: 'close', exit: 158.4, win: true }, barTs: 1900, symbol: 'XRP_USDT', dryRun: false });
  assert.equal(r.decision, 'exit');
  assert.equal(r.exit, 158.4);
  assert.equal(r.win, true);
  assert.equal(r.symbol, 'XRP_USDT');
  assert.equal(r.strategy, 'trend-trail-4h');
});

test('trend signal record: exit carries modeled netR when provided (fee drag)', () => {
  const r = trendSignalRecord({ now: 2000, d: { action: 'close', exit: 158.4, win: true }, barTs: 1900, symbol: 'XRP_USDT', netR: 1.23 });
  assert.equal(r.netR, 1.23);
  // netR only attaches to exits, and only when supplied
  assert.equal(trendSignalRecord({ now: 1, d: { action: 'close', exit: 1, win: false }, barTs: 0, symbol: 'S' }).netR, undefined);
  assert.equal(trendSignalRecord({ now: 1, d: openStep, barTs: 0, symbol: 'S', netR: 9 }).netR, undefined);
});

test('trend signal record: chop-gated breakout becomes skip with reason, no levels', () => {
  const r = trendSignalRecord({ now: 3000, d: { action: 'flat', regime: 'chop' }, barTs: 2900, symbol: 'ADA_USDT', dryRun: true });
  assert.equal(r.decision, 'skip');
  assert.equal(r.reason, 'chop');
  assert.equal(r.entry, undefined);
});

test('trend signal record: non-noteworthy steps return null', () => {
  assert.equal(trendSignalRecord({ now: 1, d: { action: 'hold', stop: 100 }, barTs: 0, symbol: 'SOL_USDT' }), null);
  assert.equal(trendSignalRecord({ now: 1, d: { action: 'flat' }, barTs: 0, symbol: 'SOL_USDT' }), null);
  assert.equal(trendSignalRecord({ now: 1, d: { action: 'wait' }, barTs: 0, symbol: 'SOL_USDT' }), null);
});

test('trend signal record: dryRun flag reflects live vs shadow', () => {
  assert.equal(trendSignalRecord({ now: 1, d: openStep, barTs: 0, symbol: 'S', dryRun: false }).dryRun, false);
  assert.equal(trendSignalRecord({ now: 1, d: openStep, barTs: 0, symbol: 'S' }).dryRun, false);
  assert.equal(trendSignalRecord({ now: 1, d: openStep, barTs: 0, symbol: 'S', dryRun: 1 }).dryRun, true);
});

test('health snapshot: carries liveness + state, coerces flags', () => {
  const h = buildTrendHealth({
    now: 5000, cycleCount: 12, dryRun: 1, killed: 0,
    basket: ['SOL_USDT', 'XRP_USDT'],
    positions: ['XRP_USDT'],
    cooldowns: { ADA_USDT: 9999 },
  });
  assert.equal(h.ts, 5000);
  assert.equal(h.lastCycleAt, 5000);
  assert.equal(h.cycleCount, 12);
  assert.equal(h.dryRun, true);
  assert.equal(h.killed, false);
  assert.equal(h.strategy, 'trend-trail-4h');
  assert.deepEqual(h.basket, ['SOL_USDT', 'XRP_USDT']);
  assert.deepEqual(h.positions, ['XRP_USDT']);
  assert.deepEqual(h.cooldowns, { ADA_USDT: 9999 });
});

test('health snapshot: defaults cooldowns to empty object', () => {
  assert.deepEqual(buildTrendHealth({ now: 1, cycleCount: 0, basket: [], positions: [] }).cooldowns, {});
});
