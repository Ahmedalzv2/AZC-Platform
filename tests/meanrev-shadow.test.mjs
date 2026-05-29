import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shadowSignalRecord } from '../meanrev-shadow.mjs';

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
