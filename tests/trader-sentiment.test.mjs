import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _resolveLabel } from '../trader-sentiment.mjs';

describe('_resolveLabel', () => {
  it('maps numeric ≤ 2.5 to bear', () => {
    assert.equal(_resolveLabel(1.0), 'bear');
    assert.equal(_resolveLabel(2.5), 'bear');
  });
  it('maps numeric ≥ 3.5 to bull', () => {
    assert.equal(_resolveLabel(3.5), 'bull');
    assert.equal(_resolveLabel(5.0), 'bull');
  });
  it('maps numeric strictly between 2.5 and 3.5 to neutral', () => {
    assert.equal(_resolveLabel(3.0), 'neutral');
    assert.equal(_resolveLabel(2.51), 'neutral');
    assert.equal(_resolveLabel(3.49), 'neutral');
  });
  it('returns null on non-finite / out-of-range input', () => {
    assert.equal(_resolveLabel(null), null);
    assert.equal(_resolveLabel(NaN), null);
    assert.equal(_resolveLabel('bull'), null);
    assert.equal(_resolveLabel(0.5), null);
    assert.equal(_resolveLabel(5.5), null);
  });
});
