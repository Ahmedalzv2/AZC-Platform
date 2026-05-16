import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('Trade-mode policy: futures vs spot', () => {
  test('DEFAULT_TRADE_MODES (v4): SILVER, US100, SOL, GOLD = futures; rest = spot', () => {
    const { app } = loadApp();
    // The harness doesn't run window.onload, so loadTradeModes never seeds
    // tradeMode onto the ASSETS. Call it explicitly so policy is in effect.
    app.loadTradeModes();
    const modes = app.DEFAULT_TRADE_MODES;
    assert.equal(modes.SILVER, 'futures');
    assert.equal(modes.US100,  'futures');
    assert.equal(modes.SOL,    'futures', 'v3: SOL for weekend coverage');
    assert.equal(modes.GOLD,   'futures', 'v4: GOLD joins the trio (XAUT_USDT on MEXC)');
    assert.equal(modes.BTC,    'spot');
    assert.equal(modes.ETH,    'spot');
    assert.equal(modes.BNB,    'spot');
    assert.equal(modes.XRP,    'spot');
    assert.equal(modes.SUI,    'spot');
    assert.equal(modes.ASTR,   'spot');
  });

  test('loadTradeModes seeds every ASSET with the right policy mode', () => {
    const { app } = loadApp();
    // The harness doesn't run window.onload, so loadTradeModes never seeds
    // tradeMode onto the ASSETS. Call it explicitly so policy is in effect.
    app.loadTradeModes();
    const seedFor = (sym) => app.ASSETS.find(a => a.symbol === sym)?.tradeMode;
    assert.equal(seedFor('SILVER'), 'futures');
    assert.equal(seedFor('US100'),  'futures');
    assert.equal(seedFor('SOL'),    'futures', 'SOL gets weekend coverage in v3');
    assert.equal(seedFor('BTC'),    'spot');
    assert.equal(seedFor('GOLD'),   'futures', 'v4: GOLD joins as default futures auto-exec asset');
  });

  test('_isFuturesAsset returns true only for futures-mode assets', () => {
    const { app } = loadApp();
    // The harness doesn't run window.onload, so loadTradeModes never seeds
    // tradeMode onto the ASSETS. Call it explicitly so policy is in effect.
    app.loadTradeModes();
    const silver = app.ASSETS.find(a => a.symbol === 'SILVER');
    const us100  = app.ASSETS.find(a => a.symbol === 'US100');
    const btc    = app.ASSETS.find(a => a.symbol === 'BTC');
    const gold   = app.ASSETS.find(a => a.symbol === 'GOLD');

    assert.equal(app._isFuturesAsset(silver), true);
    assert.equal(app._isFuturesAsset(us100),  true);
    assert.equal(app._isFuturesAsset(gold),   true,  'GOLD = futures in v4 (joins SOL + SILVER trio)');
    assert.equal(app._isFuturesAsset(btc),    false);
  });

  test('_isFuturesAsset is null-safe', () => {
    const { app } = loadApp();
    // The harness doesn't run window.onload, so loadTradeModes never seeds
    // tradeMode onto the ASSETS. Call it explicitly so policy is in effect.
    app.loadTradeModes();
    assert.equal(app._isFuturesAsset(null),       false);
    assert.equal(app._isFuturesAsset(undefined),  false);
    assert.equal(app._isFuturesAsset({}),         false);
  });

  test('_isFuturesAsset reflects current tradeMode (in case the asset is mutated at runtime)', () => {
    const { app } = loadApp();
    // The harness doesn't run window.onload, so loadTradeModes never seeds
    // tradeMode onto the ASSETS. Call it explicitly so policy is in effect.
    app.loadTradeModes();
    const a = app.ASSETS.find(x => x.symbol === 'BTC');
    assert.equal(app._isFuturesAsset(a), false);
    // Direct mutation (not the user-facing path) — just verifying the helper
    // looks at the current value, not a cached snapshot.
    a.tradeMode = 'futures';
    assert.equal(app._isFuturesAsset(a), true);
    a.tradeMode = 'spot';
    assert.equal(app._isFuturesAsset(a), false);
  });
});

describe('checkArmedAlerts: spot assets do NOT fire trade calls', () => {
  // Build a fake asset right at its entry zone so getSignal would normally
  // return 'enter' if mode wasn't a gate. The harness DOM stubs swallow
  // overlay/sound/vibration calls so we measure the journal effect.

  function setupAtEntry(app, symbol, mode) {
    const a = app.ASSETS.find(x => x.symbol === symbol);
    assert.ok(a, `asset ${symbol} not seeded`);
    a.tradeMode = mode;
    // Place price exactly at entry → getSignal returns 'enter'
    a.entry = 100;
    a.price = 100;
    a.sl    = 99;
    a.tp    = 102;
    a.tp1   = 102;
    // Score 12 (max) with all checks passing → strongest possible signal
    a.checks = a.checks.map(() => 1);
    a.bias   = 'BULLISH';
    return a;
  }

  test('futures asset at entry → checkArmedAlerts logs an alert', () => {
    // Pin wall clock to Thursday 08:00 UTC so isMarketClosed (now anchored
    // to America/Chicago) sees an open market regardless of when the test runs.
    const gst = new Date('2026-05-07T08:00:00Z');
    const { app } = loadApp({ now: gst });
    // The harness doesn't run window.onload, so loadTradeModes never seeds
    // tradeMode onto the ASSETS. Call it explicitly so policy is in effect.
    app.loadTradeModes();
    setupAtEntry(app, 'SILVER', 'futures');
    // Reset prevSignalMap so the escalation check fires
    app.prevSignalMap = {};
    app.alertLog = [];
    app.checkArmedAlerts(gst);
    const fired = app.alertLog.filter(x => x.symbol === 'SILVER');
    assert.ok(fired.length >= 1, 'SILVER should have fired an alert');
    assert.equal(fired[0].signal, 'enter');
  });

  test('spot asset at entry → checkArmedAlerts logs NO alert', () => {
    const { app } = loadApp();
    // The harness doesn't run window.onload, so loadTradeModes never seeds
    // tradeMode onto the ASSETS. Call it explicitly so policy is in effect.
    app.loadTradeModes();
    setupAtEntry(app, 'BTC', 'spot');
    app.prevSignalMap = {};
    app.alertLog = [];
    const gst = new Date('2026-05-07T08:00:00Z');
    app.checkArmedAlerts(gst);
    const fired = app.alertLog.filter(x => x.symbol === 'BTC');
    assert.equal(fired.length, 0, 'spot BTC must not fire ENTER NOW');
  });

  test('mixed: futures fires, spot stays silent in the same tick', () => {
    // Pin to Thursday 08:00 UTC (market open in Chicago time).
    const gst = new Date('2026-05-07T08:00:00Z');
    const { app } = loadApp({ now: gst });
    // The harness doesn't run window.onload, so loadTradeModes never seeds
    // tradeMode onto the ASSETS. Call it explicitly so policy is in effect.
    app.loadTradeModes();
    setupAtEntry(app, 'SILVER', 'futures');
    setupAtEntry(app, 'BTC',    'spot');
    setupAtEntry(app, 'ETH',    'spot');
    app.prevSignalMap = {};
    app.alertLog = [];
    app.checkArmedAlerts(gst);
    const symbols = app.alertLog.map(x => x.symbol);
    assert.ok(symbols.includes('SILVER'),  'SILVER (futures) should fire');
    assert.ok(!symbols.includes('BTC'),    'BTC (spot) must not fire');
    assert.ok(!symbols.includes('ETH'),    'ETH (spot) must not fire');
  });
});
