import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideGate, groupBySession } from '../trader-drift-gate.mjs';

const T = { minSample: 20, downshiftR: -0.10, blockR: -0.30 };

describe('decideGate', () => {
  it('stays enabled below min sample regardless of expR', () => {
    const r = decideGate({ total: 5, expectancyR: -1.5 }, T);
    assert.equal(r.status, 'enabled');
    assert.match(r.reason, /below min sample/);
  });

  it('blocks once expR drops below blockR after min sample', () => {
    const r = decideGate({ total: 20, expectancyR: -0.31 }, T);
    assert.equal(r.status, 'blocked');
    assert.match(r.reason, /block threshold/);
  });

  it('downshifts in the band between downshiftR and blockR', () => {
    const r = decideGate({ total: 25, expectancyR: -0.15 }, T);
    assert.equal(r.status, 'downshifted');
    assert.match(r.reason, /halving risk/);
  });

  it('stays enabled above downshiftR after min sample', () => {
    const r = decideGate({ total: 25, expectancyR: 0.18 }, T);
    assert.equal(r.status, 'enabled');
    assert.match(r.reason, /\+0\.180R\/trade/);
  });

  it('handles missing inputs by defaulting to total=0 expR=null', () => {
    const r = decideGate(undefined, T);
    assert.equal(r.status, 'enabled');
    assert.equal(r.n, 0);
  });
});

describe('groupBySession', () => {
  it('buckets trades by session label', () => {
    const trades = [
      { session: 'asia',   rMultiple: -1 },
      { session: 'asia',   rMultiple: -1 },
      { session: 'london', rMultiple:  2 },
    ];
    const g = groupBySession(trades);
    assert.equal(g.asia.length, 2);
    assert.equal(g.london.length, 1);
  });

  it("falls back to 'off' when session is missing or 'no-killzone'", () => {
    const trades = [
      { session: null },
      { session: 'no-killzone' },
      { /* no session field */ },
    ];
    const g = groupBySession(trades);
    assert.equal(g.off.length, 3);
  });
});
