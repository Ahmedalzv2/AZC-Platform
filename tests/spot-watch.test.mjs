import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

// All these tests use BTC (spot by default policy). We override entry/sl/tp1/tp2
// directly on the seeded ASSET so we don't depend on network-fetched klines —
// the helpers fall back to the manual setup when tfEntries are missing.

function btc(app, overrides = {}) {
  app.loadTradeModes();
  const a = app.ASSETS.find(x => x.symbol === 'BTC');
  Object.assign(a, { entry: 100, sl: 95, tp1: 110, tp2: 115, price: 100, ...overrides });
  // Force a fresh prev-zone map so transitions are clean across tests.
  app.prevSpotZoneMap = {};
  return a;
}

// The seeded ASSETS have realistic prices that may incidentally sit in their
// buy_at / sell_at bands (e.g. BNB, XRP), which fires unrelated toasts and
// blows up assertions in the asset-under-test. Park every other spot asset
// safely in 'mid' by widening their entry/tp1 around the current price.
function muteOtherSpot(app, keepSymbol) {
  app.ASSETS.forEach(a => {
    if (a.symbol === keepSymbol) return;
    if (app._isFuturesAsset(a)) return;
    const p = a.price || 100;
    a.entry = p * 0.5;  // far below — mid
    a.tp1   = p * 1.5;  // far above — mid
    a.tp2   = p * 1.6;
    a.sl    = p * 0.45;
  });
}

describe('getSpotLevels', () => {
  test('falls back to manual entry/sl/tp1/tp2 when tfEntries are absent', () => {
    const { app } = loadApp();
    const a = btc(app, { entry: 74000, sl: 73000, tp1: 78000, tp2: 80000, price: 75000 });
    a.tfEntries = null;
    const lv = app.getSpotLevels(a);
    assert.equal(lv.entry, 74000);
    assert.equal(lv.sl,    73000);
    assert.equal(lv.tp1,   78000);
    assert.equal(lv.tp2,   80000);
    assert.equal(lv.source, 'manual');
  });

  test('returns manual fallback when tfEntries.closed (weekend)', () => {
    const { app } = loadApp();
    const a = btc(app, { entry: 74000, tp1: 78000 });
    a.tfEntries = { closed: true, reopens: 'Sunday 22:00 GST' };
    const lv = app.getSpotLevels(a);
    assert.equal(lv.source, 'manual');
    assert.equal(lv.entry, 74000);
  });

  test('skips tfEntries with no dir or no FVG (no usable HTF setup)', () => {
    const { app } = loadApp();
    const a = btc(app, { entry: 100, tp1: 110 });
    a.tfEntries = {
      '1d': { dir: null, fvgZone: null },
      '4h': { dir: 'bull', fvgZone: null }, // FVG missing → _suggestedEntryForTf returns null
    };
    const lv = app.getSpotLevels(a);
    assert.equal(lv.source, 'manual');
  });
});

describe('getSpotZone', () => {
  test('AT BUY (within 0.5% of entry)', () => {
    const { app } = loadApp();
    const a = btc(app, { entry: 100, tp1: 110, price: 100.3 });
    const z = app.getSpotZone(a);
    assert.equal(z.state, 'buy_at');
    assert.ok(Math.abs(z.distancePct) <= 0.5);
  });

  test('NEAR BUY (within 3% of entry, outside 0.5%)', () => {
    const { app } = loadApp();
    const a = btc(app, { entry: 100, tp1: 110, price: 102 }); // 2% above buy zone
    const z = app.getSpotZone(a);
    assert.equal(z.state, 'buy_near');
  });

  test('AT SELL (within 0.5% of tp1)', () => {
    const { app } = loadApp();
    const a = btc(app, { entry: 100, tp1: 110, price: 109.7 });
    const z = app.getSpotZone(a);
    assert.equal(z.state, 'sell_at');
  });

  test('NEAR SELL (within 3% of tp1)', () => {
    const { app } = loadApp();
    const a = btc(app, { entry: 100, tp1: 110, price: 108 }); // 1.8% below sell zone
    // This is also 8% above the buy zone, so the helper picks the closer band → sell_near.
    const z = app.getSpotZone(a);
    assert.equal(z.state, 'sell_near');
  });

  test('MID (between bands)', () => {
    const { app } = loadApp();
    const a = btc(app, { entry: 100, tp1: 110, price: 105 }); // 5% above buy, 4.5% below sell
    const z = app.getSpotZone(a);
    assert.equal(z.state, 'mid');
    assert.equal(z.distancePct, null);
  });

  test('signed distancePct: positive above level, negative below', () => {
    const { app } = loadApp();
    const a = btc(app, { entry: 100, tp1: 110, price: 99.7 }); // below buy entry
    const z = app.getSpotZone(a);
    assert.equal(z.state, 'buy_at');
    assert.ok(z.distancePct < 0, 'price below entry should give negative distance');
  });
});

