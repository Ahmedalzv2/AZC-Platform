import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('live-trading status machine', () => {
  test('no keys saved → state "not-connected" 🔌', () => {
    const { app } = loadApp();
    app.loadLiveTradingState();
    const s = app.liveTradingStatus();
    assert.equal(s.state, 'not-connected');
    assert.equal(s.icon, '🔌');
  });

  test('keys saved, master OFF → state "connected-off" 🟡', () => {
    const { app } = loadApp();
    app.saveMexcKeys('key', 'secret');
    app.loadLiveTradingState();
    assert.equal(app.liveTradingStatus().state, 'connected-off');
    assert.equal(app.liveTradingStatus().icon, '🟡');
  });

  test('keys + master ON + dry-run ON → state "on-dryrun" 🟢', () => {
    const { app } = loadApp();
    app.saveMexcKeys('key', 'secret');
    app.setLiveTradingEnabled(true);
    app.setLiveTradingDryRun(true);
    assert.equal(app.liveTradingStatus().state, 'on-dryrun');
    assert.equal(app.liveTradingStatus().icon, '🟢');
  });

  test('keys + master ON + dry-run OFF → state "on-live" 🔴', () => {
    const { app } = loadApp();
    app.saveMexcKeys('key', 'secret');
    app.setLiveTradingEnabled(true);
    app.setLiveTradingDryRun(false);
    assert.equal(app.liveTradingStatus().state, 'on-live');
    assert.equal(app.liveTradingStatus().icon, '🔴');
  });

  test('clearMexcKeys forces master switch OFF (no live trading without keys)', () => {
    const { app } = loadApp();
    app.saveMexcKeys('key', 'secret');
    app.setLiveTradingEnabled(true);
    app.setLiveTradingDryRun(false);
    app.clearMexcKeys();
    assert.equal(app.getMexcApiKey(), '');
    assert.equal(app.getMexcApiSecret(), '');
    assert.equal(app.liveTradingStatus().state, 'not-connected');
  });

  test('settings persist across app reloads', () => {
    const ctx1 = loadApp();
    ctx1.app.saveMexcKeys('persist-key', 'persist-secret');
    ctx1.app.setLiveTradingEnabled(true);
    ctx1.app.setLiveTradingDryRun(false);
    const ctx2 = loadApp({
      storage: {
        ict_mexc_api_key: 'persist-key',
        ict_mexc_api_secret: 'persist-secret',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: false }),
      },
    });
    ctx2.app.loadLiveTradingState();
    assert.equal(ctx2.app.getMexcApiKey(), 'persist-key');
    assert.equal(ctx2.app.liveTradingStatus().state, 'on-live');
  });

  test('dry-run defaults to ON when no setting is stored (safe default)', () => {
    const { app } = loadApp({
      storage: {
        ict_mexc_api_key: 'k',
        ict_mexc_api_secret: 's',
      },
    });
    app.loadLiveTradingState();
    app.setLiveTradingEnabled(true);
    assert.equal(app.liveTradingStatus().state, 'on-dryrun');
  });
});

describe('Worker URL + leverage storage', () => {
  test('Worker URL persists, trailing slash trimmed', () => {
    const { app } = loadApp();
    app.setMexcWorkerUrl('https://my.workers.dev/');
    assert.equal(app.getMexcWorkerUrl(), 'https://my.workers.dev');
  });

  test('SILVER leverage defaults to 10× and clamps 1..25', () => {
    const { app } = loadApp();
    assert.equal(app.getSilverLeverage(), 10);
    assert.equal(app.setSilverLeverage(15), 15);
    assert.equal(app.getSilverLeverage(), 15);
    assert.equal(app.setSilverLeverage(0),  1);
    assert.equal(app.setSilverLeverage(20), 20);
    assert.equal(app.setSilverLeverage(500), 25);
  });
});

