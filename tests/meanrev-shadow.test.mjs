import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shadowSignalRecord, buildMeanRevHealth } from '../meanrev-shadow.mjs';

const entryPlan = {
  symbol: 'SOL_USDT', dir: 'long',
  sideOpen: 1, sideClose: 4,
  entry: 150.2, stop: 147.0, tp: 154.0, qty: 3,
  riskUsd: 0.5, atr: 1.6,
};

test('shadow signal record: entry plan preserves levels + tags lane', () => {
  const r = shadowSignalRecord({ now: 1000, plan: entryPlan, barTs: 900, dryRun: true });
  assert.equal(r.decision, 'entry');
  assert.equal(r.symbol, 'SOL_USDT');
  assert.equal(r.dir, 'long');
  assert.equal(r.entry, 150.2);
  assert.equal(r.stop, 147.0);
  assert.equal(r.tp, 154.0);
  assert.equal(r.qty, 3);
  assert.equal(r.dryRun, true);
  assert.equal(r.barTs, 900);
  assert.equal(r.ts, 1000);
  assert.equal(r.strategy, 'meanrev-4h-fade');
});

test('shadow signal record: skip plan carries reason, no levels', () => {
  const r = shadowSignalRecord({ now: 2000, plan: { symbol: 'XRP_USDT', skip: 'unsized' }, barTs: 1900, dryRun: false });
  assert.equal(r.decision, 'skip');
  assert.equal(r.reason, 'unsized');
  assert.equal(r.symbol, 'XRP_USDT');
  assert.equal(r.dryRun, false);
  assert.equal(r.entry, undefined);
});

test('shadow signal record: dryRun flag reflects live vs shadow', () => {
  assert.equal(shadowSignalRecord({ now: 1, plan: entryPlan, barTs: 0, dryRun: false }).dryRun, false);
  assert.equal(shadowSignalRecord({ now: 1, plan: entryPlan, barTs: 0 }).dryRun, false);
  assert.equal(shadowSignalRecord({ now: 1, plan: entryPlan, barTs: 0, dryRun: 1 }).dryRun, true);
});

test('health snapshot: carries liveness + state, coerces flags', () => {
  const h = buildMeanRevHealth({
    now: 5000, cycleCount: 12, dryRun: 1, killed: 0,
    basket: ['SOL_USDT', 'XRP_USDT'],
    pending: ['SOL_USDT'], positions: ['XRP_USDT'],
    cooldowns: { ADA_USDT: 9999 },
  });
  assert.equal(h.ts, 5000);
  assert.equal(h.lastCycleAt, 5000);
  assert.equal(h.cycleCount, 12);
  assert.equal(h.dryRun, true);
  assert.equal(h.killed, false);
  assert.equal(h.strategy, 'meanrev-4h-fade');
  assert.deepEqual(h.basket, ['SOL_USDT', 'XRP_USDT']);
  assert.deepEqual(h.pending, ['SOL_USDT']);
  assert.deepEqual(h.positions, ['XRP_USDT']);
  assert.deepEqual(h.cooldowns, { ADA_USDT: 9999 });
});

test('health snapshot: defaults cooldowns to empty object', () => {
  assert.deepEqual(buildMeanRevHealth({ now: 1, cycleCount: 0, basket: [], pending: [], positions: [] }).cooldowns, {});
});
