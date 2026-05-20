import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

// Combined stub: routes Yahoo Finance and the TV scanner to caller-supplied
// responders so individual tests can switch one off, the other on, etc.
function makeStubs({ yahoo, scanner, calls = { yahoo: 0, scanner: [] } }) {
  return async (url, init) => {
    const u = String(url);
    if (u.includes('query1.finance.yahoo.com')) {
      calls.yahoo++;
      return yahoo ? yahoo(u) : { ok: false, json: async () => ({}) };
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

const yahooOk = (price) => () => ({
  ok: true,
  json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: price }, indicators: { quote: [{ close: [] }] } }] } }),
});

const yahooLastCandle = (closes) => () => ({
  ok: true,
  json: async () => ({ chart: { result: [{ meta: {}, indicators: { quote: [{ close: closes }] } }] } }),
});

const scannerWithPrices = (pricesByTicker) => (tickers) => ({
  ok: true,
  json: async () => ({
    data: tickers.map(t => ({ s: t, d: pricesByTicker[t] || [null, null] })),
  }),
});

describe('US100 price — Yahoo primary, scanner fallback', () => {
  test('Yahoo regularMarketPrice wins when available', async () => {
    const calls = { yahoo: 0, scanner: [] };
    const { app } = loadApp({
      fetch: makeStubs({
        calls,
        yahoo: yahooOk(29153.5),
        scanner: scannerWithPrices({ 'FPMARKETS:US100': [26983, 26983] }),
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 29153.5);
    assert.equal(calls.yahoo, 1);
    // GOLD/SILVER also use the scanner; what matters is the US100 bulk call
    // (containing FPMARKETS:US100) never fires when Yahoo succeeds.
    const us100ScannerCalls = calls.scanner.filter(t => t.includes('FPMARKETS:US100'));
    assert.equal(us100ScannerCalls.length, 0, 'US100 scanner skipped when Yahoo succeeds');
  });

  test('Yahoo last-candle close used when regularMarketPrice missing', async () => {
    const { app } = loadApp({
      fetch: makeStubs({
        yahoo: yahooLastCandle([29100, 29120, null, 29150]),
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 29150);
  });

  test('Falls back to scanner median when Yahoo is unreachable', async () => {
    const calls = { yahoo: 0, scanner: [] };
    const { app } = loadApp({
      fetch: makeStubs({
        calls,
        yahoo: null,
        scanner: scannerWithPrices({
          'FPMARKETS:US100':   [26983, 26983],
          'OANDA:NAS100USD':   [29050, 29050],
          'CAPITALCOM:US100':  [29080, 29080],
          'CURRENCYCOM:US100': [29100, 29100],
          'TVC:NDQ':           [29120, 29120],
        }),
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 29080);
    assert.equal(calls.yahoo, 1);
    // GOLD/SILVER also poke the scanner; we only care that the US100 bulk
    // call (the one containing FPMARKETS:US100) fired exactly once.
    const us100ScannerCalls = calls.scanner.filter(t => t.includes('FPMARKETS:US100'));
    assert.equal(us100ScannerCalls.length, 1, 'US100 scanner is the fallback when Yahoo dies');
  });

  test('Falls back to scanner even when Yahoo returns empty payload', async () => {
    const { app } = loadApp({
      fetch: makeStubs({
        yahoo: () => ({ ok: true, json: async () => ({ chart: { result: [{}] } }) }),
        scanner: scannerWithPrices({ 'OANDA:NAS100USD': [29050, 29050] }),
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 29050);
  });

  test('Leaves price untouched when both Yahoo and scanner fail', async () => {
    const { app } = loadApp({
      fetch: makeStubs({ yahoo: null, scanner: null }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    us100.price = 12345;
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 12345);
  });

  test('Scanner fallback still rejects a single stale-source outlier via median', async () => {
    const { app } = loadApp({
      fetch: makeStubs({
        yahoo: null,
        scanner: scannerWithPrices({
          'FPMARKETS:US100':   [26983, 26983],
          'OANDA:NAS100USD':   [29050, 29050],
          'TVC:NDQ':           [29100, 29100],
        }),
      }),
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 29050);
  });
});