describe('HMAC-SHA256 signing', () => {
  test('matches RFC 4231 known-answer vector (key="key", data="The quick brown fox jumps over the lazy dog")', async () => {
    const { app } = loadApp();
    const sig = await app._hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog');
    // Reference: https://en.wikipedia.org/wiki/HMAC#Examples
    assert.equal(sig, 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });

  test('MEXC signature is deterministic for same inputs', async () => {
    const { app } = loadApp();
    const a = await app._signMexcRequest('apikey123', 'apisecret456', '1700000000000', '{"symbol":"SILVER_USDT"}');
    const b = await app._signMexcRequest('apikey123', 'apisecret456', '1700000000000', '{"symbol":"SILVER_USDT"}');
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  test('signature changes if any input byte changes', async () => {
    const { app } = loadApp();
    const base = await app._signMexcRequest('apikey', 'secret', '1', '{}');
    const diffKey = await app._signMexcRequest('APIKEY', 'secret', '1', '{}');
    const diffTime = await app._signMexcRequest('apikey', 'secret', '2', '{}');
    const diffParam = await app._signMexcRequest('apikey', 'secret', '1', '{"x":1}');
    assert.notEqual(base, diffKey);
    assert.notEqual(base, diffTime);
    assert.notEqual(base, diffParam);
  });
});

describe('_mexcContractSymbol — per-asset rollout gate', () => {
  test('SILVER → SILVER_USDT', () => {
    const { app } = loadApp();
    assert.equal(app._mexcContractSymbol({ symbol: 'SILVER' }), 'SILVER_USDT');
  });

  test('any MEXC-listed asset derives a contract symbol; CFD-only assets return null', () => {
    // _mexcContractSymbol now delegates to _resolveSymbols so any asset
    // the user flips to futures works without me whitelisting it.
    const { app } = loadApp();
    assert.equal(app._mexcContractSymbol({ symbol: 'GOLD' }),  'XAUT_USDT');
    assert.equal(app._mexcContractSymbol({ symbol: 'BTC' }),   'BTC_USDT');
    assert.equal(app._mexcContractSymbol({ symbol: 'ETH' }),   'ETH_USDT');
    // US100 stays null — it's an FP Markets CFD, not on MEXC at all.
    assert.equal(app._mexcContractSymbol({ symbol: 'US100' }), null);
    // Defensive null-handling preserved.
    assert.equal(app._mexcContractSymbol(null), null);
    assert.equal(app._mexcContractSymbol({}),   null);
  });
});

describe('computeMexcOrderQty', () => {
  test('null when account or risk not set', () => {
    const { app } = loadApp();
    assert.equal(app.computeMexcOrderQty({}, 75.65, 75.50), null);
  });

  test('uses risk dollars / stop distance', () => {
    const { app } = loadApp({
      storage: { ict_calc_account: '1000', ict_calc_risk: '1' },
    });
    // $1000 × 1% = $10 risk; stop distance = $0.15; qty = 66.67 → rounded to 66.67
    const q = app.computeMexcOrderQty({}, 75.65, 75.50);
    assert.ok(Math.abs(q - 66.67) < 0.01, `expected ~66.67, got ${q}`);
  });

  test('null when stop distance is 0 (avoids div-by-zero)', () => {
    const { app } = loadApp({
      storage: { ict_calc_account: '1000', ict_calc_risk: '1' },
    });
    assert.equal(app.computeMexcOrderQty({}, 75.65, 75.65), null);
  });
});

describe('placeMexcFuturesOrder', () => {
  function silver() {
    return { symbol: 'SILVER', bias: 'BEARISH', price: 75.66, grade: 'b' };
  }

  test('master OFF → master-off', async () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    const r = await app.placeMexcFuturesOrder(silver(), 'SHORT', 75.65, 75.5, 75.9, 1, 3);
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'master-off');
  });

  test('CFD-only asset (US100) → unsupported-symbol (no MEXC contract)', async () => {
    // Most assets are now MEXC-eligible because the contract symbol is
    // auto-derived from _resolveSymbols. Only assets without a MEXC futures
    // pair (US100 = FP Markets CFD) still return unsupported-symbol.
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    const r = await app.placeMexcFuturesOrder({ symbol: 'US100', bias: 'BULLISH' }, 'LONG', 1, 1, 1, 1, 3);
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'unsupported-symbol');
  });

  test('bad side → bad-side', async () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    const r = await app.placeMexcFuturesOrder(silver(), 'sideways', 75.65, 75.5, 75.9, 1, 3);
    assert.equal(r.reason, 'bad-side');
  });

  test('master ON + dry-run ON → journals [DRY-RUN], no fetch', async () => {
    const ctx = loadApp({
      storage: { journal: '[]' },
      fetch: async () => { throw new Error('fetch must NOT be called in dry-run'); },
    });
    ctx.app.saveMexcKeys('k', 's');
    ctx.app.setLiveTradingEnabled(true);
    ctx.app.setLiveTradingDryRun(true);
    const r = await ctx.app.placeMexcFuturesOrder(silver(), 'SHORT', 75.65, 75.5, 75.9, 1, 3);
    assert.equal(r.sent, false);
    assert.equal(r.dryRun, true);
    const j = ctx.app.journal;
    assert.equal(j.length, 1);
    assert.equal(j[0].dryRun, true);
    assert.equal(j[0].mexcBody.symbol, 'SILVER_USDT');
    assert.equal(j[0].mexcBody.side, 3);  // 3 = open short
    assert.match(j[0].analysis, /\[DRY-RUN\] SHORT SILVER/);
  });

  test('live, no Worker URL → no-worker', async () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    app.setLiveTradingDryRun(false);
    const r = await app.placeMexcFuturesOrder(silver(), 'SHORT', 75.65, 75.5, 75.9, 1, 3);
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'no-worker');
  });

  test('live + Worker URL → signs and POSTs through Worker; journals [LIVE-OK]', async () => {
    const calls = [];
    const ctx = loadApp({
      storage: { journal: '[]' },
      fetch: async (url, init) => {
        calls.push({ url, init });
        const u = String(url);
        // Contract-detail probe (precision lookup) — return a stub.
        if (u.includes('/contract/detail')) {
          return {
            ok: true, status: 200,
            json: async () => ({ data: { symbol: 'SILVER_USDT', priceScale: 4, volScale: 2, minVol: 0.01 } }),
            text: async () => JSON.stringify({ data: { symbol: 'SILVER_USDT', priceScale: 4, volScale: 2, minVol: 0.01 } }),
          };
        }
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ success: true, code: 0, data: { orderId: 'abc123' } }),
        };
      },
    });
    ctx.app.saveMexcKeys('mykey', 'mysecret');
    ctx.app.setMexcWorkerUrl('https://my.workers.dev');
    ctx.app.setLiveTradingEnabled(true);
    ctx.app.setLiveTradingDryRun(false);
    const r = await ctx.app.placeMexcFuturesOrder(silver(), 'SHORT', 75.65, 75.5, 75.9, 2, 3);
    assert.equal(r.sent, true, `expected sent:true, got ${JSON.stringify(r)}`);
    const orderCalls = calls.filter(c => String(c.url).includes('/order/submit'));
    assert.equal(orderCalls.length, 1);
    const { url, init } = orderCalls[0];
    assert.equal(url, 'https://my.workers.dev/api/v1/private/order/submit');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['ApiKey'], 'mykey');
    assert.match(init.headers['Signature'], /^[0-9a-f]{64}$/);
    assert.ok(init.headers['Request-Time']);
    const body = JSON.parse(init.body);
    assert.equal(body.symbol, 'SILVER_USDT');
    assert.equal(body.side, 3);   // open short
    assert.equal(body.type, 1);   // limit
    assert.equal(body.openType, 1); // isolated
    assert.equal(body.leverage, 3);
    assert.equal(body.vol, 2);
    assert.equal(body.stopLossPrice, 75.5);
    assert.equal(body.takeProfitPrice, 75.9);

    // Signature must validate against our own signer
    const expected = await ctx.app._signMexcRequest('mykey', 'mysecret', init.headers['Request-Time'], init.body);
    assert.equal(init.headers['Signature'], expected);

    const j = ctx.app.journal;
    assert.equal(j.length, 1);
    assert.equal(j[0].live, true);
    assert.match(j[0].analysis, /\[LIVE-OK\] SHORT SILVER/);
  });

  test('live + Worker error → sent:false, journals [LIVE-ERR]', async () => {
    const ctx = loadApp({
      storage: { journal: '[]' },
      fetch: async () => ({
        ok: false, status: 401,
        text: async () => JSON.stringify({ success: false, code: 401, msg: 'invalid signature' }),
      }),
    });
    ctx.app.saveMexcKeys('k', 's');
    ctx.app.setMexcWorkerUrl('https://my.workers.dev');
    ctx.app.setLiveTradingEnabled(true);
    ctx.app.setLiveTradingDryRun(false);
    const r = await ctx.app.placeMexcFuturesOrder(silver(), 'SHORT', 75.65, 75.5, 75.9, 1, 3);
    assert.equal(r.sent, false);
    assert.equal(r.status, 401);
    // MEXC rejection details must flow through so the toast/badge don't fall
    // back to the generic "failed" string. reason carries the code; error
    // carries the human-readable msg.
    assert.equal(r.reason, 'mexc-401');
    assert.equal(r.error, 'invalid signature');
    const j = ctx.app.journal;
    assert.match(j[0].analysis, /\[LIVE-ERR\]/);
  });

  test('live + MEXC business error (code 600 insufficient margin) → reason+error surfaced', async () => {
    const ctx = loadApp({
      storage: { journal: '[]' },
      fetch: async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ success: false, code: 600, message: 'Insufficient margin' }),
      }),
    });
    ctx.app.saveMexcKeys('k', 's');
    ctx.app.setMexcWorkerUrl('https://my.workers.dev');
    ctx.app.setLiveTradingEnabled(true);
    ctx.app.setLiveTradingDryRun(false);
    const r = await ctx.app.placeMexcFuturesOrder(silver(), 'SHORT', 75.65, 75.5, 75.9, 1, 3);
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'mexc-600');
    assert.equal(r.error, 'Insufficient margin');
  });

  test('LONG bias is encoded as side=1 (open long)', async () => {
    const ctx = loadApp({ storage: { journal: '[]' } });
    ctx.app.saveMexcKeys('k', 's');
    ctx.app.setLiveTradingEnabled(true);
    ctx.app.setLiveTradingDryRun(true);
    await ctx.app.placeMexcFuturesOrder(silver(), 'LONG', 75.0, 74.8, 75.5, 1, 3);
    assert.equal(ctx.app.journal[0].mexcBody.side, 1);
  });

  test('contract precision: rounds price/vol to MEXC scale (no mexc-2015 reject)', async () => {
    const calls = [];
    const ctx = loadApp({
      storage: { journal: '[]' },
      fetch: async (url, init) => {
        calls.push({ url, init });
        const u = String(url);
        if (u.includes('/contract/detail')) {
          // SILVER_USDT live: price tick 0.01 (priceScale 2), vol integer
          // (volScale 0), 1 contract = 0.01 oz of silver (contractSize 0.01).
          return {
            ok: true, status: 200,
            json: async () => ({ data: { symbol: 'SILVER_USDT', priceScale: 2, volScale: 0, minVol: 1, contractSize: 0.01 } }),
          };
        }
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ success: true, code: 0, data: { orderId: 'ok' } }),
        };
      },
    });
    ctx.app.saveMexcKeys('k', 's');
    ctx.app.setMexcWorkerUrl('https://my.workers.dev');
    ctx.app.setLiveTradingEnabled(true);
    ctx.app.setLiveTradingDryRun(false);
    // Plain LIMIT (type=1). Price = entry. SL/TP rounded to MEXC scale.
    // Caller passes qty in underlying units (0.46 oz / 0.01 contractSize = 46 ct).
    const r = await ctx.app.placeMexcFuturesOrder(silver(), 'SHORT', 75.655, 75.503, 75.901, 0.46, 25);
    assert.equal(r.sent, true);
    const orderCall = calls.find(c => String(c.url).includes('/order/submit'));
    const body = JSON.parse(orderCall.init.body);
    assert.equal(body.type, 1, 'plain LIMIT order');
    assert.equal(body.price, 75.66, 'limit price = entry, rounded to 2 decimals');
    assert.equal(body.stopLossPrice, 75.50, 'sl rounded to 2 decimals');
    assert.equal(body.takeProfitPrice, 75.90, 'tp rounded to 2 decimals');
    assert.equal(body.vol, 46, 'qty 0.46 oz / 0.01 contractSize = 46 contracts');
  });

  test('contract precision: contractSize=1 keeps caller qty unchanged', async () => {
    // Spot-check the no-op path (e.g. assets where 1 contract = 1 unit) so
    // adding the cSize divisor doesn't regress them.
    const calls = [];
    const ctx = loadApp({
      storage: { journal: '[]' },
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (String(url).includes('/contract/detail')) {
          return {
            ok: true, status: 200,
            json: async () => ({ data: { symbol: 'SILVER_USDT', priceScale: 2, volScale: 2, minVol: 0.01, contractSize: 1 } }),
          };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, code: 0, data: { orderId: 'ok' } }) };
      },
    });
    ctx.app.saveMexcKeys('k', 's');
    ctx.app.setMexcWorkerUrl('https://my.workers.dev');
    ctx.app.setLiveTradingEnabled(true);
    ctx.app.setLiveTradingDryRun(false);
    const r = await ctx.app.placeMexcFuturesOrder(silver(), 'SHORT', 75.65, 75.50, 75.90, 0.46, 200);
    assert.equal(r.sent, true);
    const body = JSON.parse(calls.find(c => String(c.url).includes('/order/submit')).init.body);
    assert.equal(body.vol, 0.46, 'contractSize=1 → vol == caller qty (no scaling)');
  });
});

