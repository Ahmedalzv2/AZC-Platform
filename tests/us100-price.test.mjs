import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

const US100_TICKERS = new Set([
  'FPMARKETS:US100', 'OANDA:NAS100USD', 'CAPITALCOM:US100',
  'CURRENCYCOM:US100', 'TVC:NDQ',
]);

function makeScannerStub({ rowsByTicker, calls }) {
  return async (url, init) => {
    if (!String(url).includes('scanner.tradingview.com')) {
      return { ok: false, json: async () => ({}) };
    }
    const body = JSON.parse(init?.body || '{}');
    const ticker = body?.symbols?.tickers?.[0] || '';
    if (!US100_TICKERS.has(ticker)) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    calls.push(ticker);
    const row = rowsByTicker[ticker] || null;
    return { ok: true, json: async () => ({ data: row ? [{ d: row }] : [] }) };
  };
}

describe('US100 price fallback chain', () => {
  test('Falls through scanner tickers until a venue returns a live quote', async () => {
    const calls = [];
    const { app } = loadApp({
      fetch: makeScannerStub({
        calls,
        rowsByTicker: {
          'FPMARKETS:US100': [null, null],
          'OANDA:NAS100USD': [29050, 29048],
        },
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    us100.price = 0;
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 29050);
    assert.equal(calls[0], 'FPMARKETS:US100');
    assert.ok(calls.includes('OANDA:NAS100USD'));
  });

  test('First successful ticker short-circuits the fallback chain', async () => {
    const calls = [];
    const { app } = loadApp({
      fetch: makeScannerStub({
        calls,
        rowsByTicker: { 'FPMARKETS:US100': [27500, 27499] },
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 27500);
    assert.deepEqual(calls, ['FPMARKETS:US100']);
  });

  test('Prefers lp over close when both are present', async () => {
    const calls = [];
    const { app } = loadApp({
      fetch: makeScannerStub({
        calls,
        rowsByTicker: { 'FPMARKETS:US100': [29010, 28950] },
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 29010);
  });

  test('Falls back to close when lp is missing', async () => {
    const calls = [];
    const { app } = loadApp({
      fetch: makeScannerStub({
        calls,
        rowsByTicker: { 'FPMARKETS:US100': [null, 28950] },
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 28950);
  });

  test('Leaves price untouched when every source is dead', async () => {
    const calls = [];
    const { app } = loadApp({
      fetch: makeScannerStub({ calls, rowsByTicker: {} }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    us100.price = 12345;
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 12345);
    // tried every fallback before giving up
    assert.equal(calls.length, US100_TICKERS.size);
  });
});
