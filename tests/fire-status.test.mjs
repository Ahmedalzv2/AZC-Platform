import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('Policy v8 — only US100 is futures, every MEXC-eligible asset is spot watch', () => {
  test('DEFAULT_TRADE_MODES: GOLD/SOL/SILVER are spot (v8)', () => {
    const { app } = loadApp();
    assert.equal(app.DEFAULT_TRADE_MODES.GOLD,   'spot');
    assert.equal(app.DEFAULT_TRADE_MODES.SOL,    'spot');
    assert.equal(app.DEFAULT_TRADE_MODES.SILVER, 'spot');
    assert.equal(app.DEFAULT_TRADE_MODES.US100,  'futures', 'US100 is the only ICT lane');
  });

  test('loadTradeModes sets GOLD to spot', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const gold = app.ASSETS.find(a => a.symbol === 'GOLD');
    assert.equal(gold.tradeMode, 'spot');
    assert.equal(app._isFuturesAsset(gold), false);
  });

  test('GOLD still has a valid MEXC contract (XAUT_USDT) — usable if flipped manually', () => {
    const { app } = loadApp();
    assert.equal(app._mexcContractSymbol({ symbol: 'GOLD' }), 'XAUT_USDT');
  });

  test('Default futures-eligible set is empty under v8 (only US100, which is CFD-only)', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const eligible = app.ASSETS
      .filter(a => app._isFuturesAsset(a) && app._mexcContractSymbol(a))
      .map(a => a.symbol);
    assert.equal(eligible.length, 0, `v8: no default futures candidates have a MEXC contract (got ${eligible.join(',')})`);
    assert.ok(!eligible.includes('US100'), 'US100 is futures but CFD-only — no MEXC contract');
  });
});

describe('getFireStatus — at-a-glance trigger state', () => {
  // Under v8 SOL defaults to spot. The fire-status flow only kicks in for
  // futures-mode assets, so flip SOL back to futures explicitly for these
  // fixtures — the test is about getFireStatus behavior, not policy.
  function bootLive(app) {
    app.loadTradeModes();
    app.setLiveTradingEnabled(true);
    const sol = app.ASSETS.find(a => a.symbol === 'SOL');
    sol.tradeMode = 'futures';
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

  test('US100 stays manual ICT and does not mention exchange routing', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    const s = app.getFireStatus(us100);
    assert.equal(s.state, 'manual-ict');
    assert.match(s.label, /US100 ICT/);
    assert.doesNotMatch(`${s.label} ${s.detail}`, /MEXC|Force Fire/i);
  });

  test('master switch off → blocked LIVE OFF', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    // Master OFF (default in harness). Flip SOL to futures so fire-status
    // engages the live-trading gate rather than the spot manual path.
    const sol = app.ASSETS.find(a => a.symbol === 'SOL');
    sol.tradeMode = 'futures';
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
