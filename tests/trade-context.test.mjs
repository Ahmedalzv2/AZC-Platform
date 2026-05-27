import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchMarketContext,
  symbolToTicker,
  pickProvider,
  parseLunarCrushNews,
  sentimentLabel,
} from '../trade-context.mjs';

describe('symbolToTicker', () => {
  test('maps MEXC pair to base ticker', () => {
    assert.equal(symbolToTicker('BTC_USDT'), 'BTC');
    assert.equal(symbolToTicker('sol_usdt'), 'SOL');
    assert.equal(symbolToTicker('SUI_USDT'), 'SUI');
  });
  test('returns empty string for junk input', () => {
    assert.equal(symbolToTicker(null), '');
    assert.equal(symbolToTicker(''), '');
    assert.equal(symbolToTicker(123), '');
  });
});

describe('fetchMarketContext', () => {
  test('returns normalised shape when fetcher succeeds', async () => {
    const fetcher = async ({ ticker }) => ({
      source: 'stub',
      headlines: [
        { title: 'BTC squeezes higher', url: 'https://x/1', publishedAt: '2026-05-27T10:00:00Z' },
        { title: 'ETF flows positive',  url: 'https://x/2', publishedAt: '2026-05-27T09:30:00Z' },
      ],
    });
    const r = await fetchMarketContext({ symbol: 'BTC_USDT', fetcher });
    assert.equal(r.source, 'stub');
    assert.equal(r.headlines.length, 2);
    assert.equal(r.headlines[0].title, 'BTC squeezes higher');
    assert.ok(Number.isFinite(r.fetchedAtMs));
  });

  test('caps headlines at 5', async () => {
    const fetcher = async () => ({
      source: 'stub',
      headlines: Array.from({ length: 12 }, (_, i) => ({ title: `h${i}` })),
    });
    const r = await fetchMarketContext({ symbol: 'BTC_USDT', fetcher });
    assert.equal(r.headlines.length, 5);
  });

  test('fetcher throws → returns null (never breaks caller)', async () => {
    const fetcher = async () => { throw new Error('network down'); };
    const r = await fetchMarketContext({ symbol: 'BTC_USDT', fetcher });
    assert.equal(r, null);
  });

  test('fetcher returns malformed payload → returns null', async () => {
    const r1 = await fetchMarketContext({ symbol: 'BTC_USDT', fetcher: async () => null });
    const r2 = await fetchMarketContext({ symbol: 'BTC_USDT', fetcher: async () => ({}) });
    const r3 = await fetchMarketContext({ symbol: 'BTC_USDT', fetcher: async () => ({ headlines: 'not-an-array' }) });
    assert.equal(r1, null);
    assert.equal(r2, null);
    assert.equal(r3, null);
  });

  test('fetcher slower than timeout → returns null', async () => {
    const fetcher = async ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
        setTimeout(() => reject(new Error('never reached')), 5000);
      });
    const start = Date.now();
    const r = await fetchMarketContext({ symbol: 'BTC_USDT', fetcher, timeoutMs: 50 });
    assert.equal(r, null);
    assert.ok(Date.now() - start < 500, 'must short-circuit on timeout');
  });

  test('bad symbol → returns null without invoking fetcher', async () => {
    let called = false;
    const fetcher = async () => { called = true; return { source: 'x', headlines: [{ title: 'a' }] }; };
    const r = await fetchMarketContext({ symbol: null, fetcher });
    assert.equal(r, null);
    assert.equal(called, false);
  });
});

describe('pickProvider', () => {
  test('explicit env wins (lunarcrush)', () => {
    const p = pickProvider({ CONTEXT_PROVIDER: 'lunarcrush', LUNARCRUSH_API_KEY: 'k' });
    assert.equal(p, 'lunarcrush');
  });
  test('explicit env wins (cryptopanic)', () => {
    const p = pickProvider({ CONTEXT_PROVIDER: 'cryptopanic', CRYPTOPANIC_AUTH_TOKEN: 't' });
    assert.equal(p, 'cryptopanic');
  });
  test('lunarcrush key present → lunarcrush by default', () => {
    const p = pickProvider({ LUNARCRUSH_API_KEY: 'k' });
    assert.equal(p, 'lunarcrush');
  });
  test('only cryptopanic key present → cryptopanic', () => {
    const p = pickProvider({ CRYPTOPANIC_AUTH_TOKEN: 't' });
    assert.equal(p, 'cryptopanic');
  });
  test('no keys at all → none', () => {
    assert.equal(pickProvider({}), 'none');
  });
  test('unknown explicit provider → none', () => {
    assert.equal(pickProvider({ CONTEXT_PROVIDER: 'made-up' }), 'none');
  });
});

describe('sentimentLabel', () => {
  test('1-5 scale maps to text labels', () => {
    assert.equal(sentimentLabel(1), 'bearish');
    assert.equal(sentimentLabel(2), 'bearish');
    assert.equal(sentimentLabel(3), 'neutral');
    assert.equal(sentimentLabel(4), 'bullish');
    assert.equal(sentimentLabel(5), 'bullish');
  });
  test('out-of-range / non-numeric → null', () => {
    assert.equal(sentimentLabel(0), null);
    assert.equal(sentimentLabel(6), null);
    assert.equal(sentimentLabel('bullish'), 'bullish'); // already a string passthrough
    assert.equal(sentimentLabel(null), null);
    assert.equal(sentimentLabel(undefined), null);
  });
});

describe('parseLunarCrushNews', () => {
  test('maps v4 news response to normalised headlines with sentiment', () => {
    const raw = {
      data: [
        {
          post_title: 'Bitcoin breaks 70k on ETF inflows',
          post_link: 'https://example/1',
          post_created: 1716540000,
          post_sentiment: 4.6,
          interactions_24h: 15000,
          creator_display_name: 'CryptoNewsBot',
        },
        {
          post_title: 'Macro: Fed minutes drop today',
          post_link: 'https://example/2',
          post_created: 1716536400,
          post_sentiment: 2.1,
        },
        { post_title: '   ', post_link: 'https://example/3' }, // empty title filtered out
      ],
    };
    const out = parseLunarCrushNews(raw);
    assert.equal(out.source, 'lunarcrush');
    assert.equal(out.headlines.length, 2);
    assert.equal(out.headlines[0].title, 'Bitcoin breaks 70k on ETF inflows');
    assert.equal(out.headlines[0].sentiment, 'bullish');
    assert.equal(out.headlines[1].sentiment, 'bearish');
    assert.match(out.headlines[0].publishedAt, /^2024-/);
  });

  test('empty / malformed response → empty headlines list', () => {
    assert.deepEqual(parseLunarCrushNews(null), { source: 'lunarcrush', headlines: [] });
    assert.deepEqual(parseLunarCrushNews({}), { source: 'lunarcrush', headlines: [] });
    assert.deepEqual(parseLunarCrushNews({ data: 'not-array' }), { source: 'lunarcrush', headlines: [] });
  });
});
