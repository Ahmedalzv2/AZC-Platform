import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, forceLeverage } from './harness.mjs';

describe('Trade-mode policy (v6 — post-90d-OOS research)', () => {
  test('DEFAULT_TRADE_MODES still flags SOL/SILVER/US100/GOLD as futures', () => {
    const { app } = loadApp();
    assert.equal(app.DEFAULT_TRADE_MODES.SOL, 'futures');
    assert.equal(app.DEFAULT_TRADE_MODES.SILVER, 'futures');
    assert.equal(app.DEFAULT_TRADE_MODES.US100,  'futures');
    assert.equal(app.DEFAULT_TRADE_MODES.GOLD,   'futures');
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
    assert.equal(app._mexcContractSymbol({ symbol: 'SOL' }), 'SOL_USDT');
  });

  test('still returns SILVER_USDT for SILVER (backwards-compat)', () => {
    const { app } = loadApp();
    assert.equal(app._mexcContractSymbol({ symbol: 'SILVER' }), 'SILVER_USDT');
  });
});

describe('getAssetLeverage / setAssetLeverage per-asset cap (10–25× post-research)', () => {
  test('Trio (SILVER/SOL/GOLD) default 10×, cap 25×', () => {
    const { app } = loadApp();
    for (const sym of ['SILVER', 'SOL', 'GOLD']) {
      assert.equal(app.ASSET_LEVERAGE_SPEC[sym].def, 10, `${sym} default`);
      assert.equal(app.ASSET_LEVERAGE_SPEC[sym].max, 25, `${sym} cap`);
      assert.equal(app.setAssetLeverage(sym, 200), 25, `${sym} clamps to new cap`);
      assert.equal(app.setAssetLeverage(sym, 10), 10);
      assert.equal(app.setAssetLeverage(sym, 0), 1, `${sym} clamps low`);
    }
  });

  test('No asset reaches LEVERAGE_HIGH_THRESHOLD via normal API (survival mode unreachable)', () => {
    const { app } = loadApp();
    for (const sym of ['SILVER', 'SOL', 'GOLD', 'BTC', 'ETH']) {
      app.setAssetLeverage(sym, 100);
      assert.equal(app._isHighLeverage(sym), false, `${sym} at clamped max should NOT be high-lev`);
    }
  });

  test('forceLeverage test helper bypasses the cap to exercise survival-mode code', () => {
    const { app } = loadApp();
    forceLeverage(app, 'SOL', 200);
    assert.equal(app.getAssetLeverage('SOL'), 200);
    assert.equal(app._isHighLeverage('SOL'), true);
  });

  test('Unknown asset falls back to generic default (def=10, max=25)', () => {
    const { app } = loadApp();
    assert.equal(app.ASSET_LEVERAGE_SPEC.NEVER_HEARD, undefined);
    assert.equal(app.getAssetLeverage('NEVER_HEARD'), 10);
    assert.equal(app.setAssetLeverage('NEVER_HEARD', 500), 25);
    assert.equal(app.setAssetLeverage('NEVER_HEARD', 20), 20);
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

  test('GOLD maps to XAUT_USDT on MEXC (Tether Gold perp)', () => {
    const { app } = loadApp();
    assert.equal(app._mexcContractSymbol({ symbol: 'GOLD' }), 'XAUT_USDT');
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

describe('Auto-fire gate (post-90d-OOS — disabled in production)', () => {
  test('_scalpAutoFireEnabled defaults to false (production safe)', () => {
    const { app } = loadApp();
    assert.equal(app.getScalpAutoFire(), false);
  });

  test('setScalpAutoFire(true) / (false) toggles the gate', () => {
    const { app } = loadApp();
    assert.equal(app.setScalpAutoFire(true), true);
    assert.equal(app.getScalpAutoFire(), true);
    assert.equal(app.setScalpAutoFire(false), false);
    assert.equal(app.getScalpAutoFire(), false);
  });
});

describe('Kill-switch toggleLiveTradingKillSwitch', () => {
  test('toggles _liveTradingEnabled OFF → ON → OFF', () => {
    const { app } = loadApp();
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
