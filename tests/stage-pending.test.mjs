import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

// Helper — mirrors the force-fire harness boot but covers the staging path.
// Stage Pending Maker fires a POST_ONLY limit at the FVG mid (not the live
// price), so tests need a 5m FVG planted on the asset and live trading on.
function bootSilverFutures(app) {
  app.loadTradeModes();
  app.saveMexcKeys('k', 's');
  app.setLiveTradingEnabled(true);
  app.setLiveTradingDryRun(true);
  const sil = app.ASSETS.find(a => a.symbol === 'SILVER');
  // SILVER defaults to spot under v8 — flip to futures for the stage path.
  sil.tradeMode = 'futures';
  app.setAssetLeverage('SILVER', 10);
  return sil;
}

function attach5mFvg(asset, dir, lo, hi) {
  asset.tfEntries = asset.tfEntries || {};
  asset.tfEntries['5m'] = {
    dir,
    fvgZone: { dir, lo, mid: (lo + hi) / 2, hi },
    score: 3,
    entryReady: true,
  };
}

describe('stagePendingMakerAsset — POST_ONLY limit at FVG mid', () => {
  test('master OFF → records master-off, no order sent', async () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const r = await app.stagePendingMakerAsset('SILVER');
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'master-off');
    assert.equal(app._lastFireResult.SILVER.source, 'stage');
  });

  test('CFD-only asset (US100) → unsupported-symbol (MEXC-only)', async () => {
    const { app } = loadApp();
    app.loadTradeModes();
    app.setLiveTradingEnabled(true);
    const r = await app.stagePendingMakerAsset('US100');
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'unsupported-symbol');
  });

  test('no 5m setup → no-5m-setup, no fire', async () => {
    const { app } = loadApp();
    const s = bootSilverFutures(app);
    s.price = 80;
    // no tfEntries['5m'] attached
    const r = await app.stagePendingMakerAsset('SILVER');
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'no-5m-setup');
  });

  test('uses sug5.entry as limit price (NOT current market price)', async () => {
    const { app, sandbox } = loadApp();
    const s = bootSilverFutures(app);
    s.price = 80;
    // Bull FVG sitting BELOW current price — passive bid maker fill on retest.
    attach5mFvg(s, 'bull', 79.40, 79.60);
    sandbox.localStorage.setItem('ict_calc_account', '10');
    sandbox.localStorage.setItem('ict_calc_risk', '100');

    const r = await app.stagePendingMakerAsset('SILVER');
    assert.equal(r.source, 'stage');
    assert.equal(r.side, 'LONG');
    // Limit price = FVG mid (79.50), not asset.price (80) — proves staging
    // anchors to the setup, not live price.
    assert.ok(Math.abs(r.entry - 79.50) < 0.001, `expected entry ≈ 79.50, got ${r.entry}`);
    // SL inherits the suggested-entry helper's fvg-edge fallback (fvg.lo * 0.998).
    assert.ok(Math.abs(r.sl - 79.241) < 0.001, `expected SL ≈ 79.241, got ${r.sl}`);
    // TP at the suggester's tf-default RR (5m = 1.5) from the staged entry.
    const stopDist = Math.abs(r.entry - r.sl);
    const expectedTp = r.entry + stopDist * 1.5;
    assert.ok(Math.abs(r.tp - expectedTp) < 0.01, `expected TP ≈ ${expectedTp}, got ${r.tp}`);
  });

  test('bear setup stages SHORT at FVG mid above current price', async () => {
    const { app, sandbox } = loadApp();
    const s = bootSilverFutures(app);
    s.price = 80;
    // Bear FVG ABOVE current price — passive ask maker.
    attach5mFvg(s, 'bear', 80.40, 80.60);
    sandbox.localStorage.setItem('ict_calc_account', '10');
    sandbox.localStorage.setItem('ict_calc_risk', '100');

    const r = await app.stagePendingMakerAsset('SILVER');
    assert.equal(r.side, 'SHORT');
    assert.ok(Math.abs(r.entry - 80.50) < 0.001, `expected SHORT entry ≈ 80.50, got ${r.entry}`);
    // SL above the FVG hi + buffer.
    assert.ok(r.sl > r.entry, 'SHORT stop must sit above entry');
  });

  test('order body is type=2 POST_ONLY regardless of leverage', async () => {
    const { app, sandbox } = loadApp();
    const s = bootSilverFutures(app);
    app.setAssetLeverage('SILVER', 10);   // low-lev; without postOnly opt it would default type=1
    s.price = 80;
    attach5mFvg(s, 'bull', 79.40, 79.60);
    sandbox.localStorage.setItem('ict_calc_account', '10');
    sandbox.localStorage.setItem('ict_calc_risk', '100');

    await app.stagePendingMakerAsset('SILVER');
    const j = app.journal;
    assert.ok(Array.isArray(j) && j.length > 0, 'journal entry should exist for dry-run stage');
    assert.equal(j[0].mexcBody.type, 2, 'staged orders must be POST_ONLY (type=2) so they cannot take');
    assert.equal(j[0].mexcBody.symbol, 'SILVER_USDT');
  });

  test('in-position blocks staging (one-at-a-time policy)', async () => {
    const { app, sandbox } = loadApp();
    const s = bootSilverFutures(app);
    s.price = 80;
    attach5mFvg(s, 'bull', 79.40, 79.60);
    sandbox.localStorage.setItem('ict_calc_account', '10');
    sandbox.localStorage.setItem('ict_calc_risk', '100');
    // Mark an open position via the same plumbing force-fire uses.
    app._openPositions = { SILVER: [{ symbol: 'SILVER_USDT', positionId: 'x' }] };

    const r = await app.stagePendingMakerAsset('SILVER');
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'in-position');
  });
});
