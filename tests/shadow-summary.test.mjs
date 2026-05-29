import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeShadowSignals } from '../shadow-summary.mjs';

describe('summarizeShadowSignals', () => {
  test('empty stream → zeroed summary, null last', () => {
    const s = summarizeShadowSignals([]);
    assert.deepEqual(s, { count: 0, entries: 0, exits: 0, skips: 0, wins: 0, losses: 0, netRSum: 0, lastTs: null, last: null });
  });

  test('counts decisions and tallies wins/losses from exits', () => {
    const s = summarizeShadowSignals([
      { ts: 1, decision: 'entry', symbol: 'SOL_USDT', dir: 'long' },
      { ts: 2, decision: 'skip', symbol: 'XRP_USDT', reason: 'chop' },
      { ts: 3, decision: 'exit', symbol: 'SOL_USDT', win: true, netR: 1.5 },
      { ts: 4, decision: 'exit', symbol: 'XRP_USDT', win: false, netR: -1.02 },
    ]);
    assert.equal(s.count, 4);
    assert.equal(s.entries, 1);
    assert.equal(s.skips, 1);
    assert.equal(s.exits, 2);
    assert.equal(s.wins, 1);
    assert.equal(s.losses, 1);
  });

  test('netRSum adds only exits carrying netR, rounded to 3dp', () => {
    const s = summarizeShadowSignals([
      { ts: 1, decision: 'exit', win: true, netR: 1.5 },
      { ts: 2, decision: 'exit', win: false, netR: -1.024 },
      { ts: 3, decision: 'exit', win: false },          // mean-rev style: no netR
      { ts: 4, decision: 'entry', netR: 99 },           // netR ignored off non-exits
    ]);
    assert.equal(s.netRSum, 0.476);
  });

  test('lastTs is the max ts; last is that record summary', () => {
    const s = summarizeShadowSignals([
      { ts: 30, decision: 'entry', symbol: 'A', dir: 'short' },
      { ts: 10, decision: 'skip', symbol: 'B', reason: 'chop' },
    ]);
    assert.equal(s.lastTs, 30);
    assert.deepEqual(s.last, { ts: 30, decision: 'entry', symbol: 'A', dir: 'short' });
  });

  test('last carries reason for a skip, omits absent fields', () => {
    const s = summarizeShadowSignals([{ ts: 5, decision: 'skip', symbol: 'B', reason: 'chop' }]);
    assert.deepEqual(s.last, { ts: 5, decision: 'skip', symbol: 'B', reason: 'chop' });
  });
});