describe('checkSpotZones: transition-only toast (quiet, no overlay/sound)', () => {
  function spyToast() {
    const calls = [];
    return {
      fn: (msg, type) => { calls.push({ msg, type }); },
      calls,
    };
  }

  test('mid → buy_at fires one toast, second tick does NOT re-fire', () => {
    const { app } = loadApp();
    const spy = spyToast();
    app.showToast = spy.fn;
    const a = btc(app, { entry: 100, tp1: 110, price: 105 }); // mid
    muteOtherSpot(app, 'BTC');
    app.checkSpotZones(new Date());
    assert.equal(spy.calls.length, 0, 'mid state should not toast');

    a.price = 100.2; // → buy_at
    app.checkSpotZones(new Date());
    assert.equal(spy.calls.length, 1, 'first transition into buy_at should toast');
    assert.match(spy.calls[0].msg, /AT BUY ZONE/);
    assert.match(spy.calls[0].msg, /BTC/);

    // Same zone next tick — must not re-fire (sticky state).
    app.checkSpotZones(new Date());
    assert.equal(spy.calls.length, 1, 'sticky buy_at should not re-toast');
  });

  test('buy_near transition does NOT toast (only AT bands fire)', () => {
    const { app } = loadApp();
    const spy = spyToast();
    app.showToast = spy.fn;
    btc(app, { entry: 100, tp1: 110, price: 102 }); // buy_near
    muteOtherSpot(app, 'BTC');
    app.checkSpotZones(new Date());
    assert.equal(spy.calls.length, 0, 'NEAR transitions are silent');
  });

  test('mid → sell_at fires distribute toast', () => {
    const { app } = loadApp();
    const spy = spyToast();
    app.showToast = spy.fn;
    const a = btc(app, { entry: 100, tp1: 110, price: 105 });
    muteOtherSpot(app, 'BTC');
    app.checkSpotZones(new Date());
    a.price = 109.7; // sell_at
    app.checkSpotZones(new Date());
    assert.equal(spy.calls.length, 1);
    assert.match(spy.calls[0].msg, /AT SELL ZONE/);
    assert.match(spy.calls[0].msg, /distribute/);
  });

  test('futures assets are skipped (no toast even if at entry)', () => {
    const { app } = loadApp();
    const spy = spyToast();
    app.showToast = spy.fn;
    app.loadTradeModes();
    const silver = app.ASSETS.find(x => x.symbol === 'SILVER');
    Object.assign(silver, { entry: 75, tp1: 76, price: 75.0, sl: 74.5 });
    muteOtherSpot(app, 'SILVER');
    app.prevSpotZoneMap = {};
    app.checkSpotZones(new Date());
    assert.equal(spy.calls.length, 0, 'SILVER (futures) is gated out of spot watch');
    assert.equal(app.prevSpotZoneMap.SILVER, undefined, 'futures assets must not be tracked');
  });

  test('weekend-closed asset is skipped (isMarketClosed gate)', () => {
    const { app } = loadApp();
    const spy = spyToast();
    app.showToast = spy.fn;
    app.loadTradeModes();
    const gold = app.ASSETS.find(x => x.symbol === 'GOLD'); // GOLD is in WEEKEND_CLOSED_SYMBOLS
    Object.assign(gold, { entry: 4000, tp1: 4100, price: 4000.5, sl: 3950 });
    muteOtherSpot(app, 'GOLD');
    app.prevSpotZoneMap = {};
    // Saturday 12:00 GST → weekend closed
    const sat = new Date('2026-05-09T08:00:00Z');
    app.checkSpotZones(sat);
    assert.equal(spy.calls.length, 0, 'closed market skipped silently');
    assert.equal(app.prevSpotZoneMap.GOLD, undefined, 'closed asset must not be tracked');
  });

  test('no price (first sync gap) is skipped silently', () => {
    const { app } = loadApp();
    const spy = spyToast();
    app.showToast = spy.fn;
    const a = btc(app, { entry: 100, tp1: 110 });
    a.price = 0; // simulate first-load gap
    muteOtherSpot(app, 'BTC');
    app.checkSpotZones(new Date());
    assert.equal(spy.calls.length, 0);
  });
});
