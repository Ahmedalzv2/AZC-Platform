import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

// _fastRefreshAssetEntry hits real fetch endpoints. We replace `fetch` on
// the sandbox before exercising it so the test stays hermetic.

describe('_fastRefreshAssetEntry', () => {
  function bootWithSolFutures() {
    const { app, sandbox } = loadApp();
    app.loadTradeModes();
    app.setAssetLeverage('SOL', 200);
    return { app, sandbox };
  }

  test('refreshes only asset.tfEntries["1m"] (leaves other TFs untouched)', async () => {
    const { app, sandbox } = bootWithSolFutures();
    const sol = app.ASSETS.find(a => a.symbol === 'SOL');
    sol.tfEntries = {
      '1m':  { dir: 'bull', score: 1, fvgZone: { lo: 80, hi: 81, mid: 80.5 }, entryReady: false, price: 80.5 },
      '5m':  { dir: 'bull', score: 2, entryReady: false, price: 80.5 },
      '1h':  { dir: 'bear', score: 3, entryReady: true,  price: 81.0 },
    };

    // Stub fetch to return a 50-candle bull series so _analyzeKlines doesn't
    // bail with insufficient-data. Each row is the Binance kline shape.
    const klRow = (i) => [Date.now() - (50-i)*60000, '85.0', '86.0', '84.5', '85.5', '1000', 0, 0, 0, 0, 0, 0];
    sandbox.fetch = async () => ({
      ok: true, status: 200,
      json: async () => Array.from({length: 50}, (_, i) => klRow(i)),
      text: async () => '',
    });

    const r = await app._fastRefreshAssetEntry(sol);
    assert.equal(r.refreshed, true, `expected refreshed=true, got ${JSON.stringify(r)}`);
    // 1m should be a fresh _analyzeKlines result (not the stale {dir:'bull',score:1,...} we seeded)
    assert.equal(typeof sol.tfEntries['1m'].score, 'number');
    assert.notEqual(sol.tfEntries['1m'].score, 1, '1m TF was overwritten with fresh analysis');
    // Other TFs untouched (proves we did the *targeted* refresh, not full autoAnalyzeAsset)
    assert.equal(sol.tfEntries['5m'].score, 2);
    assert.equal(sol.tfEntries['1h'].score, 3);
  });

  test('skips when asset is not a futures asset', async () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const btc = app.ASSETS.find(a => a.symbol === 'BTC');
    const r = await app._fastRefreshAssetEntry(btc);
    assert.equal(r.refreshed, false);
    assert.equal(r.reason, 'not-futures');
  });

  test('returns fetch-failed reason when network returns nothing', async () => {
    const { app, sandbox } = bootWithSolFutures();
    const sol = app.ASSETS.find(a => a.symbol === 'SOL');
    sandbox.fetch = async () => ({ ok: false, status: 502, json: async () => [], text: async () => '' });
    const r = await app._fastRefreshAssetEntry(sol);
    assert.equal(r.refreshed, false);
    assert.equal(r.reason, 'fetch-failed');
  });
});

describe('_fastRefreshTick gating', () => {
  test('skips entirely when master switch is OFF', async () => {
    const { app, sandbox } = loadApp();
    app.loadTradeModes();
    app.setAssetLeverage('SOL', 200);
    let fetchCalls = 0;
    sandbox.fetch = async () => {
      fetchCalls++;
      return { ok: true, status: 200, json: async () => [], text: async () => '' };
    };
    // Master OFF (default in harness)
    await app._fastRefreshTick();
    assert.equal(fetchCalls, 0, 'no fetches when master off');
  });

  test('iterates only high-lev futures assets when master ON', async () => {
    const { app, sandbox } = loadApp();
    app.loadTradeModes();
    app.setAssetLeverage('SOL', 200);    // high-lev → eligible
    app.setAssetLeverage('SILVER', 3);   // low-lev  → skipped
    app.setLiveTradingEnabled(true);
    const fetchedSymbols = new Set();
    sandbox.fetch = async (url) => {
      // Try to extract the symbol from the URL — both Binance and MEXC keep
      // it in a `symbol=` query param.
      const m = String(url).match(/symbol=([A-Z0-9_]+)/);
      if (m) fetchedSymbols.add(m[1]);
      return { ok: true, status: 200, json: async () => [], text: async () => '' };
    };
    await app._fastRefreshTick();
    // SOL hit at least once (one of SOLUSDT, SOL_USDT depending on resolver)
    const sawSol = [...fetchedSymbols].some(s => s.startsWith('SOL'));
    const sawSilver = [...fetchedSymbols].some(s => s.startsWith('SILVER') || s === 'XAGUSDT');
    assert.ok(sawSol, `expected SOL fetch, saw ${[...fetchedSymbols].join(',')}`);
    assert.ok(!sawSilver, `SILVER (low-lev) should not be fast-refreshed; saw ${[...fetchedSymbols].join(',')}`);
  });
});

describe('FAST_REFRESH_INTERVAL_MS constant', () => {
  test('is 5000ms (matches user request: refresh every 5 seconds)', () => {
    const { app } = loadApp();
    assert.equal(app.FAST_REFRESH_INTERVAL_MS, 5000);
  });
});
