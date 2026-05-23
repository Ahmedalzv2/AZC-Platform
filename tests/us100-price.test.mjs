import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

// Stubs route by URL pattern. Four sources, in priority order:
//  (1) `<workerUrl>/us100` — user-configured Cloudflare Worker relay.
//  (2) `/api/us100-price` — same-origin server.mjs proxy for `npm start`
//      users.
//  (3) `https://tv-relay.srv1688368.hstgr.cloud/us100` — default public VPS
//      relay (server.mjs hosted behind Traefik). Lets github.io users without
//      their own Cloudflare Worker still get live FPMARKETS:US100. Distinguish
//      from (1) by the explicit hostname.
//  (4) Nothing — leave seed price untouched.
function makeStubs({ worker, proxy, publicRelay, calls = { worker: 0, proxy: 0, publicRelay: 0 } }) {
  return async (url) => {
    const u = String(url);
    if (u.includes('tv-relay.srv1688368.hstgr.cloud/us100')) {
      calls.publicRelay++;
      return publicRelay ? publicRelay() : { ok: false, json: async () => ({}) };
    }
    if (u.includes('/us100') && !u.includes('/api/us100-price')) {
      calls.worker++;
      return worker ? worker() : { ok: false, json: async () => ({}) };
    }
    if (u.includes('/api/us100-price')) {
      calls.proxy++;
      return proxy ? proxy() : { ok: false, json: async () => ({}) };
    }
    return { ok: false, json: async () => ({}) };
  };
}

const ok = (price, source = 'CME_MINI:NQ1!') => () => ({
  ok: true,
  json: async () => ({ price, source, ts: Date.now() }),
});

describe('US100 price — worker primary, local proxy fallback', () => {
  test('Cloudflare Worker /us100 wins when configured and reachable', async () => {
    const calls = { worker: 0, proxy: 0 };
    const { app } = loadApp({
      fetch: makeStubs({ calls, worker: ok(29667.25), proxy: ok(99999) }),
    });
    app.loadTradeModes();
    app.setMexcWorkerUrl('https://my.workers.dev');
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 29667.25);
    assert.equal(calls.worker, 1);
    assert.equal(calls.proxy, 0, 'local proxy skipped when worker succeeds');
  });

  test('Falls back to /api/us100-price when worker is unreachable', async () => {
    const calls = { worker: 0, proxy: 0 };
    const { app } = loadApp({
      fetch: makeStubs({ calls, worker: null, proxy: ok(29670) }),
    });
    app.loadTradeModes();
    app.setMexcWorkerUrl('https://my.workers.dev');
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 29670);
    assert.equal(calls.worker, 1);
    assert.equal(calls.proxy, 1);
  });

  test('Skips worker call entirely when no worker URL is set', async () => {
    const calls = { worker: 0, proxy: 0 };
    const { app } = loadApp({
      fetch: makeStubs({ calls, worker: ok(29667), proxy: ok(29670) }),
    });
    app.loadTradeModes();
    // no setMexcWorkerUrl call
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 29670, 'falls straight to local proxy');
    assert.equal(calls.worker, 0, 'no worker URL → no worker fetch');
  });

  test('Leaves seed price untouched when every source fails', async () => {
    const { app } = loadApp({
      fetch: makeStubs({ worker: null, proxy: null }),
    });
    app.loadTradeModes();
    app.setMexcWorkerUrl('https://my.workers.dev');
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    us100.price = 12345;
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 12345);
  });

  test('Worker URL with trailing slash is normalized', async () => {
    const captured = [];
    const { app } = loadApp({
      fetch: async (url) => {
        captured.push(String(url));
        if (String(url).endsWith('/us100')) {
          return { ok: true, json: async () => ({ price: 29667, source: 'CME_MINI:NQ1!' }) };
        }
        return { ok: false, json: async () => ({}) };
      },
    });
    app.loadTradeModes();
    app.setMexcWorkerUrl('https://my.workers.dev/');
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    await app.fetchNonBinancePrices();
    assert.equal(us100.price, 29667);
    assert.ok(captured.some(u => u === 'https://my.workers.dev/us100'),
      'trailing slash on worker URL stripped before appending /us100');
  });
});
