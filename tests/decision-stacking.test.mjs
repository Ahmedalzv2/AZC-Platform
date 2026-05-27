import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('_groupDecisions', () => {
  test('collapses consecutive same-veto skips into one group', () => {
    const { app } = loadApp();
    const events = [
      { ts: 5000, kind: 'decision', action: 'skip', vetoed_by: 'no-candidates', reason: null },
      { ts: 4000, kind: 'decision', action: 'skip', vetoed_by: 'no-candidates', reason: null },
      { ts: 3000, kind: 'decision', action: 'skip', vetoed_by: 'no-candidates', reason: null },
    ];
    const groups = app._groupDecisions(events);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 3);
    assert.equal(groups[0].newestTs, 5000);
    assert.equal(groups[0].oldestTs, 3000);
    assert.equal(groups[0].vetoed_by, 'no-candidates');
  });

  test('does not stack skips across different vetoed_by values', () => {
    const { app } = loadApp();
    const events = [
      { ts: 5000, kind: 'decision', action: 'skip', vetoed_by: 'side-gate' },
      { ts: 4000, kind: 'decision', action: 'skip', vetoed_by: 'no-candidates' },
      { ts: 3000, kind: 'decision', action: 'skip', vetoed_by: 'no-candidates' },
    ];
    const groups = app._groupDecisions(events);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].vetoed_by, 'side-gate');
    assert.equal(groups[0].count, 1);
    assert.equal(groups[1].vetoed_by, 'no-candidates');
    assert.equal(groups[1].count, 2);
  });

  test('never stacks fires — each is its own row even with identical symbols', () => {
    const { app } = loadApp();
    const events = [
      { ts: 5000, kind: 'decision', action: 'fire', vetoed_by: null, symbol: 'SOL_USDT', entry: 145.23 },
      { ts: 4000, kind: 'decision', action: 'fire', vetoed_by: null, symbol: 'SOL_USDT', entry: 144.10 },
    ];
    const groups = app._groupDecisions(events);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].count, 1);
    assert.equal(groups[1].count, 1);
  });

  test('does not stack a fire onto an adjacent skip', () => {
    const { app } = loadApp();
    const events = [
      { ts: 5000, kind: 'decision', action: 'skip', vetoed_by: 'no-candidates' },
      { ts: 4000, kind: 'decision', action: 'fire', vetoed_by: null, symbol: 'SOL_USDT', entry: 145.23 },
      { ts: 3000, kind: 'decision', action: 'skip', vetoed_by: 'no-candidates' },
    ];
    const groups = app._groupDecisions(events);
    assert.equal(groups.length, 3);
    assert.equal(groups[0].action, 'skip');
    assert.equal(groups[1].action, 'fire');
    assert.equal(groups[2].action, 'skip');
  });

  test('drops the reason when stacked rows have mismatched reasons', () => {
    const { app } = loadApp();
    const events = [
      { ts: 5000, kind: 'decision', action: 'skip', vetoed_by: 'side-gate', reason: 'LONG -0.42R/trade' },
      { ts: 4000, kind: 'decision', action: 'skip', vetoed_by: 'side-gate', reason: 'LONG -0.51R/trade' },
    ];
    const groups = app._groupDecisions(events);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 2);
    assert.equal(groups[0].reason, null);
  });

  test('keeps the reason when stacked rows share it', () => {
    const { app } = loadApp();
    const events = [
      { ts: 5000, kind: 'decision', action: 'skip', vetoed_by: 'side-gate', reason: 'LONG blocked' },
      { ts: 4000, kind: 'decision', action: 'skip', vetoed_by: 'side-gate', reason: 'LONG blocked' },
    ];
    const groups = app._groupDecisions(events);
    assert.equal(groups[0].reason, 'LONG blocked');
  });

  test('handles an empty input cleanly', () => {
    const { app } = loadApp();
    const groups = app._groupDecisions([]);
    assert.equal(groups.length, 0);
  });

  test('treats null vetoed_by as a distinct group key', () => {
    // Belt + braces: a fire has vetoed_by = null and action = "fire", so it
    // already cannot stack on a skip. But if a malformed event ever showed
    // up with action="skip" + vetoed_by=null, the grouper must still merge
    // those into one row (matching value, not coerced).
    const { app } = loadApp();
    const events = [
      { ts: 5000, kind: 'decision', action: 'skip', vetoed_by: null },
      { ts: 4000, kind: 'decision', action: 'skip', vetoed_by: null },
    ];
    const groups = app._groupDecisions(events);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 2);
  });
});
