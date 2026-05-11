import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('forceFireAsset — manual fire bypasses proximity', () => {
  function bootSilverLive(app) {
    app.loadTradeModes();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    app.setLiveTradingDryRun(true); // hermetic — dry-run avoids touching the (mock) network
    return app.ASSETS.find(a => a.symbol === 'SILVER');
  }

  test('master OFF → records master-off, no order sent', async () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const r = await app.forceFireAsset('SILVER');
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'master-off');
    assert.equal(app._lastFireResult.SILVER.source, 'force');
    assert.equal(app._lastFireResult.SILVER.reason, 'master-off');
  });

  test('CFD-only asset (US100) → records unsupported-symbol', async () => {
    const { app } = loadApp();
    app.loadTradeModes();
    app.setLiveTradingEnabled(true);
    const r = await app.forceFireAsset('US100');
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'unsupported-symbol');
  });

  test('no asset price yet → records no-price', async () => {
    const { app } = loadApp();
    const s = bootSilverLive(app);
    s.price = 0;
    const r = await app.forceFireAsset('SILVER');
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'no-price');
  });

  test('high-lev asset: SL/TP use mechanical buffer (≈0.35% at 200×)', async () => {
    const { app, sandbox } = loadApp();
    const s = bootSilverLive(app);
    app.setAssetLeverage('SILVER', 200);   // becomes high-lev
    s.price = 80; s.bias = 'BULLISH';
    sandbox.localStorage.setItem('ict_calc_account', '10');
    sandbox.localStorage.setItem('ict_calc_risk', '100');
    const r = await app.forceFireAsset('SILVER');
    assert.equal(r.source, 'force');
    assert.equal(r.side, 'LONG');
    assert.equal(r.entry, 80, 'fires at LIVE price, not stale FVG mid');
    const slPct = ((80 - r.sl) / 80) * 100;
    assert.ok(Math.abs(slPct - 0.35) < 0.01, `expected SL ≈ 0.35% at 200×, got ${slPct.toFixed(3)}%`);
    const tpPct = ((r.tp - 80) / 80) * 100;
    assert.ok(Math.abs(tpPct - 0.35) < 0.01, '1:1 R:R');
  });

  test('low-lev asset: SL/TP use the flat 0.4% mechanical default', async () => {
    const { app, sandbox } = loadApp();
    const s = bootSilverLive(app);
    app.setAssetLeverage('SILVER', 10);  // not high-lev
    s.price = 80; s.bias = 'BEARISH';
    sandbox.localStorage.setItem('ict_calc_account', '10');
    sandbox.localStorage.setItem('ict_calc_risk', '100');
    const r = await app.forceFireAsset('SILVER');
    assert.equal(r.side, 'SHORT');
    const slPct = ((r.sl - 80) / 80) * 100;
    assert.ok(Math.abs(slPct - 0.40) < 0.01, `expected SL ≈ 0.40% for low-lev, got ${slPct.toFixed(3)}%`);
  });

  test('bullish bias → LONG; bearish bias → SHORT', async () => {
    const { app, sandbox } = loadApp();
    const s = bootSilverLive(app);
    s.price = 80;
    sandbox.localStorage.setItem('ict_calc_account', '10');
    sandbox.localStorage.setItem('ict_calc_risk', '100');

    s.bias = 'BULLISH';
    const r1 = await app.forceFireAsset('SILVER');
    assert.equal(r1.side, 'LONG');
    assert.ok(r1.sl < r1.entry, 'long SL below entry');
    assert.ok(r1.tp > r1.entry, 'long TP above entry');

    s.bias = 'BEARISH';
    const r2 = await app.forceFireAsset('SILVER');
    assert.equal(r2.side, 'SHORT');
    assert.ok(r2.sl > r2.entry, 'short SL above entry');
    assert.ok(r2.tp < r2.entry, 'short TP below entry');
  });

  test('dry-run mode logs the order to the journal without touching network', async () => {
    const { app, sandbox } = loadApp();
    const s = bootSilverLive(app);
    s.price = 80; s.bias = 'BULLISH';
    sandbox.localStorage.setItem('ict_calc_account', '10');
    sandbox.localStorage.setItem('ict_calc_risk', '100');
    const before = (app.journal || []).length;
    const r = await app.forceFireAsset('SILVER');
    assert.equal(r.dryRun, true, 'dry-run flag carried through');
    const after = (app.journal || []).length;
    assert.equal(after, before + 1, 'one [DRY-RUN] entry appended');
  });

  test('pre-records cooldown so auto-exec does not double-fire on top of force-fire', async () => {
    const { app, sandbox } = loadApp();
    const s = bootSilverLive(app);
    s.price = 80; s.bias = 'BULLISH';
    sandbox.localStorage.setItem('ict_calc_account', '10');
    sandbox.localStorage.setItem('ict_calc_risk', '100');
    assert.equal(app.isMexcInCooldown('SILVER'), false, 'pre-condition: not in cooldown');
    await app.forceFireAsset('SILVER');
    assert.equal(app.isMexcInCooldown('SILVER'), true, 'force-fire arms the cooldown');
  });
});

describe('_fastRefreshTick covers low-lev futures assets too', () => {
  test('SILVER at 10× still gets a fetch in _fastRefreshTick', async () => {
    // Before this change, fast-refresh was gated to high-lev only — meaning
    // SILVER@10× stayed on the 30s render-tick cadence. That made the
    // dashboard's per-TF entry zone stale by the time auto-exec ran.
    const { app, sandbox } = loadApp();
    app.loadTradeModes();
    app.setAssetLeverage('SILVER', 10);   // explicitly low-lev
    app.setLiveTradingEnabled(true);
    const fetchedUrls = [];
    sandbox.fetch = async (url) => {
      fetchedUrls.push(String(url));
      return { ok: true, status: 200, json: async () => [], text: async () => '' };
    };
    await app._fastRefreshTick();
    // SILVER lives on the MEXC contract API (path-param shape) rather than
    // the Binance ?symbol= query string, so match on the URL containing
    // the symbol anywhere.
    const sawSilver = fetchedUrls.some(u => u.includes('SILVER'));
    assert.ok(sawSilver, `expected SILVER fetch even at 10×, urls=${JSON.stringify(fetchedUrls).slice(0,200)}`);
  });
});
