import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('US100 Telegram outcome commands (/win /loss /be)', () => {
  function makeEntry({ id, time, signal, bias, entry, sl, tp, outcome, date, ts }) {
    return {
      id, date, time, symbol: 'US100', signal,
      bias, session: 'NY AM Kill Zone',
      entry, sl, tp, outcome,
      grade: 'a', score: 8, priceAtCall: entry, analysis: '',
      timestamp: ts || Date.now(),
    };
  }
  function todayLabel() { return new Date().toLocaleDateString('en-GB'); }

  test('_findPendingUs100JournalEntry: defaults to latest pending today', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const date = todayLabel();
    app.journal = [
      makeEntry({ id: 1, date, time: '13:42 GST', signal: 'enter', bias: 'BULLISH',
                  entry: 29650, sl: 29600, tp: 29750, outcome: 'win', ts: 1000 }),
      makeEntry({ id: 2, date, time: '14:30 GST', signal: 'enter', bias: 'BULLISH',
                  entry: 29680, sl: 29630, tp: 29780, outcome: null, ts: 2000 }),
      makeEntry({ id: 3, date, time: '18:55 GST', signal: 'armed', bias: 'BEARISH',
                  entry: 29700, sl: 29750, tp: 29600, outcome: null, ts: 3000 }),
    ];
    const e = app._findPendingUs100JournalEntry(null);
    assert.ok(e, 'should find a pending entry');
    assert.equal(e.id, 3, 'latest by timestamp wins');
  });

  test('_findPendingUs100JournalEntry: HH:MM filter narrows to a specific fire', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const date = todayLabel();
    app.journal = [
      makeEntry({ id: 1, date, time: '14:30 GST', signal: 'enter', bias: 'BULLISH',
                  entry: 29680, sl: 29630, tp: 29780, outcome: null, ts: 2000 }),
      makeEntry({ id: 2, date, time: '18:55 GST', signal: 'armed', bias: 'BEARISH',
                  entry: 29700, sl: 29750, tp: 29600, outcome: null, ts: 3000 }),
    ];
    const e = app._findPendingUs100JournalEntry('14:30');
    assert.ok(e);
    assert.equal(e.id, 1, 'time tag matched 14:30 fire');
  });

  test('_findPendingUs100JournalEntry: ignores resolved + non-US100 + other days', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const date = todayLabel();
    app.journal = [
      makeEntry({ id: 1, date, time: '13:42 GST', signal: 'enter', bias: 'BULLISH',
                  entry: 29650, sl: 29600, tp: 29750, outcome: 'loss', ts: 1000 }), // resolved
      { ...makeEntry({ id: 2, date, time: '14:00 GST', signal: 'enter', bias: 'BULLISH',
                       entry: 100, sl: 99, tp: 102, outcome: null, ts: 2000 }), symbol: 'BTC' },
      makeEntry({ id: 3, date: '01/01/2020', time: '15:00 GST', signal: 'enter', bias: 'BULLISH',
                  entry: 29680, sl: 29630, tp: 29780, outcome: null, ts: 3000 }), // wrong date
    ];
    assert.equal(app._findPendingUs100JournalEntry(null), null);
  });

  test('_executeTelegramAction (outcome=win): marks latest pending + sends confirm', () => {
    const fetches = [];
    const { app } = loadApp({
      fetch: async (url, opts) => {
        fetches.push({ url: String(url), body: opts && opts.body });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    });
    app.loadTradeModes();
    const date = todayLabel();
    app.journal = [
      makeEntry({ id: 42, date, time: '14:30 GST', signal: 'enter', bias: 'BULLISH',
                  entry: 29680, sl: 29630, tp: 29780, outcome: null, ts: 2000 }),
    ];
    app._executeTelegramAction({ type: 'outcome', outcome: 'win' });
    assert.equal(app.journal[0].outcome, 'win', 'outcome set on the entry');
    const notifyBody = fetches
      .map(f => f.body)
      .filter(b => b && b.includes('"text"'))
      .map(b => JSON.parse(b).text)
      .find(t => t.includes('US100'));
    assert.ok(notifyBody, 'confirmation push sent to /notify');
    assert.match(notifyBody, /✅ US100/);
    assert.match(notifyBody, /WIN/);
    assert.match(notifyBody, /\+2\.00R/);
  });

  test('_executeTelegramAction (outcome=loss): marks -1R confirmation', () => {
    const sent = [];
    const { app } = loadApp({
      fetch: async (url, opts) => {
        if (opts && opts.body) sent.push(opts.body);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    });
    app.loadTradeModes();
    const date = todayLabel();
    app.journal = [
      makeEntry({ id: 7, date, time: '14:30 GST', signal: 'enter', bias: 'BULLISH',
                  entry: 29680, sl: 29630, tp: 29780, outcome: null, ts: 2000 }),
    ];
    app._executeTelegramAction({ type: 'outcome', outcome: 'loss' });
    assert.equal(app.journal[0].outcome, 'loss');
    const msg = sent.map(b => { try { return JSON.parse(b).text; } catch { return ''; } })
                    .find(t => t.includes('US100'));
    assert.match(msg, /❌ US100/);
    assert.match(msg, /-1\.00R/);
  });

  test('_executeTelegramAction (outcome=win): no pending → warns instead of marking', () => {
    const sent = [];
    const { app } = loadApp({
      fetch: async (url, opts) => {
        if (opts && opts.body) sent.push(opts.body);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    });
    app.loadTradeModes();
    app.journal = []; // nothing to mark
    app._executeTelegramAction({ type: 'outcome', outcome: 'win', timeTag: '14:30' });
    const msg = sent.map(b => { try { return JSON.parse(b).text; } catch { return ''; } })
                    .find(t => t.startsWith('⚠'));
    assert.ok(msg, 'a warning was sent');
    assert.match(msg, /no pending US100 fire/);
  });

  test('_executeTelegramAction ignores unknown outcome values', () => {
    const { app } = loadApp({
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    });
    app.loadTradeModes();
    const date = todayLabel();
    app.journal = [
      makeEntry({ id: 9, date, time: '14:30 GST', signal: 'enter', bias: 'BULLISH',
                  entry: 29680, sl: 29630, tp: 29780, outcome: null, ts: 2000 }),
    ];
    app._executeTelegramAction({ type: 'outcome', outcome: 'pending' });
    assert.equal(app.journal[0].outcome, null, 'invalid outcome is a no-op');
  });
});
