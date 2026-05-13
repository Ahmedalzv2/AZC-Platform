import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('SOL trade-mode policy (v3 added SOL; v4 added GOLD)', () => {
  test('DEFAULT_TRADE_MODES.SOL = futures', () => {
    const { app } = loadApp();
    assert.equal(app.DEFAULT_TRADE_MODES.SOL, 'futures');
    // SILVER + US100 + GOLD also futures (v4). BTC and other crypto stay spot.
    assert.equal(app.DEFAULT_TRADE_MODES.SILVER, 'futures');
    assert.equal(app.DEFAULT_TRADE_MODES.US100,  'futures');
    assert.equal(app.DEFAULT_TRADE_MODES.GOLD,   'futures', 'v4: GOLD joins the trio');
    assert.equal(app.DEFAULT_TRADE_MODES.BTC,    'spot');
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

  // Note: the broader "any asset derives a contract" coverage now lives in
  // the dedicated _mexcContractSymbol suite further down — see those tests
  // for the full BTC/ETH/SUI/GOLD/US100 matrix.
});

describe('getAssetLeverage / setAssetLeverage per-asset cap', () => {
  test('SILVER default and cap are both 200x (trio scalp loop)', () => {
    const { app } = loadApp();
    assert.equal(app.ASSET_LEVERAGE_SPEC.SILVER.max, 200);
    assert.equal(app.ASSET_LEVERAGE_SPEC.SILVER.def, 200, 'default is now 200x — trio policy');
    assert.equal(app.setAssetLeverage('SILVER', 200), 200);
    assert.equal(app.setAssetLeverage('SILVER', 500), 200, 'clamped to SILVER cap');
    assert.equal(app.setAssetLeverage('SILVER', 5),   5);
  });

  test('SILVER at 200x is treated as high-lev (Survival Mode kicks in)', () => {
    const { app } = loadApp();
    app.setAssetLeverage('SILVER', 200);
    assert.equal(app._isHighLeverage('SILVER'), true,
      'SILVER@200x now inherits the same survival-mode pipeline as SOL@200x');
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

  test('Unknown asset falls back to generic default (def=10, max=200)', () => {
    // ASSET_LEVERAGE_DEFAULT bumped to {10, 200} so the user can flip ANY
    // asset to auto-exec and pick up to 200× without me having to whitelist
    // each symbol case-by-case.
    const { app } = loadApp();
    assert.equal(app.getAssetLeverage('NEVER_HEARD'), 10);
    assert.equal(app.setAssetLeverage('NEVER_HEARD', 500), 200);
    assert.equal(app.setAssetLeverage('NEVER_HEARD', 50), 50);
  });

  test('getSilverLeverage backwards-compat alias still works', () => {
    const { app } = loadApp();
    app.setAssetLeverage('SILVER', 7);
    assert.equal(app.getSilverLeverage(), 7);
    app.setSilverLeverage(4);
    assert.equal(app.getAssetLeverage('SILVER'), 4);
  });
});

describe('_mexcContractSymbol — any asset with a MEXC contract is eligible', () => {
  test('SILVER, SOL, BTC, ETH, BNB all derive a MEXC contract symbol', () => {
    // _mexcContractSymbol now delegates to _resolveSymbols, so any asset
    // whose .mexc field is non-null is eligible — no symbol-by-symbol
    // whitelist. The user wanted to add any asset without me having to
    // touch the code.
    const { app } = loadApp();
    assert.equal(app._mexcContractSymbol({ symbol: 'SILVER' }), 'SILVER_USDT');
    assert.equal(app._mexcContractSymbol({ symbol: 'SOL' }),    'SOL_USDT');
    assert.equal(app._mexcContractSymbol({ symbol: 'BTC' }),    'BTC_USDT');
    assert.equal(app._mexcContractSymbol({ symbol: 'ETH' }),    'ETH_USDT');
    assert.equal(app._mexcContractSymbol({ symbol: 'BNB' }),    'BNB_USDT');
    assert.equal(app._mexcContractSymbol({ symbol: 'XRP' }),    'XRP_USDT');
    assert.equal(app._mexcContractSymbol({ symbol: 'SUI' }),    'SUI_USDT');
    assert.equal(app._mexcContractSymbol({ symbol: 'ASTR' }),   'ASTR_USDT');
  });

  test('GOLD maps to GOLD_USDT on MEXC', () => {
    const { app } = loadApp();
    assert.equal(app._mexcContractSymbol({ symbol: 'GOLD' }), 'GOLD_USDT');
  });

  test('US100 returns null (CFD-only, not on MEXC)', () => {
    const { app } = loadApp();
    assert.equal(app._mexcContractSymbol({ symbol: 'US100' }), null);
  });

  test('null / unknown-shaped inputs return null safely', () => {
    const { app } = loadApp();
    assert.equal(app._mexcContractSymbol(null), null);
    assert.equal(app._mexcContractSymbol(undefined), null);
    assert.equal(app._mexcContractSymbol({}), null);
  });
});

describe('Default leverage spec applies to any asset not explicitly listed', () => {
  test('BTC unlisted → default 10×, max 200×', () => {
    const { app } = loadApp();
    // BTC isn't in ASSET_LEVERAGE_SPEC — should fall through to the
    // generic ASSET_LEVERAGE_DEFAULT.
    assert.equal(app.ASSET_LEVERAGE_SPEC.BTC, undefined);
    // No persisted value → returns the default.
    assert.equal(app.getAssetLeverage('BTC'), 10);
    // Accepts up to 200×, clamps higher.
    assert.equal(app.setAssetLeverage('BTC', 200), 200);
    assert.equal(app.setAssetLeverage('BTC', 500), 200);
    assert.equal(app.setAssetLeverage('BTC', 0), 1);
  });

  test('User can set ETH to 200× without me touching the code', () => {
    const { app } = loadApp();
    assert.equal(app.setAssetLeverage('ETH', 200), 200);
    assert.equal(app._isHighLeverage('ETH'), true);
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
