import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { neweyWestTStat, autoLag } from '../nw-tstat.mjs';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

describe('neweyWestTStat — Bartlett-kernel HAC mean t-stat', () => {
  // Hand-computed on x=[1,2,3,4]: mean 2.5, e=[-1.5,-0.5,.5,1.5], g0=1.25,
  // g1=0.3125, Bartlett w1=0.5 -> S=1.25+2*0.5*0.3125=1.5625, Var=S/4=0.390625,
  // seHac=0.625, tHac=4.0.
  test('maxlags=1 matches hand calc', () => {
    const r = neweyWestTStat([1, 2, 3, 4], 1);
    assert.ok(close(r.mean, 2.5), `mean ${r.mean}`);
    assert.ok(close(r.seHac, 0.625), `seHac ${r.seHac}`);
    assert.ok(close(r.tHac, 4.0), `tHac ${r.tHac}`);
    assert.equal(r.lags, 1);
    assert.equal(r.n, 4);
  });

  // maxlags=0 collapses to the long-run var = g0; seHac=sqrt(g0/n)=sqrt(1.25/4).
  test('maxlags=0 collapses to g0/n (no autocovariance terms)', () => {
    const r = neweyWestTStat([1, 2, 3, 4], 0);
    assert.ok(close(r.seHac, Math.sqrt(1.25 / 4)), `seHac ${r.seHac}`);
  });

  // iid SE uses sample variance s^2/(n) with n-1 denom: s^2=5/3, se=sqrt(5/3/4).
  test('reports iid SE/t alongside HAC for comparison', () => {
    const r = neweyWestTStat([1, 2, 3, 4], 1);
    assert.ok(close(r.seIid, Math.sqrt((5 / 3) / 4)), `seIid ${r.seIid}`);
    assert.ok(close(r.tIid, 2.5 / Math.sqrt((5 / 3) / 4)), `tIid ${r.tIid}`);
  });

  test('mean=0 series gives t≈0, not NaN', () => {
    const r = neweyWestTStat([-1, 1, -1, 1, -1, 1], 2);
    assert.ok(Math.abs(r.tHac) < 1e-9, `tHac ${r.tHac}`);
  });

  test('degenerate inputs are safe', () => {
    assert.equal(neweyWestTStat([], 3).n, 0);
    const one = neweyWestTStat([5], 3);
    assert.equal(one.n, 1);
    assert.ok(Number.isFinite(one.mean));
  });
});

describe('autoLag — Newey-West rule of thumb floor(4*(n/100)^(2/9))', () => {
  test('matches the standard plug-in for sample sizes', () => {
    assert.equal(autoLag(100), 4);
    assert.equal(autoLag(1), 0);     // tiny sample -> 0 (clamped)
    assert.equal(autoLag(600), Math.floor(4 * Math.pow(6, 2 / 9)));
  });
});
