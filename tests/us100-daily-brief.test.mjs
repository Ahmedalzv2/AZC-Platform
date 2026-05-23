import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('US100 daily brief', () => {
  function gstAt(hour, minute = 0, dayOffset = 0) {
    // Construct a Date that, when read with .getHours()/getMinutes(), yields
    // the requested GST values — matching getGST()'s convention of returning
    // a Date offset by +4h.
    const base = new Date(Date.UTC(2026, 4, 7 + dayOffset, hour, minute));
    return new Date(base.getTime() + base.getTimezoneOffset() * 60000);
  }

  test('_buildUs100DailyBrief includes bias, price, plan, news section, and FP status', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    us100.price = 29670; us100.entry = 29650; us100.sl = 29600; us100.tp1 = 29800;
    us100.tfEntries = {
      '1d': { dir: 'bull', score: 4 },
      '4h': { dir: 'bull', score: 3 },
    };
    app._userCapital = { bank: 0, fpMarketsUs100: 562, lastUpdated: 0 };
    const gst = gstAt(12, 30);
    const text = app._buildUs100DailyBrief(gst);
    assert.match(text, /📅 US100 DAILY BRIEF/);
    assert.match(text, /Bias/);
    assert.match(text, /1D: 🟢 BULL · q4/);
    assert.match(text, /4H: 🟢 BULL · q3/);
    assert.match(text, /Price: 29,670\.00/);
    assert.match(text, /Entry 29,650\.00 \(20 pts away\)/);
    assert.match(text, /SL\s+29,600\.00/);
    assert.match(text, /TP\s+29,800\.00/);
    assert.match(text, /KZs: London 08–10/);
    assert.match(text, /FP: \$562 · alerts active/);
  });

  test('brief includes Levels to watch when 1D has prevBar / NDOG / NWOG', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    us100.price = 29670; us100.entry = 29650; us100.sl = 29600; us100.tp1 = 29800;
    us100.tfEntries = {
      '1d': {
        dir: 'bull', score: 4,
        prevBarHigh: 29800, prevBarLow: 29400,
        ndog: { hi: 29680, lo: 29620 },
        nwog: { hi: 29750, lo: 29550 },
      },
      '4h': { dir: 'bull', score: 3 },
    };
    app._userCapital = { bank: 0, fpMarketsUs100: 562, lastUpdated: 0 };
    const text = app._buildUs100DailyBrief(gstAt(12, 30));
    assert.match(text, /Levels to watch/);
    assert.match(text, /PDH 29,800\.00/);
    assert.match(text, /PDL 29,400\.00/);
    assert.match(text, /NDOG 29,620\.00–29,680\.00/);
    assert.match(text, /NWOG 29,550\.00–29,750\.00/);
  });

  test('_us100KeyLevels returns nulls when 1D analysis is missing', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    us100.tfEntries = null;
    const lvls = app._us100KeyLevels(us100);
    assert.equal(lvls.pdh, null);
    assert.equal(lvls.pdl, null);
    assert.equal(lvls.ndog, null);
    assert.equal(lvls.nwog, null);
  });

  test('brief falls back gracefully when tfEntries missing and no plan', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    us100.price = 0; us100.entry = 0; us100.sl = 0;
    us100.tfEntries = null;
    app._userCapital = { bank: 0, fpMarketsUs100: 0, lastUpdated: 0 };
    const gst = gstAt(12, 30);
    const text = app._buildUs100DailyBrief(gst);
    assert.match(text, /1D: — \(pending HTF sync\)/);
    assert.match(text, /4H: — \(pending HTF sync\)/);
    assert.match(text, /Plan: no active levels/);
    assert.match(text, /⚠ FP=\$0/);
  });

  test('_maybeFireDailyUs100Brief: weekday in window with FP > 0 → fires once, dedupes', () => {
    const { app, sandbox } = loadApp({
      storage: {},
    });
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    us100.price = 29670; us100.entry = 29650; us100.sl = 29600; us100.tp1 = 29800;
    us100.tfEntries = { '1d': { dir: 'bull', score: 4 }, '4h': { dir: 'bull', score: 3 } };
    app._userCapital = { bank: 0, fpMarketsUs100: 562, lastUpdated: 0 };
    // Thursday May 7 2026 — known weekday.
    const gst = gstAt(12, 32);
    assert.equal(gst.getDay(), 4, 'sanity: should be Thursday');
    assert.equal(app._maybeFireDailyUs100Brief(gst), true,  'first fire should send');
    assert.equal(app._maybeFireDailyUs100Brief(gst), false, 'second call same day → dedupe');
  });

  test('_maybeFireDailyUs100Brief: outside window → no fire', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    app._userCapital = { bank: 0, fpMarketsUs100: 562, lastUpdated: 0 };
    assert.equal(app._maybeFireDailyUs100Brief(gstAt(11, 0)),  false, 'before window');
    assert.equal(app._maybeFireDailyUs100Brief(gstAt(12, 29)), false, 'just before');
    assert.equal(app._maybeFireDailyUs100Brief(gstAt(12, 35)), false, 'at end (exclusive)');
    assert.equal(app._maybeFireDailyUs100Brief(gstAt(15, 0)),  false, 'after window');
  });

  test('_maybeFireDailyUs100Brief: weekend → no fire', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    app._userCapital = { bank: 0, fpMarketsUs100: 562, lastUpdated: 0 };
    // May 9 2026 is Saturday; +2 days from May 7 (Thursday).
    const sat = gstAt(12, 32, 2);
    assert.equal(sat.getDay(), 6, 'sanity: should be Saturday');
    assert.equal(app._maybeFireDailyUs100Brief(sat), false);
  });

  test('_maybeFireDailyUs100Brief: FP=$0 → no fire (capital gate)', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    app._userCapital = { bank: 0, fpMarketsUs100: 0, lastUpdated: 0 };
    assert.equal(app._maybeFireDailyUs100Brief(gstAt(12, 32)), false);
  });
});
