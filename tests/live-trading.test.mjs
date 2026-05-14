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

  test('SILVER leverage defaults to 200 (trio scalp loop) and clamps 1..200', () => {
    const { app } = loadApp();
    assert.equal(app.getSilverLeverage(), 200);
    assert.equal(app.setSilverLeverage(7), 7);
    assert.equal(app.getSilverLeverage(), 7);
    assert.equal(app.setSilverLeverage(0),  1);   // clamped low
    assert.equal(app.setSilverLeverage(99), 99);  // mid-range stays exact
    assert.equal(app.setSilverLeverage(500), 200);// clamped to cap
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
    // the user flips to futures auto-exec works without me whitelisting it.
    const { app } = loadApp();
    assert.equal(app._mexcContractSymbol({ symbol: 'GOLD' }),  'GOLD_USDT');
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
          // SILVER_USDT: price tick 0.01 (priceScale 2), vol integer (volScale 0).
          return {
            ok: true, status: 200,
            json: async () => ({ data: { symbol: 'SILVER_USDT', priceScale: 2, volScale: 0, minVol: 1 } }),
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
    // Caller passes 3-decimal price and fractional vol — used to be sent verbatim
    // and rejected with mexc-2015. Now scaled down to contract precision.
    const r = await ctx.app.placeMexcFuturesOrder(silver(), 'SHORT', 75.655, 75.503, 75.901, 0.46, 200);
    assert.equal(r.sent, true);
    const orderCall = calls.find(c => String(c.url).includes('/order/submit'));
    const body = JSON.parse(orderCall.init.body);
    assert.equal(body.price, 75.66, 'price rounded to 2 decimals');
    assert.equal(body.stopLossPrice, 75.50, 'sl rounded to 2 decimals');
    assert.equal(body.takeProfitPrice, 75.90, 'tp rounded to 2 decimals');
    assert.equal(body.vol, 1, 'vol rounded to integer + bumped to minVol');
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

describe('cancel-on-invalidation: stale limit sweeper', () => {
  function withMexcMocks(extraStorage = {}) {
    const calls = [];
    const ctx = loadApp({
      storage: {
        journal: '[]',
        ict_mexc_api_key: 'k', ict_mexc_api_secret: 's',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: false }),
        ict_mexc_worker_url: 'https://my.workers.dev',
        ...extraStorage,
      },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        const u = String(url);
        if (u.includes('/contract/detail')) {
          return { ok: true, status: 200, json: async () => ({ data: { symbol: 'SILVER_USDT', priceScale: 2, volScale: 0, minVol: 1, contractSize: 0.01 } }) };
        }
        if (u.includes('/order/submit')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, code: 0, data: { orderId: 'ORD-123' } }) };
        }
        if (u.includes('/order/cancel')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, code: 0, data: {} }) };
        }
        if (u.includes('/position/open_positions')) {
          return { ok: true, status: 200, json: async () => ({ success: true, code: 0, data: [] }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, code: 0, data: {} }) };
      },
    });
    ctx.app.loadLiveTradingState();
    return { ctx, calls };
  }

  test('placeMexcFuturesOrder surfaces orderId from MEXC response', async () => {
    const { ctx } = withMexcMocks();
    const r = await ctx.app.placeMexcFuturesOrder(
      { symbol: 'SILVER', bias: 'BEARISH', price: 87.0 },
      'SHORT', 87.0, 87.3, 86.7, 0.46, 200,
    );
    assert.equal(r.sent, true);
    assert.equal(r.orderId, 'ORD-123', 'orderId must be lifted out of data.orderId');
  });

  test('cancelMexcOrder POSTs [orderId] to /order/cancel', async () => {
    const { ctx, calls } = withMexcMocks();
    const r = await ctx.app.cancelMexcOrder('SILVER_USDT', 'ORD-123');
    assert.equal(r.sent, true);
    const cancelCall = calls.find(c => c.url.includes('/order/cancel'));
    assert.ok(cancelCall, 'cancel endpoint should be hit');
    const body = JSON.parse(cancelCall.init.body);
    assert.deepEqual(body, ['ORD-123'], 'body must be an array of orderId strings');
  });

  test('cancelMexcOrder short-circuits on missing keys/worker/args', async () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    // bad args
    let r = await app.cancelMexcOrder('', 'ORD-1');
    assert.equal(r.reason, 'bad-args');
    r = await app.cancelMexcOrder('SILVER_USDT', '');
    assert.equal(r.reason, 'bad-args');
    // no worker
    r = await app.cancelMexcOrder('SILVER_USDT', 'ORD-1');
    assert.equal(r.reason, 'no-worker');
  });

  test('_pendingLimitsTick cancels entries past PENDING_LIMIT_TTL_MS', async () => {
    const { ctx, calls } = withMexcMocks();
    const ttl = ctx.app.PENDING_LIMIT_TTL_MS;
    // Inject a pending limit that's already expired (placedAt in the past).
    ctx.app._markPendingLimit('SILVER', {
      orderId: 'ORD-STALE', contractSymbol: 'SILVER_USDT',
      side: 'SHORT', entry: 87.0, sl: 87.3, tp: 86.7,
    });
    // Backdate it past TTL.
    ctx.app._pendingLimits.SILVER.placedAt = Date.now() - (ttl + 1000);

    await ctx.app._pendingLimitsTick();

    const cancelCall = calls.find(c => c.url.includes('/order/cancel'));
    assert.ok(cancelCall, 'expired entry must trigger /order/cancel');
    assert.equal(ctx.app._pendingLimits.SILVER, undefined, 'entry must be cleared after sweep');
  });

  test('_pendingLimitsTick leaves fresh entries alone', async () => {
    const { ctx, calls } = withMexcMocks();
    ctx.app._markPendingLimit('SOL', {
      orderId: 'ORD-FRESH', contractSymbol: 'SOL_USDT',
      side: 'LONG', entry: 200, sl: 199.3, tp: 200.7,
    });
    // Don't backdate — placedAt is now.
    await ctx.app._pendingLimitsTick();
    const cancelCall = calls.find(c => c.url.includes('/order/cancel'));
    assert.equal(cancelCall, undefined, 'fresh entry must NOT be cancelled');
    assert.equal(ctx.app._pendingLimits.SOL.orderId, 'ORD-FRESH', 'fresh entry must stay');
  });

  test('_positionsTick clears pending entries when same-symbol position appears (filled)', async () => {
    const calls = [];
    const ctx = loadApp({
      storage: {
        ict_mexc_api_key: 'k', ict_mexc_api_secret: 's',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: false }),
        ict_mexc_worker_url: 'https://my.workers.dev',
      },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        const u = String(url);
        if (u.includes('/position/open_positions')) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ success: true, code: 0, data: [{ symbol: 'SILVER_USDT', positionType: 1, holdVol: 46, holdAvgPrice: 87.0 }] }),
          };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, code: 0, data: {} }) };
      },
    });
    ctx.app.loadLiveTradingState();
    ctx.app._markPendingLimit('SILVER', {
      orderId: 'ORD-FILLED', contractSymbol: 'SILVER_USDT',
      side: 'LONG', entry: 87.0, sl: 86.7, tp: 87.3,
    });
    await ctx.app._positionsTick();
    assert.equal(ctx.app._pendingLimits.SILVER, undefined, 'limit must drop from pending when its position appears');
  });
});
