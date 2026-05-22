import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

// Combined stub: routes the local /api/us100-price proxy and the TV scanner
// to caller-supplied responders so individual tests can switch one off, the
// other on, etc. FPMARKETS:US100 is a CFD wrapping CME_MINI:NQ1! — that's
// the only public ticker quoting the same instrument the chart embeds.
function makeStubs({ proxy, scanner, calls = { proxy: 0, scanner: [] } }) {
  return async (url, init) => {
    const u = String(url);
    if (u.includes('/api/us100-price')) {
      calls.proxy++;
      return proxy ? proxy() : { ok: false, json: async () => ({}) };
    }
    if (u.includes('scanner.tradingview.com')) {
      const body = JSON.parse(init?.body || '{}');
      const tickers = body?.symbols?.tickers || [];
      calls.scanner.push([...tickers]);
      return scanner ? scanner(tickers) : { ok: false, json: async () => ({}) };
    }
    // GOLD / SILVER MEXC paths — return not-ok so they bail without touching us
    return { ok: false, json: async () => ({}) };
  };
}

const proxyOk = (price, source = 'CME_MINI:NQ1!') => () => ({
  ok: true,
  json: async () => ({ price, source, ts: Date.now() }),
});

const scannerWithPrices = (pricesByTicker) => (tickers) => ({
  ok: true,
  json: async () => ({
    data: tickers.map(t => ({ s: t, d: pricesByTicker[t] || [null, null] })),
  }),
});

describe('US100 price — local proxy primary, TV scanner NQ1! fallback', () => {
  test('Local proxy wins when it returns a price', async () => {
    const calls = { proxy: 0, scanner: [] };
    const { app } = loadApp({
      fetch: makeStubs({
        calls,
        proxy: proxyOk(29660.75),
        scanner: scannerWithPrices({ 'CME_MINI:NQ1!': [29500, 29500] }),
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 29660.75);
    assert.equal(calls.proxy, 1);
    const us100ScannerCalls = calls.scanner.filter(t => t.includes('CME_MINI:NQ1!'));
    assert.equal(us100ScannerCalls.length, 0, 'scanner skipped when proxy succeeds');
  });

  test('Falls back to TV scanner CME_MINI:NQ1! when proxy unreachable', async () => {
    const calls = { proxy: 0, scanner: [] };
    const { app } = loadApp({
      fetch: makeStubs({
        calls,
        proxy: null,
        scanner: scannerWithPrices({ 'CME_MINI:NQ1!': [null, 29660.75] }),
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 29660.75);
    const us100ScannerCalls = calls.scanner.filter(t => t.includes('CME_MINI:NQ1!'));
    assert.equal(us100ScannerCalls.length, 1, 'scanner is the fallback when proxy dies');
  });

  test('Scanner lp preferred over close when both present', async () => {
    const { app } = loadApp({
      fetch: makeStubs({
        proxy: null,
        scanner: scannerWithPrices({ 'CME_MINI:NQ1!': [29700, 29660] }),
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 29700);
  });

  test('Leaves price untouched when both proxy and scanner fail', async () => {
    const { app } = loadApp({
      fetch: makeStubs({ proxy: null, scanner: null }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    us100.price = 12345;
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 12345);
  });

  test('Empty scanner payload leaves price untouched', async () => {
    const { app } = loadApp({
      fetch: makeStubs({
        proxy: null,
        scanner: () => ({ ok: true, json: async () => ({ data: [] }) }),
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    us100.price = 99999;
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 99999);
  });
});
