import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, forceLeverage } from './harness.mjs';

describe('forceFireAsset — manual fire bypasses proximity', () => {
  function bootSilverLive(app) {
    app.loadTradeModes();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    app.setLiveTradingDryRun(true); // hermetic — dry-run avoids touching the (mock) network
    return app.ASSETS.find(a => a.symbol === 'SILVER');
  }
  // 5m setup helper — low-lev force-fire now reads tfEntries['5m'] for the
  // structural SL distance and R:R, so tests need to plant a valid one.
  function attach5mFvg(asset, dir, lo, hi) {
    asset.tfEntries = asset.tfEntries || {};
    asset.tfEntries['5m'] = {
      dir,
      fvgZone: { dir, lo, mid: (lo + hi) / 2, hi },
      score: 3,
      entryReady: true,
    };
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
    forceLeverage(app, 'SILVER', 200);   // becomes high-lev
    s.price = 80; s.bias = 'BULLISH';
    sandbox.localStorage.setItem('ict_calc_account', '10');
    sandbox.localStorage.setItem('ict_calc_risk', '100');
    const r = await app.forceFireAsset('SILVER');
    assert.equal(r.source, 'force');
    assert.equal(r.side, 'LONG');
    assert.equal(r.entry, 80, 'fires at LIVE price, not stale FVG mid');
    const slPct = ((80 - r.sl) / 80) * 100;
    assert.ok(Math.abs(slPct - 0.35) < 0.01, `expected SL ≈ 0.35% at 200×, got ${slPct.toFixed(3)}%`);
    // High-lev force-fires ship with TP at NET 14% / GROSS 30% margin
    // (~0.15% price at 200×). MEXC fires the close the instant this prints.
    const tpPct = ((r.tp - 80) / 80) * 100;
    assert.ok(Math.abs(tpPct - 0.15) < 0.005, `ceiling TP ≈ 0.15% price at 200×, got ${tpPct.toFixed(4)}%`);
  });

  test('low-lev asset: SL/TP anchored to 5m setup structural distance + 1.5R', async () => {
    const { app, sandbox } = loadApp();
    const s = bootSilverLive(app);
    app.setAssetLeverage('SILVER', 10);  // not high-lev
    s.price = 80;
    attach5mFvg(s, 'bear', 75.55, 75.75); // bear FVG → 5m setup direction = SHORT
    sandbox.localStorage.setItem('ict_calc_account', '10');
    sandbox.localStorage.setItem('ict_calc_risk', '100');
    const r = await app.forceFireAsset('SILVER');
    assert.equal(r.side, 'SHORT', '5m setup dir drives the side');
    assert.equal(r.entry, 80, 'entry is live market price, not 5m FVG mid');
    // 5m fvg-edge fallback: entry=75.65, sl=round(75.75×1.002)≈75.901 → stopDist≈0.251
    // Applied to market: sl = 80 + 0.251, tp = 80 - 0.251×1.5
    const stopDist = 80 - r.entry + Math.abs(r.sl - r.entry); // == |sl-entry| since entry==price
    assert.ok(r.sl > r.entry && r.sl - r.entry > 0.2 && r.sl - r.entry < 0.3,
      `short SL above entry, stop dist ~0.25, got sl=${r.sl}`);
    // R:R = 1.5 ⇒ tpDist / slDist === 1.5 (±tiny rounding)
    const slDist = r.sl - r.entry;
    const tpDist = r.entry - r.tp;
    assert.ok(Math.abs(tpDist / slDist - 1.5) < 0.02, `expected 1.5R, got ${(tpDist/slDist).toFixed(3)}R`);
    assert.equal(r.setupSource, 'fvg-edge');
  });

  test('low-lev with no 5m setup → no-5m-setup, no order sent', async () => {
    const { app } = loadApp();
    const s = bootSilverLive(app);
    app.setAssetLeverage('SILVER', 10);
    s.price = 80; s.bias = 'BULLISH';
    // tfEntries empty — Force Fire refuses rather than slapping a mechanical
    // stop on the live price.
    s.tfEntries = {};
    const r = await app.forceFireAsset('SILVER');
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'no-5m-setup');
  });

  test('bullish bias → LONG; bearish bias → SHORT (high-lev: ceiling TP, trail-managed)', async () => {
    const { app, sandbox } = loadApp();
    const s = bootSilverLive(app);
    forceLeverage(app, 'SILVER', 200); // high-lev path still reads asset.bias
    s.price = 80;
    sandbox.localStorage.setItem('ict_calc_account', '10');
    sandbox.localStorage.setItem('ict_calc_risk', '100');

    s.bias = 'BULLISH';
    const r1 = await app.forceFireAsset('SILVER');
    assert.equal(r1.side, 'LONG');
    assert.ok(r1.sl < r1.entry, 'long SL below entry');
    assert.ok(r1.tp > r1.entry, 'long ceiling TP above entry (visible in MEXC UI)');

    delete app._pendingFires.SILVER;

    s.bias = 'BEARISH';
    const r2 = await app.forceFireAsset('SILVER');
    assert.equal(r2.side, 'SHORT');
    assert.ok(r2.sl > r2.entry, 'short SL above entry');
    assert.ok(r2.tp < r2.entry, 'short ceiling TP below entry');
  });

  test('low-lev TP/SL bracket lives on the correct side of entry (1.5R from 5m setup)', async () => {
    const { app, sandbox } = loadApp();
    const s = bootSilverLive(app);
    app.setAssetLeverage('SILVER', 10);
    s.price = 80;
    sandbox.localStorage.setItem('ict_calc_account', '10');
    sandbox.localStorage.setItem('ict_calc_risk', '100');

    attach5mFvg(s, 'bull', 75.55, 75.75);
    const r1 = await app.forceFireAsset('SILVER');
    assert.equal(r1.side, 'LONG', 'bull 5m setup → LONG');
    assert.ok(r1.tp > r1.entry, 'long TP above entry');
    assert.ok(r1.sl < r1.entry, 'long SL below entry');

    delete app._pendingFires.SILVER;
    attach5mFvg(s, 'bear', 75.55, 75.75);
    const r2 = await app.forceFireAsset('SILVER');
    assert.equal(r2.side, 'SHORT', 'bear 5m setup → SHORT');
    assert.ok(r2.tp < r2.entry, 'short TP below entry');
    assert.ok(r2.sl > r2.entry, 'short SL above entry');
  });

  test('dry-run mode logs the order to the journal without touching network', async () => {
    const { app, sandbox } = loadApp();
    const s = bootSilverLive(app);
    app.setAssetLeverage('SILVER', 10);
    s.price = 80;
    attach5mFvg(s, 'bull', 75.55, 75.75);
    sandbox.localStorage.setItem('ict_calc_account', '10');
    sandbox.localStorage.setItem('ict_calc_risk', '100');
    const before = (app.journal || []).length;
    const r = await app.forceFireAsset('SILVER');
    assert.equal(r.dryRun, true, 'dry-run flag carried through');
    const after = (app.journal || []).length;
    assert.equal(after, before + 1, 'one [DRY-RUN] entry appended');
  });

});

describe('_fastRefreshTick covers manual futures assets too', () => {
  test('SILVER at 10× refreshes the 5m setup used by Force Fire', async () => {
    // Force Fire needs fresh per-TF levels even with auto-fire disabled.
    const { app, sandbox } = loadApp();
    app.loadTradeModes();
    app.setAssetLeverage('SILVER', 10);
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
    assert.ok(fetchedUrls.some(u => u.includes('interval=Min5')), `expected 5m refresh for Force Fire setup, urls=${JSON.stringify(fetchedUrls).slice(0,200)}`);
  });
});
