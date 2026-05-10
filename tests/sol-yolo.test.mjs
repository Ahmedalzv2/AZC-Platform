import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('SOL trade-mode policy v3', () => {
  test('DEFAULT_TRADE_MODES.SOL = futures (was spot in v2)', () => {
    const { app } = loadApp();
    assert.equal(app.DEFAULT_TRADE_MODES.SOL, 'futures');
    // SILVER + US100 stay futures, others stay spot.
    assert.equal(app.DEFAULT_TRADE_MODES.SILVER, 'futures');
    assert.equal(app.DEFAULT_TRADE_MODES.US100,  'futures');
    assert.equal(app.DEFAULT_TRADE_MODES.BTC,    'spot');
    assert.equal(app.DEFAULT_TRADE_MODES.GOLD,   'spot');
  });

  test('loadTradeModes seeds SOL with futures', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const sol = app.ASSETS.find(a => a.symbol === 'SOL');
    assert.equal(sol.tradeMode, 'futures');
    assert.equal(app._isFuturesAsset(sol), true);
  });
});

describe('_mexcContractSymbol generalised', () => {
  test('returns SOL_USDT for SOL', () => {
    const { app } = loadApp();
    const sol = { symbol: 'SOL' };
    assert.equal(app._mexcContractSymbol(sol), 'SOL_USDT');
  });

  test('still returns SILVER_USDT for SILVER (backwards-compat)', () => {
    const { app } = loadApp();
    assert.equal(app._mexcContractSymbol({ symbol: 'SILVER' }), 'SILVER_USDT');
  });

  test('returns null for assets not in the contract map', () => {
    const { app } = loadApp();
    assert.equal(app._mexcContractSymbol({ symbol: 'BTC' }),  null);
    assert.equal(app._mexcContractSymbol({ symbol: 'ETH' }),  null);
    assert.equal(app._mexcContractSymbol({ symbol: 'GOLD' }), null);
    assert.equal(app._mexcContractSymbol(null),               null);
  });
});

describe('getAssetLeverage / setAssetLeverage per-asset cap', () => {
  test('SILVER capped at 20x (conservative — was the original cap)', () => {
    const { app } = loadApp();
    assert.equal(app.ASSET_LEVERAGE_SPEC.SILVER.max, 20);
    assert.equal(app.setAssetLeverage('SILVER', 50), 20, 'clamped to SILVER cap');
    assert.equal(app.setAssetLeverage('SILVER', 5),  5);
  });

  test('SOL capped at 200x (the YOLO test ceiling)', () => {
    const { app } = loadApp();
    assert.equal(app.ASSET_LEVERAGE_SPEC.SOL.max, 200);
    assert.equal(app.setAssetLeverage('SOL', 200), 200, 'accepts the explicit YOLO 200x');
    assert.equal(app.setAssetLeverage('SOL', 500), 200, 'clamped to SOL cap');
    assert.equal(app.setAssetLeverage('SOL', 25),  25);
  });

  test('SOL default leverage is 200x (matches user request)', () => {
    const { app } = loadApp();
    // Wipe any prior persisted value so we observe the seed default.
    try { app.localStorage.removeItem('ict_mexc_sol_leverage'); } catch (e) {}
    assert.equal(app.getAssetLeverage('SOL'), 200);
  });

  test('Unknown asset falls back to safe defaults (def=3, max=20)', () => {
    const { app } = loadApp();
    assert.equal(app.getAssetLeverage('NEVER_HEARD'), 3);
    assert.equal(app.setAssetLeverage('NEVER_HEARD', 100), 20);
  });

  test('getSilverLeverage backwards-compat alias still works', () => {
    const { app } = loadApp();
    app.setAssetLeverage('SILVER', 7);
    assert.equal(app.getSilverLeverage(), 7);
    app.setSilverLeverage(4);
    assert.equal(app.getAssetLeverage('SILVER'), 4);
  });
});

describe('Auto-exec eligibility now keyed on _mexcContractSymbol, not symbol', () => {
  test('SILVER + SOL are both eligible; BTC + GOLD are not', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const eligibleSyms = app.ASSETS
      .filter(a => app._mexcContractSymbol(a))
      .map(a => a.symbol);
    assert.equal(eligibleSyms.length, 2, 'exactly two assets eligible');
    assert.ok(eligibleSyms.includes('SILVER'), 'SILVER eligible');
    assert.ok(eligibleSyms.includes('SOL'),    'SOL eligible');
    // Negative cases — these should NOT auto-exec.
    for (const sym of ['BTC', 'ETH', 'BNB', 'XRP', 'GOLD', 'US100']) {
      assert.ok(!eligibleSyms.includes(sym), `${sym} must not be auto-exec eligible`);
    }
  });
});

describe('Kill-switch toggleLiveTradingKillSwitch', () => {
  test('toggles _liveTradingEnabled OFF → ON → OFF', () => {
    const { app } = loadApp();
    // The harness boots with master OFF by default — confirm.
    assert.equal(app._liveTradingEnabled, false);
    app.toggleLiveTradingKillSwitch();
    assert.equal(app._liveTradingEnabled, true,  'first tap arms');
    app.toggleLiveTradingKillSwitch();
    assert.equal(app._liveTradingEnabled, false, 'second tap disarms');
  });

  test('respects whatever state setLiveTradingEnabled put us in', () => {
    const { app } = loadApp();
    app.setLiveTradingEnabled(true);
    assert.equal(app._liveTradingEnabled, true);
    app.toggleLiveTradingKillSwitch();
    assert.equal(app._liveTradingEnabled, false, 'kill-switch overrides programmatic enable');
  });
});
