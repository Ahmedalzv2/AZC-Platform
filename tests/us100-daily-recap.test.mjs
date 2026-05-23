import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('US100 daily recap', () => {
  function gstAt(hour, minute = 0, dayOffset = 0) {
    const base = new Date(Date.UTC(2026, 4, 7 + dayOffset, hour, minute));
    return new Date(base.getTime() + base.getTimezoneOffset() * 60000);
  }

  function makeEntry({ time, signal, bias, session, entry, sl, tp, outcome, date }) {
    return {
      id: Date.now() + Math.random(),
      date, time, symbol: 'US100', signal, bias, session,
      entry, sl, tp, outcome,
      grade: 'a', score: 8, priceAtCall: entry, analysis: '',
      timestamp: Date.now(),
    };
  }

  test('_summarizeUs100Day buckets fires + computes net R from resolved outcomes', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const gst = gstAt(23, 0);
    const date = gst.toLocaleDateString('en-GB');
    app.journal = [
      makeEntry({ date, time: '13:42 GST', signal: 'enter', bias: 'BULLISH', session: 'NY AM Kill Zone',
                  entry: 29650, sl: 29600, tp: 29750, outcome: 'win' }),       // +2R
      makeEntry({ date, time: '14:30 GST', signal: 'enter', bias: 'BULLISH', session: 'NY AM Kill Zone',
                  entry: 29680, sl: 29630, tp: 29780, outcome: 'loss' }),      // -1R
      makeEntry({ date, time: '18:55 GST', signal: 'armed', bias: 'BEARISH', session: 'ICT Macro AM',
                  entry: 29700, sl: 29750, tp: 29600, outcome: null }),         // pending
      // Should be filtered: wrong symbol
      { ...makeEntry({ date, time: '15:00 GST', signal: 'enter', bias: 'BULLISH', session: 'NY AM',
                       entry: 100, sl: 99, tp: 102, outcome: 'win' }), symbol: 'BTC' },
      // Should be filtered: wrong date
      makeEntry({ date: '06/05/2026', time: '13:00 GST', signal: 'enter', bias: 'BULLISH', session: 'NY AM',
                  entry: 29500, sl: 29450, tp: 29600, outcome: 'win' }),
    ];
    const sum = app._summarizeUs100Day(gst);
    assert.equal(sum.fires.length, 3, 'only US100 + today');
    assert.equal(sum.wins, 1);
    assert.equal(sum.losses, 1);
    assert.equal(sum.pending, 1);
    assert.equal(sum.be, 0);
    // +2R - 1R = +1R
    assert.equal(sum.totalR.toFixed(2), '1.00');
  });

  test('_buildUs100DailyRecap formats signals + outcomes section + net R', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const gst = gstAt(23, 0);
    const date = gst.toLocaleDateString('en-GB');
    app.journal = [
      makeEntry({ date, time: '13:42 GST', signal: 'enter', bias: 'BULLISH', session: 'NY AM Kill Zone',
                  entry: 29650, sl: 29600, tp: 29750, outcome: 'win' }),
      makeEntry({ date, time: '18:55 GST', signal: 'armed', bias: 'BEARISH', session: 'ICT Macro AM',
                  entry: 29700, sl: 29750, tp: 29600, outcome: null }),
    ];
    app._userCapital = { bank: 0, fpMarketsUs100: 562, lastUpdated: 0 };
    const text = app._buildUs100DailyRecap(gst);
    assert.match(text, /📊 US100 DAILY RECAP/);
    assert.match(text, /Signals today: 2/);
    assert.match(text, /13:42 GST · NY AM Kill Zone · 🔴 ENTER LONG → ✅/);
    assert.match(text, /18:55 GST · ICT Macro AM · 🟡 ALMOST SHORT → ⏳/);
    assert.match(text, /✅ 1 win · ❌ 0 loss · ⚖ 0 BE · ⏳ 1 pending/);
    assert.match(text, /Net: \+2\.00R/);
    assert.match(text, /FP balance: \$562/);
    assert.match(text, /1 pending — set outcome in dashboard journal/);
  });

  test('recap on a quiet day reports "No signals fired"', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    app.journal = [];
    app._userCapital = { bank: 0, fpMarketsUs100: 562, lastUpdated: 0 };
    const text = app._buildUs100DailyRecap(gstAt(23, 0));
    assert.match(text, /No signals fired today\./);
    assert.match(text, /FP balance: \$562/);
    assert.doesNotMatch(text, /Outcomes/);
  });

  test('_maybeFireDailyUs100Recap: weekday in window with FP > 0 → fires once', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    app._userCapital = { bank: 0, fpMarketsUs100: 562, lastUpdated: 0 };
    app.journal = [];
    const gst = gstAt(23, 2);
    assert.equal(gst.getDay(), 4, 'sanity: Thursday');
    assert.equal(app._maybeFireDailyUs100Recap(gst), true);
    assert.equal(app._maybeFireDailyUs100Recap(gst), false, 'dedupes');
  });

  test('_maybeFireDailyUs100Recap: outside window / weekend / FP=$0 → no fire', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    app._userCapital = { bank: 0, fpMarketsUs100: 562, lastUpdated: 0 };
    assert.equal(app._maybeFireDailyUs100Recap(gstAt(22, 0)), false, 'before window');
    assert.equal(app._maybeFireDailyUs100Recap(gstAt(23, 5)), false, 'at end (exclusive)');
    // Saturday is May 9 2026 (+2 from Thursday May 7)
    assert.equal(app._maybeFireDailyUs100Recap(gstAt(23, 2, 2)), false, 'weekend');
    app._userCapital = { bank: 0, fpMarketsUs100: 0, lastUpdated: 0 };
    assert.equal(app._maybeFireDailyUs100Recap(gstAt(23, 2)), false, 'FP=$0');
  });
});
