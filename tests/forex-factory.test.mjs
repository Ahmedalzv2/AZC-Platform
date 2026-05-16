import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

const SAMPLE = [
  // High-impact USD: should map cleanly.
  { title: 'CPI m/m', country: 'USD', date: '2026-05-20T08:30:00-04:00', impact: 'High', forecast: '0.3%', previous: '0.4%' },
  // Medium-impact EUR: kept (ECB / euro-leg drives US100 + DXY).
  { title: 'ECB Press Conference', country: 'EUR', date: '2026-05-22T08:45:00-04:00', impact: 'Medium', forecast: '', previous: '' },
  // Other-currency event: dropped (we only trade USD-driven assets).
  { title: 'Manufacturing PMI', country: 'GBP', date: '2026-05-21T04:30:00+01:00', impact: 'High' },
  // "Holiday" / all-day USD entry: dropped to avoid spurious 00:00 blackouts.
  { title: 'Bank Holiday', country: 'USD', date: '2026-05-25T00:00:00-04:00', impact: 'Holiday' },
  // Lowercase impact field — should still normalize.
  { title: 'Retail Sales m/m', country: 'USD', date: '2026-05-26T08:30:00-04:00', impact: 'low' },
];

function stubFetch(payload, opts = {}) {
  let calls = 0;
  return async (url) => {
    calls++;
    if (opts.failFirst && calls === 1) return { ok: false, status: 502, json: async () => null };
    return { ok: true, status: 200, json: async () => payload };
  };
}

describe('fetchForexFactoryCalendar — free FairEconomy JSON feed', () => {
  test('parses USD + EUR events; drops other currencies; drops all-day holidays', async () => {
    const { app, sandbox } = loadApp();
    sandbox.fetch = stubFetch(SAMPLE);
    const events = await app.fetchForexFactoryCalendar(true);
    assert.equal(events.length, 3, `expected USD CPI + EUR ECB + USD Retail Sales, got ${events.length}`);
    const cpi = events.find(e => /CPI/.test(e.event));
    assert.ok(cpi, 'CPI event present');
    assert.equal(cpi.currency, 'USD');
    assert.equal(cpi.impact, 'high');
    // 08:30 EDT (UTC-4) → 12:30 UTC.
    assert.equal(cpi.time, '12:30');
    assert.equal(cpi.date, '2026-05-20');
    assert.ok(cpi.event.startsWith('[USD]'), 'event label prefixed with currency');
    // GBP filtered out.
    assert.ok(!events.find(e => e.currency === 'GBP'), 'non-USD/EUR currency dropped');
    // Holiday entry filtered out.
    assert.ok(!events.find(e => /Bank Holiday/.test(e.event)), 'all-day holiday dropped');
    // Lowercase impact field passes through (no NaN/undefined).
    const rs = events.find(e => /Retail Sales/.test(e.event));
    assert.equal(rs.impact, 'low');
  });

  test('cache TTL — repeat call within 30 min returns cached data without re-fetching', async () => {
    const { app, sandbox } = loadApp();
    let fetches = 0;
    sandbox.fetch = async () => { fetches++; return { ok: true, status: 200, json: async () => SAMPLE }; };
    await app.fetchForexFactoryCalendar(true);
    const before = fetches;
    await app.fetchForexFactoryCalendar(false);
    assert.equal(fetches, before, 'second call hit cache, no new fetch');
  });

  test('force=true bypasses cache', async () => {
    const { app, sandbox } = loadApp();
    let fetches = 0;
    sandbox.fetch = async () => { fetches++; return { ok: true, status: 200, json: async () => SAMPLE }; };
    await app.fetchForexFactoryCalendar(true);
    await app.fetchForexFactoryCalendar(true);
    assert.ok(fetches >= 2, `expected >=2 fetches with force=true, got ${fetches}`);
  });

  test('direct fetch fails → falls through to corsproxy fallback URL', async () => {
    const { app, sandbox } = loadApp();
    const urls = [];
    sandbox.fetch = async (url) => {
      urls.push(String(url));
      if (urls.length === 1) return { ok: false, status: 403, json: async () => null };
      return { ok: true, status: 200, json: async () => SAMPLE };
    };
    const events = await app.fetchForexFactoryCalendar(true);
    assert.equal(events.length, 3, 'fallback recovered events');
    assert.equal(urls.length, 2, 'tried direct then proxy');
    assert.ok(urls[0].includes('faireconomy.media'), 'first attempt is the direct feed');
    assert.ok(urls[1].includes('corsproxy.io'), 'second attempt is the corsproxy fallback');
  });

  test('all fetches fail → returns [] and caches empty result', async () => {
    const { app, sandbox } = loadApp();
    sandbox.fetch = async () => { throw new Error('network down'); };
    const events = await app.fetchForexFactoryCalendar(true);
    assert.ok(Array.isArray(events), 'returns an array even on total failure');
    assert.equal(events.length, 0, `expected empty array on total failure, got ${events.length}`);
    const cache = app._forexFactoryCache;
    assert.ok(Array.isArray(cache), 'cache stored as array');
    assert.equal(cache.length, 0, 'empty cache stored so we do not retry-storm');
  });

  test('populates _forexFactoryCache so getMacroBlackout can read live data', async () => {
    const { app, sandbox } = loadApp();
    sandbox.fetch = stubFetch(SAMPLE);
    await app.fetchForexFactoryCalendar(true);
    const cache = app._forexFactoryCache;
    assert.ok(Array.isArray(cache) && cache.length === 3);
    assert.ok(cache.every(e => e.source === 'forexfactory'));
    assert.ok(cache.every(e => e.category === 'econ'));
  });
});
