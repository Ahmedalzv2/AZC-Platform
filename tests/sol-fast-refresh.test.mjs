import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, forceLeverage } from './harness.mjs';

// _fastRefreshAssetEntry hits real fetch endpoints. We replace `fetch` on
// the sandbox before exercising it so the test stays hermetic.

describe('_fastRefreshAssetEntry', () => {
  function bootWithSolFutures() {
    const { app, sandbox } = loadApp();
    app.loadTradeModes();
    forceLeverage(app, 'SOL', 200);
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
    forceLeverage(app, 'SOL', 200);
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
    forceLeverage(app, 'SOL', 200);      // high-lev → eligible
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

describe('_fastRefreshTick parallel execution', () => {
  test('trio refresh runs in parallel — total time ≈ slowest single fetch, not sum', async () => {
    const { app, sandbox } = loadApp();
    app.loadTradeModes();
    forceLeverage(app, 'SOL', 200);
    forceLeverage(app, 'GOLD', 200);
    forceLeverage(app, 'SILVER', 200);
    app.setLiveTradingEnabled(true);
    const DELAY_MS = 80;
    // Return a usable 50-bar kline so the first fallback succeeds for every
    // asset; otherwise each asset walks the binance→mexc→mexcSpot chain
    // (sequential within an asset) and the outer parallelism is masked.
    const klRow = i => [Date.now() - (50 - i) * 60_000, '100', '101', '99', '100.5', '1000', 0, 0, 0, 0, 0, 0];
    const ks = Array.from({ length: 50 }, (_, i) => klRow(i));
    sandbox.fetch = async () => {
      await new Promise(r => setTimeout(r, DELAY_MS));
      return {
        ok: true, status: 200,
        json: async () => ks,
        text: async () => JSON.stringify({ data: { time: ks.map(r => r[0] / 1000), open: ks.map(r => r[1]), high: ks.map(r => r[2]), low: ks.map(r => r[3]), close: ks.map(r => r[4]), vol: ks.map(r => r[5]) } }),
      };
    };
    const start = Date.now();
    await app._fastRefreshTick();
    const elapsed = Date.now() - start;
    // Sequential trio would be ≥ 3 × 80 = 240ms. Parallel ≈ one DELAY_MS.
    assert.ok(elapsed < 200, `parallel refresh took ${elapsed}ms, expected < 200ms (sequential would be ~240ms+)`);
  });
});

describe('contract-detail pre-warm on master ON', () => {
  test('setLiveTradingEnabled(true) pre-warms /contract/detail for futures assets', async () => {
    const { app, sandbox } = loadApp();
    app.loadTradeModes();
    const detailCalls = [];
    sandbox.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/contract/detail')) {
        const m = u.match(/symbol=([A-Z0-9_]+)/);
        if (m) detailCalls.push(m[1]);
        return { ok: true, status: 200, json: async () => ({ data: { symbol: m && m[1], priceScale: 4, volScale: 2, minVol: 0.01 } }), text: async () => '{}' };
      }
      return { ok: true, status: 200, json: async () => [], text: async () => '' };
    };
    app.setLiveTradingEnabled(true);
    // Pre-warm is fire-and-forget; let microtasks settle.
    await new Promise(r => setTimeout(r, 50));
    assert.ok(detailCalls.length >= 1, `expected at least one contract-detail call, got ${detailCalls.length}`);
    // The trio (SOL, GOLD, SILVER) are all futures by default. GOLD's MEXC
    // contract is XAUT_USDT (Tether Gold), so the prewarm call uses that.
    assert.ok(detailCalls.some(s => s.startsWith('SOL')),    `expected SOL pre-warm; saw ${detailCalls.join(',')}`);
    assert.ok(detailCalls.some(s => s.startsWith('XAUT')),   `expected GOLD (XAUT) pre-warm; saw ${detailCalls.join(',')}`);
    assert.ok(detailCalls.some(s => s.startsWith('SILVER')), `expected SILVER pre-warm; saw ${detailCalls.join(',')}`);
  });

  test('off→off transition does not re-trigger pre-warm', async () => {
    const { app, sandbox } = loadApp();
    app.loadTradeModes();
    let detailCalls = 0;
    sandbox.fetch = async (url) => {
      if (String(url).includes('/contract/detail')) detailCalls++;
      return { ok: true, status: 200, json: async () => ({ data: { priceScale: 4, volScale: 2, minVol: 0.01 } }), text: async () => '{}' };
    };
    app.setLiveTradingEnabled(false); // already off
    await new Promise(r => setTimeout(r, 30));
    assert.equal(detailCalls, 0);
  });
});

describe('FAST_REFRESH_INTERVAL_MS constant', () => {
  test('is 2000ms (lowered from 5000 — 2.5× faster scalp response, still 1.5 req/s on trio)', () => {
    const { app } = loadApp();
    assert.equal(app.FAST_REFRESH_INTERVAL_MS, 2000);
  });
});
