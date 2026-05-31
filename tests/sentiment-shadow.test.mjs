import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sentimentDisagrees, sentimentShadow, _clearCache } from '../trader-sentiment.mjs';
import { trendSignalRecord } from '../trend-shadow.mjs';
import { shadowSignalRecord } from '../meanrev-shadow.mjs';

describe('sentimentDisagrees', () => {
  it('flags an opposing explicit label (long vs bear, short vs bull)', () => {
    assert.equal(sentimentDisagrees('long', 'bear'), true);
    assert.equal(sentimentDisagrees('short', 'bull'), true);
    assert.equal(sentimentDisagrees('bull', 'bear'), true);   // dir may also arrive as bull/bear
    assert.equal(sentimentDisagrees('bear', 'bull'), true);
  });
  it('agrees when label points the same way', () => {
    assert.equal(sentimentDisagrees('long', 'bull'), false);
    assert.equal(sentimentDisagrees('short', 'bear'), false);
  });
  it('fails open on neutral / null / unknown', () => {
    assert.equal(sentimentDisagrees('long', 'neutral'), false);
    assert.equal(sentimentDisagrees('long', null), false);
    assert.equal(sentimentDisagrees('long', undefined), false);
  });
});

describe('sentimentShadow', () => {
  it('returns {available:false} with no key (fail-open, never throws)', async () => {
    const r = await sentimentShadow({ ticker: 'SOL', dir: 'long', env: {} });
    assert.deepEqual(r, { available: false });
  });

  it('annotates label/source and computes wouldSkip on disagreement', async () => {
    _clearCache();
    const fetchFn = async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { types_sentiment: { tweet: 1.5 } } }),   // bear
    });
    const r = await sentimentShadow({
      ticker: 'SOL', dir: 'long', env: { LUNARCRUSH_API_KEY: 'k' },
      fetchFn, now: 1779950000000,
    });
    assert.equal(r.available, true);
    assert.equal(r.label, 'bear');
    assert.equal(r.source, 'topic');
    assert.equal(r.wouldSkip, true);    // long setup vs bear sentiment
  });

  it('wouldSkip false when sentiment agrees', async () => {
    _clearCache();
    const fetchFn = async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { types_sentiment: { tweet: 4.0 } } }),   // bull
    });
    const r = await sentimentShadow({
      ticker: 'SOL', dir: 'long', env: { LUNARCRUSH_API_KEY: 'k' },
      fetchFn, now: 1779950000000,
    });
    assert.equal(r.available, true);
    assert.equal(r.label, 'bull');
    assert.equal(r.wouldSkip, false);
  });
});

describe('record builders attach sentiment', () => {
  it('trendSignalRecord attaches sentiment to an entry', () => {
    const d = { action: 'open', dir: 'long', entry: 1.0, initialStop: 0.9, atrAtEntry: 0.05 };
    const sentiment = { available: true, label: 'bear', source: 'topic', wouldSkip: true };
    const r = trendSignalRecord({ now: 1, d, barTs: 0, symbol: 'SOL_USDT', dryRun: true, sentiment });
    assert.equal(r.decision, 'entry');
    assert.deepEqual(r.sentiment, sentiment);
  });
  it('trendSignalRecord omits sentiment when not provided', () => {
    const d = { action: 'open', dir: 'long', entry: 1.0, initialStop: 0.9, atrAtEntry: 0.05 };
    const r = trendSignalRecord({ now: 1, d, barTs: 0, symbol: 'SOL_USDT', dryRun: true });
    assert.equal('sentiment' in r, false);
  });
  it('shadowSignalRecord attaches sentiment to an entry', () => {
    const plan = { symbol: 'SOL_USDT', dir: 'long', entry: 150, stop: 147, tp: 154, qty: 3, riskUsd: 0.5, atr: 1.6 };
    const sentiment = { available: true, label: 'bull', source: 'news', wouldSkip: false };
    const r = shadowSignalRecord({ now: 1, plan, barTs: 0, dryRun: true, sentiment });
    assert.equal(r.decision, 'entry');
    assert.deepEqual(r.sentiment, sentiment);
  });
});
