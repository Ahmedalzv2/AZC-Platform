import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('US100 trade-ready Telegram card', () => {
  function setupUs100Long(app, { entry = 29670, sl = 29620, tp = 29820 } = {}) {
    const a = app.ASSETS.find(x => x.symbol === 'US100');
    assert.ok(a, 'US100 not seeded');
    a.entry = entry; a.sl = sl; a.tp = tp; a.tp1 = tp;
    a.bias = 'BULLISH';
    a.price = entry;
    return a;
  }

  test('returns null for non-US100 assets', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const btc = app.ASSETS.find(x => x.symbol === 'BTC');
    assert.equal(app._buildUs100TradeCard(btc, 'enter'), null);
  });

  test('returns null when entry/SL are missing or identical', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const a = app.ASSETS.find(x => x.symbol === 'US100');
    a.entry = null; a.sl = 29620;
    assert.equal(app._buildUs100TradeCard(a, 'enter'), null);
    a.entry = 29670; a.sl = 29670;
    assert.equal(app._buildUs100TradeCard(a, 'enter'), null);
  });

  test('ENTER NOW card: header, levels, R:R, and sizing table all present', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    setupUs100Long(app);
    app._userCapital = { bank: 0, fpMarketsUs100: 562, lastUpdated: 0 };
    const card = app._buildUs100TradeCard(app.ASSETS.find(x => x.symbol === 'US100'), 'enter');
    assert.match(card, /🔴 US100 ENTER NOW — LONG/);
    assert.match(card, /Entry: 29,670\.00/);
    assert.match(card, /SL:.*29,620\.00.*-50 pts/);
    assert.match(card, /TP:.*29,820\.00.*\+150 pts/);
    assert.match(card, /R:R:\s+1:3\.0/);
    assert.match(card, /Sizing \(FP \$562 · \$1\/pt per 1\.0 lot\):/);
    assert.match(card, /0\.01 lot → \$0\.50 risk \(0\.1% FP\) ✓/);
    assert.match(card, /1\.00 lot → \$50\.00 risk \(8\.9% FP\) ⚠️/);
    assert.match(card, /→ 1% risk target ≈ 0\.11 lot/);
  });

  test('ALMOST ENTRY card uses 🟡 header', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    setupUs100Long(app);
    app._userCapital = { bank: 0, fpMarketsUs100: 562, lastUpdated: 0 };
    const card = app._buildUs100TradeCard(app.ASSETS.find(x => x.symbol === 'US100'), 'armed');
    assert.match(card, /🟡 US100 ALMOST ENTRY — LONG/);
  });

  test('SHORT bias inverts the pts sign convention', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const a = app.ASSETS.find(x => x.symbol === 'US100');
    a.entry = 29670; a.sl = 29720; a.tp = 29520; a.tp1 = 29520;
    a.bias = 'BEARISH';
    app._userCapital = { bank: 0, fpMarketsUs100: 562, lastUpdated: 0 };
    const card = app._buildUs100TradeCard(a, 'enter');
    assert.match(card, /SHORT/);
    assert.match(card, /SL:.*\+50 pts/);
    assert.match(card, /TP:.*-150 pts/);
  });

  test('FP=$0 suppresses the sizing table with a hint', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    setupUs100Long(app);
    app._userCapital = { bank: 0, fpMarketsUs100: 0, lastUpdated: 0 };
    const card = app._buildUs100TradeCard(app.ASSETS.find(x => x.symbol === 'US100'), 'enter');
    assert.match(card, /\(set FP balance to see lot sizing\)/);
    assert.doesNotMatch(card, /Sizing \(FP/);
  });

  test('tiny FP balance with wide SL surfaces "account too small"', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    setupUs100Long(app, { entry: 29670, sl: 28670, tp: 30670 });
    app._userCapital = { bank: 0, fpMarketsUs100: 5, lastUpdated: 0 };
    const card = app._buildUs100TradeCard(app.ASSETS.find(x => x.symbol === 'US100'), 'enter');
    assert.match(card, /account too small for this SL distance/);
  });
});
