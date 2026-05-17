import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('Policy v6 — manual futures candidates remain selectable', () => {
  test('DEFAULT_TRADE_MODES has GOLD = futures', () => {
    const { app } = loadApp();
    assert.equal(app.DEFAULT_TRADE_MODES.GOLD, 'futures');
    assert.equal(app.DEFAULT_TRADE_MODES.SOL,    'futures');
    assert.equal(app.DEFAULT_TRADE_MODES.SILVER, 'futures');
  });

  test('loadTradeModes promotes GOLD to futures', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const gold = app.ASSETS.find(a => a.symbol === 'GOLD');
    assert.equal(gold.tradeMode, 'futures');
    assert.equal(app._isFuturesAsset(gold), true);
  });

  test('GOLD has a valid MEXC contract (XAUT_USDT)', () => {
    const { app } = loadApp();
    assert.equal(app._mexcContractSymbol({ symbol: 'GOLD' }), 'XAUT_USDT');
  });

  test('Default futures candidates = {SOL, SILVER, GOLD}', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const eligible = app.ASSETS
      .filter(a => app._isFuturesAsset(a) && app._mexcContractSymbol(a))
      .map(a => a.symbol);
    assert.ok(eligible.includes('SOL'),    'SOL eligible');
    assert.ok(eligible.includes('SILVER'), 'SILVER eligible');
    assert.ok(eligible.includes('GOLD'),   'GOLD eligible');
    // US100 stays futures-mode but has no MEXC contract (CFD-only).
    assert.ok(!eligible.includes('US100'), 'US100 still excluded');
  });
});

describe('getFireStatus — at-a-glance trigger state', () => {
  function bootLive(app) {
    app.loadTradeModes();
    app.setLiveTradingEnabled(true);
    const sol = app.ASSETS.find(a => a.symbol === 'SOL');
    sol.price = 100;
    return sol;
  }

  test('null asset → blocked', () => {
    const { app } = loadApp();
    const s = app.getFireStatus(null);
    assert.equal(s.state, 'blocked');
  });

  test('spot-mode asset → manual', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const btc = app.ASSETS.find(a => a.symbol === 'BTC');
    const s = app.getFireStatus(btc);
    assert.equal(s.state, 'manual');
    assert.match(s.label, /SPOT/);
  });

  test('CFD-only futures asset (US100) → blocked (no MEXC contract)', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    const s = app.getFireStatus(us100);
    assert.equal(s.state, 'blocked');
    assert.match(s.label, /NO MEXC/);
  });

  test('master switch off → blocked LIVE OFF', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    // Master OFF (default in harness)
    const sol = app.ASSETS.find(a => a.symbol === 'SOL');
    sol.price = 100;
    const s = app.getFireStatus(sol);
    assert.equal(s.state, 'blocked');
    assert.match(s.label, /LIVE OFF/);
  });

  test('SOL scalp 1m within proximity → READY', () => {
    const { app } = loadApp();
    const sol = bootLive(app);
    app.setScalpTf('SOL', '1m');
    sol.bias = 'BULLISH';
    sol.tfEntries = {
      '1m': {
        dir: 'bull', entryReady: true, score: 4,
        fvgZone: { dir: 'bull', lo: 99.95, hi: 100.05, mid: 100.00 },
      },
    };
    const s = app.getFireStatus(sol);
    assert.equal(s.state, 'ready');
    assert.match(s.label, /READY/);
  });

  test('READY detail says auto-fire is disabled by default', () => {
    const { app } = loadApp();
    const sol = bootLive(app);
    app.setScalpTf('SOL', '1m');
    sol.bias = 'BULLISH';
    sol.tfEntries = {
      '1m': {
        dir: 'bull', entryReady: true, score: 4,
        fvgZone: { dir: 'bull', lo: 99.95, hi: 100.05, mid: 100.00 },
      },
    };
    const s = app.getFireStatus(sol);
    assert.match(s.detail, /auto-fire disabled/i);
  });

  test('SOL scalp 1m far → WAITING', () => {
    const { app } = loadApp();
    const sol = bootLive(app);
    app.setScalpTf('SOL', '1m');
    sol.bias = 'BULLISH';
    sol.tfEntries = {
      '1m': {
        dir: 'bull', entryReady: true, score: 4,
        fvgZone: { dir: 'bull', lo: 110, hi: 110.1, mid: 110.05 },
      },
    };
    const s = app.getFireStatus(sol);
    assert.equal(s.state, 'waiting');
    assert.match(s.label, /WAITING/);
  });

  test('no 1m setup yet → blocked NO SETUP', () => {
    const { app } = loadApp();
    const sol = bootLive(app);
    app.setScalpTf('SOL', '1m');
    sol.bias = 'BULLISH';
    sol.tfEntries = { '1m': { dir: null, entryReady: false, score: 0 } };
    const s = app.getFireStatus(sol);
    assert.equal(s.state, 'blocked');
    assert.match(s.label, /SETUP/);
  });

  test('asset.price = 0 (first sync gap) → blocked NO PRICE', () => {
    const { app } = loadApp();
    const sol = bootLive(app);
    sol.price = 0;
    const s = app.getFireStatus(sol);
    assert.equal(s.state, 'blocked');
    assert.match(s.label, /PRICE/);
  });
});
