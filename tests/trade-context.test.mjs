import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMarketContext, symbolToTicker } from '../trade-context.mjs';

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
