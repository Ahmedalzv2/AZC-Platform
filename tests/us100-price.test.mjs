import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

function makeBulkScannerStub({ pricesByTicker, callsRef = [] }) {
  return async (url, init) => {
    if (!String(url).includes('scanner.tradingview.com')) {
      return { ok: false, json: async () => ({}) };
    }
    const body = JSON.parse(init?.body || '{}');
    const tickers = body?.symbols?.tickers || [];
    callsRef.push([...tickers]);
    const data = tickers.map(t => {
      const row = pricesByTicker[t];
      return row ? { s: t, d: row } : { s: t, d: [null, null] };
    });
    return { ok: true, json: async () => ({ data }) };
  };
}

describe('US100 price — median across venues', () => {
  test('Stale FPMARKETS quote becomes an outlier the median rejects', async () => {
    const { app } = loadApp({
      fetch: makeBulkScannerStub({
        pricesByTicker: {
          'FPMARKETS:US100':   [26983, 26983],
          'OANDA:NAS100USD':   [29050, 29050],
          'CAPITALCOM:US100':  [29080, 29080],
          'CURRENCYCOM:US100': [29100, 29100],
          'TVC:NDQ':           [29120, 29120],
        },
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    // Sorted: [26983, 29050, 29080, 29100, 29120] → median = 29080
    assert.equal(us100.price, 29080);
  });

  test('Queries every US100 venue in a single bulk scanner call', async () => {
    const callsRef = [];
    const { app } = loadApp({
      fetch: makeBulkScannerStub({
        callsRef,
        pricesByTicker: { 'FPMARKETS:US100': [29000, 29000] },
      }),
    });
    app.loadTradeModes();
    await app.fetchNonBinancePrices();
    const us100Calls = callsRef.filter(arr => arr.includes('FPMARKETS:US100'));
    assert.equal(us100Calls.length, 1, 'exactly one bulk POST for US100');
    assert.deepEqual(us100Calls[0].slice().sort(), [
      'CAPITALCOM:US100', 'CURRENCYCOM:US100', 'FPMARKETS:US100',
      'OANDA:NAS100USD', 'TVC:NDQ',
    ]);
  });

  test('Skips dead venues and medians the remaining quotes', async () => {
    const { app } = loadApp({
      fetch: makeBulkScannerStub({
        pricesByTicker: {
          'FPMARKETS:US100':   [29000, 29000],
          'CURRENCYCOM:US100': [29200, 29200],
          'TVC:NDQ':           [29100, 29100],
        },
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    // Sorted: [29000, 29100, 29200] → median = 29100
    assert.equal(us100.price, 29100);
  });

  test('Falls back to close when lp is missing for a row', async () => {
    const { app } = loadApp({
      fetch: makeBulkScannerStub({
        pricesByTicker: {
          'FPMARKETS:US100': [null, 29050],
          'OANDA:NAS100USD': [null, 29080],
          'TVC:NDQ':         [null, 29100],
        },
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    // Sorted: [29050, 29080, 29100] → median = 29080
    assert.equal(us100.price, 29080);
  });

  test('Single surviving venue is used as-is', async () => {
    const { app } = loadApp({
      fetch: makeBulkScannerStub({
        pricesByTicker: { 'OANDA:NAS100USD': [29050, 29050] },
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 29050);
  });

  test('Leaves price untouched when every source is dead', async () => {
    const { app } = loadApp({
      fetch: makeBulkScannerStub({ pricesByTicker: {} }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    us100.price = 12345;
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 12345);
  });
});
