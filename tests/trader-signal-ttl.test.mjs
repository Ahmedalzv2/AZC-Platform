import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkPostOnlyTtlFill } from '../trader-signal.mjs';

const bull = (entry) => ({ dir: 'bull', entry });
const bear = (entry) => ({ dir: 'bear', entry });
const bar  = (l, h)  => ({ l, h, o: (l + h) / 2, c: (l + h) / 2, t: 0 });

describe('checkPostOnlyTtlFill — POST_ONLY validity', () => {
  it('bull rejects when fire bar close is below entry (limit-above-market)', () => {
    const r = checkPostOnlyTtlFill({
      ...bull(100), fireBarClose: 99.5,
      futureBars: [bar(99, 101)], ttlBars: 1,
    });
    assert.equal(r.filled, false);
    assert.equal(r.reason, 'post-only-wrong-side');
  });

  it('bear rejects when fire bar close is above entry (limit-below-market)', () => {
    const r = checkPostOnlyTtlFill({
      ...bear(100), fireBarClose: 100.5,
      futureBars: [bar(99, 101)], ttlBars: 1,
    });
    assert.equal(r.filled, false);
    assert.equal(r.reason, 'post-only-wrong-side');
  });

  it('bull accepts when fire bar close equals entry exactly', () => {
    const r = checkPostOnlyTtlFill({
      ...bull(100), fireBarClose: 100,
      futureBars: [bar(99, 101)], ttlBars: 1,
    });
    assert.equal(r.filled, true);
    assert.equal(r.fillBarOffset, 1);
  });

  it('bear accepts when fire bar close equals entry exactly', () => {
    const r = checkPostOnlyTtlFill({
      ...bear(100), fireBarClose: 100,
      futureBars: [bar(99, 101)], ttlBars: 1,
    });
    assert.equal(r.filled, true);
  });
});

describe('checkPostOnlyTtlFill — TTL fill gate', () => {
  it('bull fills when bar 1 low touches entry', () => {
    const r = checkPostOnlyTtlFill({
      ...bull(100), fireBarClose: 100.5,
      futureBars: [bar(99.9, 101)], ttlBars: 1,
    });
    assert.equal(r.filled, true);
    assert.equal(r.fillBarOffset, 1);
    assert.equal(r.reason, 'filled');
  });

  it('bull TTL-cancels when bar 1 low stays above entry', () => {
    const r = checkPostOnlyTtlFill({
      ...bull(100), fireBarClose: 100.5,
      futureBars: [bar(100.2, 101)], ttlBars: 1,
    });
    assert.equal(r.filled, false);
    assert.equal(r.reason, 'ttl-cancel');
  });

  it('bear fills when bar 1 high reaches entry', () => {
    const r = checkPostOnlyTtlFill({
      ...bear(100), fireBarClose: 99.5,
      futureBars: [bar(99, 100.1)], ttlBars: 1,
    });
    assert.equal(r.filled, true);
    assert.equal(r.fillBarOffset, 1);
  });

  it('bear TTL-cancels when bar 1 high stays below entry', () => {
    const r = checkPostOnlyTtlFill({
      ...bear(100), fireBarClose: 99.5,
      futureBars: [bar(99, 99.8)], ttlBars: 1,
    });
    assert.equal(r.filled, false);
    assert.equal(r.reason, 'ttl-cancel');
  });

  it('ttlBars=3 finds a later fill bar', () => {
    const r = checkPostOnlyTtlFill({
      ...bull(100), fireBarClose: 100.5,
      futureBars: [bar(100.4, 101), bar(100.3, 101), bar(99.5, 101)],
      ttlBars: 3,
    });
    assert.equal(r.filled, true);
    assert.equal(r.fillBarOffset, 3);
  });

  it('returns ttl-cancel when futureBars is empty', () => {
    const r = checkPostOnlyTtlFill({
      ...bull(100), fireBarClose: 100, futureBars: [], ttlBars: 5,
    });
    assert.equal(r.filled, false);
    assert.equal(r.reason, 'ttl-cancel');
  });

  it('stops searching at ttlBars even if more futureBars are provided', () => {
    const r = checkPostOnlyTtlFill({
      ...bull(100), fireBarClose: 100.5,
      futureBars: [bar(100.4, 101), bar(99, 101)],
      ttlBars: 1,
    });
    assert.equal(r.filled, false);
    assert.equal(r.reason, 'ttl-cancel');
  });

  it('rejects invalid entry (NaN/Infinity)', () => {
    const r = checkPostOnlyTtlFill({
      dir: 'bull', entry: NaN, fireBarClose: 100,
      futureBars: [bar(99, 101)], ttlBars: 1,
    });
    assert.equal(r.filled, false);
    assert.equal(r.reason, 'invalid-entry');
  });
});