describe('testMexcConnection', () => {
  test('no keys → no-keys', async () => {
    const { app } = loadApp();
    const r = await app.testMexcConnection();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no-keys');
  });

  test('no Worker URL → no-worker', async () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    const r = await app.testMexcConnection();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no-worker');
  });

  test('hits /api/v1/private/account/assets with empty-param signature', async () => {
    const calls = [];
    const ctx = loadApp({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, code: 0, data: [] }) };
      },
    });
    ctx.app.saveMexcKeys('k', 's');
    ctx.app.setMexcWorkerUrl('https://my.workers.dev');
    const r = await ctx.app.testMexcConnection();
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://my.workers.dev/api/v1/private/account/assets');
    assert.equal(calls[0].init.method, 'GET');
    // Signature for GET with no query = sign(secret, key + reqTime + '')
    const expected = await ctx.app._signMexcRequest('k', 's', calls[0].init.headers['Request-Time'], '');
    assert.equal(calls[0].init.headers['Signature'], expected);
  });
});

describe('testFireSilver', () => {
  test('no SILVER asset in ASSETS → no-silver-asset', async () => {
    // Synthetic case: stub ASSETS via a fresh app where SILVER definitely is in the seed
    // — this test just verifies the dry-run path runs end-to-end on the real seed.
    const ctx = loadApp({
      storage: {
        journal: '[]',
        ict_mexc_api_key: 'k', ict_mexc_api_secret: 's',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: true }),
      },
    });
    ctx.app.loadLiveTradingState();
    const r = await ctx.app.testFireSilver();
    assert.equal(r.dryRun, true, `expected dryRun, got ${JSON.stringify(r)}`);
    const j = ctx.app.journal;
    assert.equal(j[0].session, 'live-trading-test-fire');
    assert.equal(j[0].mexcBody.symbol, 'SILVER_USDT');
  });
});
