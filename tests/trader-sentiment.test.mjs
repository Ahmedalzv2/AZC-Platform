import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _resolveLabel, _newsFetcher, getSentiment } from '../trader-sentiment.mjs';

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

describe('_newsFetcher', () => {
  const stubLcResponse = (items) => ({ data: items });
  const fakeFetch = (response, status = 200) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
  });

  it('averages last 10 headlines and resolves to a label', async () => {
    const env = { LUNARCRUSH_API_KEY: 'k' };
    // 10 headlines averaging 4.0 → bull
    const items = Array.from({ length: 10 }, (_, i) => ({
      post_title: `h${i}`, post_created: 1779950000 - i * 60, post_sentiment: 4.0,
    }));
    const fetchFn = fakeFetch(stubLcResponse(items));
    const r = await _newsFetcher({ ticker: 'SOL', env, signal: new AbortController().signal, fetchFn, now: 1779950000 * 1000 });
    assert.equal(r.label, 'bull');
    assert.equal(r.source, 'news');
  });

  it('returns null when no headlines have numeric sentiment', async () => {
    const env = { LUNARCRUSH_API_KEY: 'k' };
    const items = [{ post_title: 'x', post_created: 1779950000, post_sentiment: null }];
    const r = await _newsFetcher({ ticker: 'SOL', env, signal: new AbortController().signal, fetchFn: fakeFetch(stubLcResponse(items)), now: 1779950000 * 1000 });
    assert.equal(r, null);
  });

  it('returns null on non-2xx', async () => {
    const env = { LUNARCRUSH_API_KEY: 'k' };
    const r = await _newsFetcher({ ticker: 'SOL', env, signal: new AbortController().signal, fetchFn: fakeFetch({}, 500) });
    assert.equal(r, null);
  });
});

describe('getSentiment — no key', () => {
  it('returns null when LUNARCRUSH_API_KEY is missing', async () => {
    const r = await getSentiment({ ticker: 'SOL', env: {}, now: 1779950000000 });
    assert.equal(r, null);
  });
});

import { _topicFetcher } from '../trader-sentiment.mjs';
import { readFile } from 'node:fs/promises';

const loadFixture = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

describe('_topicFetcher', () => {
  const fakeFetch = (response, status = 200) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
  });

  it('averages types_sentiment buckets and resolves to a label', async () => {
    const fixture = await loadFixture('lc-topic-sol.json');
    const r = await _topicFetcher({
      ticker: 'SOL', env: { LUNARCRUSH_API_KEY: 'k' },
      signal: new AbortController().signal, fetchFn: fakeFetch(fixture),
    });
    assert.equal(r.label, 'bull');     // mean ≈ 3.95
    assert.equal(r.source, 'topic');
  });

  it('returns null when types_sentiment is missing/empty', async () => {
    const r1 = await _topicFetcher({
      ticker: 'SOL', env: { LUNARCRUSH_API_KEY: 'k' },
      signal: new AbortController().signal, fetchFn: fakeFetch({ data: {} }),
    });
    const r2 = await _topicFetcher({
      ticker: 'SOL', env: { LUNARCRUSH_API_KEY: 'k' },
      signal: new AbortController().signal, fetchFn: fakeFetch({ data: { types_sentiment: {} } }),
    });
    assert.equal(r1, null);
    assert.equal(r2, null);
  });

  it('ignores non-numeric bucket values', async () => {
    const r = await _topicFetcher({
      ticker: 'SOL', env: { LUNARCRUSH_API_KEY: 'k' },
      signal: new AbortController().signal,
      fetchFn: fakeFetch({ data: { types_sentiment: { tweet: 'n/a', news: 4.0 } } }),
    });
    assert.equal(r.label, 'bull');
    assert.equal(r.source, 'topic');
  });

  it('returns null on non-2xx', async () => {
    const r = await _topicFetcher({
      ticker: 'SOL', env: { LUNARCRUSH_API_KEY: 'k' },
      signal: new AbortController().signal, fetchFn: fakeFetch({}, 500),
    });
    assert.equal(r, null);
  });
});
