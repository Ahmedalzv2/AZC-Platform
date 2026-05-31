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

import { _topicFetcher, _clearCache } from '../trader-sentiment.mjs';
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

describe('getSentiment — cache', () => {
  it('serves a second call within TTL from cache', async () => {
    _clearCache();
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ data: { types_sentiment: { tweet: 4.0 } } }) };
    };
    const env = { LUNARCRUSH_API_KEY: 'k' };
    const t0 = 1779950000000;
    const a = await getSentiment({ ticker: 'SOL', env, now: t0, fetchFn });
    const b = await getSentiment({ ticker: 'SOL', env, now: t0 + 10_000, fetchFn });
    assert.equal(a.label, 'bull');
    assert.deepEqual(b, a);
    assert.equal(calls, 1);
  });

  it('re-fetches after TTL expiry', async () => {
    _clearCache();
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ data: { types_sentiment: { tweet: 4.0 } } }) };
    };
    const env = { LUNARCRUSH_API_KEY: 'k' };
    const t0 = 1779950000000;
    await getSentiment({ ticker: 'SOL', env, now: t0, fetchFn });
    await getSentiment({ ticker: 'SOL', env, now: t0 + 15 * 60 * 1000 + 1, fetchFn });
    assert.equal(calls, 2);
  });

  it('does NOT cache a null result', async () => {
    _clearCache();
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const env = { LUNARCRUSH_API_KEY: 'k' };
    const t0 = 1779950000000;
    const a = await getSentiment({ ticker: 'SOL', env, now: t0, fetchFn });
    const b = await getSentiment({ ticker: 'SOL', env, now: t0 + 100, fetchFn });
    assert.equal(a, null);
    assert.equal(b, null);
    assert.equal(calls, 4);    // not 2 — null was not cached; 2 getSentiment calls × 2 fetchers each
  });
});

describe('getSentiment — timeout', () => {
  it('returns null within ~2s when fetch hangs', async () => {
    _clearCache();
    const fetchFn = async (_url, opts) =>
      new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        setTimeout(() => reject(new Error('never reached')), 10_000);
      });
    const env = { LUNARCRUSH_API_KEY: 'k' };
    const start = Date.now();
    const r = await getSentiment({ ticker: 'SOL', env, fetchFn, timeoutMs: 50 });
    assert.equal(r, null);
    assert.ok(Date.now() - start < 500, 'must short-circuit on timeout');
  });
});

import { _cryptoPanicFetcher } from '../trader-sentiment.mjs';

describe('_cryptoPanicFetcher', () => {
  const okFetch = (results) => async () => ({ ok: true, status: 200, json: async () => ({ results }) });
  const now = 1779950000000;
  const recent = new Date(now - 3600_000).toISOString();
  const stale = new Date(now - 48 * 3600_000).toISOString();

  it('returns null with no token', async () => {
    const r = await _cryptoPanicFetcher({ ticker: 'SOL', env: {}, signal: new AbortController().signal, fetchFn: okFetch([]) });
    assert.equal(r, null);
  });

  it('leans bull when positive votes dominate recent posts', async () => {
    const results = [
      { published_at: recent, votes: { positive: 8, negative: 1 } },
      { published_at: recent, votes: { positive: 5, negative: 2 } },
    ];
    const r = await _cryptoPanicFetcher({ ticker: 'SOL', env: { CRYPTOPANIC_AUTH_TOKEN: 't' }, signal: new AbortController().signal, fetchFn: okFetch(results), now });
    assert.equal(r.label, 'bull');
    assert.equal(r.source, 'cryptopanic');
  });

  it('leans bear when negative votes dominate', async () => {
    const results = [{ published_at: recent, votes: { positive: 1, negative: 9 } }];
    const r = await _cryptoPanicFetcher({ ticker: 'SOL', env: { CRYPTOPANIC_AUTH_TOKEN: 't' }, signal: new AbortController().signal, fetchFn: okFetch(results), now });
    assert.equal(r.label, 'bear');
  });

  it('ignores posts outside the 24h window', async () => {
    const results = [{ published_at: stale, votes: { positive: 50, negative: 0 } }];
    const r = await _cryptoPanicFetcher({ ticker: 'SOL', env: { CRYPTOPANIC_AUTH_TOKEN: 't' }, signal: new AbortController().signal, fetchFn: okFetch(results), now });
    assert.equal(r, null);
  });

  it('returns null when no recent post carries votes', async () => {
    const results = [{ published_at: recent, votes: { positive: 0, negative: 0 } }];
    const r = await _cryptoPanicFetcher({ ticker: 'SOL', env: { CRYPTOPANIC_AUTH_TOKEN: 't' }, signal: new AbortController().signal, fetchFn: okFetch(results), now });
    assert.equal(r, null);
  });

  it('returns null on non-2xx', async () => {
    const r = await _cryptoPanicFetcher({ ticker: 'SOL', env: { CRYPTOPANIC_AUTH_TOKEN: 't' }, signal: new AbortController().signal, fetchFn: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
    assert.equal(r, null);
  });
});

describe('getSentiment — CryptoPanic primary, LunarCrush-less', () => {
  it('resolves via CryptoPanic when only CRYPTOPANIC_AUTH_TOKEN is set', async () => {
    _clearCache();
    const now = 1779950000000;
    const fetchFn = async (url) => {
      if (String(url).includes('cryptopanic.com')) {
        return { ok: true, status: 200, json: async () => ({ results: [{ published_at: new Date(now - 1000).toISOString(), votes: { positive: 9, negative: 0 } }] }) };
      }
      return { ok: false, status: 402, json: async () => ({}) };
    };
    const r = await getSentiment({ ticker: 'SOL', env: { CRYPTOPANIC_AUTH_TOKEN: 't' }, now, fetchFn });
    assert.equal(r.label, 'bull');
    assert.equal(r.source, 'cryptopanic');
  });

  it('returns null when neither key nor token is set', async () => {
    _clearCache();
    const r = await getSentiment({ ticker: 'SOL', env: {}, now: 1779950000000 });
    assert.equal(r, null);
  });
});
