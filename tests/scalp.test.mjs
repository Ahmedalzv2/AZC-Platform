import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('scalp mode storage', () => {
  test('all assets default to "htf" when not set', () => {
    const { app } = loadApp();
    assert.equal(app.getScalpTf('BTC'), 'htf');
    assert.equal(app.getScalpTf('ETH'), 'htf');
    assert.equal(app.getScalpTf('SILVER'), 'htf');
    assert.equal(app.getScalpTf('GOLD'), 'htf');
    assert.equal(app.getScalpTf('SOL'), 'htf');
  });

  test('valid values persist; invalid values are coerced to "htf"', () => {
    const { app } = loadApp();
    assert.equal(app.setScalpTf('BTC', '1m'), '1m');
    assert.equal(app.getScalpTf('BTC'), '1m');
    assert.equal(app.setScalpTf('BTC', 'bogus'), 'htf');
    assert.equal(app.getScalpTf('BTC'), 'htf');
  });

  test('per-asset isolation — explicit SILVER override does not affect BTC', () => {
    const { app } = loadApp();
    app.setScalpTf('SILVER', '1m');
    assert.equal(app.getScalpTf('SILVER'), '1m');
    assert.equal(app.getScalpTf('BTC'), 'htf');
  });
});

describe('_normalizeBiasDir', () => {
  test('BEARISH → bear', () => {
    const { app } = loadApp();
    assert.equal(app._normalizeBiasDir('BEARISH'), 'bear');
    assert.equal(app._normalizeBiasDir('Bear'), 'bear');
    assert.equal(app._normalizeBiasDir('bear'), 'bear');
  });

  test('BULLISH → bull', () => {
    const { app } = loadApp();
    assert.equal(app._normalizeBiasDir('BULLISH'), 'bull');
    assert.equal(app._normalizeBiasDir('bull'), 'bull');
  });

  test('null/empty/unknown → null', () => {
    const { app } = loadApp();
    assert.equal(app._normalizeBiasDir(null), null);
    assert.equal(app._normalizeBiasDir(''), null);
    assert.equal(app._normalizeBiasDir('NEUTRAL'), null);
  });
});

describe('scalpMonitorTick', () => {
  // Build a SILVER asset with a clean 1m bear setup matching HTF bias.
  function silverWithBear1m(priceOverride) {
    return {
      symbol: 'SILVER',
      bias: 'BEARISH',
      price: priceOverride !== undefined ? priceOverride : 75.65,
      grade: 'b',
      tfEntries: {
        '1m': {
          dir: 'bear',
          fvgZone: { dir: 'bear', lo: 75.55, mid: 75.65, hi: 75.75 },
          score: 3,
          entryReady: true,
        },
      },
    };
  }

  test('master OFF → master-off', async () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    app.setScalpTf('SILVER', '1m');
    const r = await app.scalpMonitorTick(silverWithBear1m());
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'master-off');
  });

  test('CFD-only asset (US100) → unsupported-symbol', async () => {
    // _mexcContractSymbol now returns the auto-derived contract for any
    // MEXC-listed asset, so the unsupported-symbol gate now only catches
    // CFD-only assets like US100.
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    const r = await app.scalpMonitorTick({ symbol: 'US100', bias: 'BULLISH', tfEntries: {} });
    assert.equal(r.reason, 'unsupported-symbol');
  });

  test('scalp tf is "htf" → scalp-off', async () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    // The test needs the HTF path regardless of the user's saved scalp mode.
    app.setScalpTf('SILVER', 'htf');
    const r = await app.scalpMonitorTick(silverWithBear1m());
    assert.equal(r.reason, 'scalp-off');
  });

  test('no tfEntries → no-tf-data', async () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    app.setScalpTf('SILVER', '1m');
    const r = await app.scalpMonitorTick({ symbol: 'SILVER', bias: 'BEARISH', price: 75.65, tfEntries: null });
    assert.equal(r.reason, 'no-tf-data');
  });

  test('tfEntries[tf] has error → no-tf-data', async () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    app.setScalpTf('SILVER', '1m');
    const r = await app.scalpMonitorTick({ symbol: 'SILVER', bias: 'BEARISH', price: 75.65, tfEntries: { '1m': { error: true } } });
    assert.equal(r.reason, 'no-tf-data');
  });

  test('tf has no FVG matching dir → no-tf-setup', async () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    app.setScalpTf('SILVER', '1m');
    // dir present but fvgZone missing → _suggestedEntryForTf returns null
    const r = await app.scalpMonitorTick({
      symbol: 'SILVER', bias: 'BEARISH', price: 75.65,
      tfEntries: { '1m': { dir: 'bear', score: 1 } },
    });
    assert.equal(r.reason, 'no-tf-setup');
  });

  test('HTF disagrees (1m bull, HTF BEARISH) → htf-disagrees', async () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    app.setScalpTf('SILVER', '1m');
    const r = await app.scalpMonitorTick({
      symbol: 'SILVER', bias: 'BEARISH', price: 75.65,
      tfEntries: {
        '1m': {
          dir: 'bull',
          fvgZone: { dir: 'bull', lo: 75.55, mid: 75.65, hi: 75.75 },
        },
      },
    });
    assert.equal(r.reason, 'htf-disagrees');
    assert.equal(r.sugDir, 'bull');
    assert.equal(r.htfDir, 'bear');
  });

  test('price too far from 1m entry → too-far', async () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    app.setScalpTf('SILVER', '1m');
    // Price 1% off 1m entry — well past 0.15% proximity threshold
    const r = await app.scalpMonitorTick(silverWithBear1m(76.5));
    assert.equal(r.reason, 'too-far');
    assert.ok(r.distPct > 0.15);
  });

  test('cross-asset gate applies (focus discipline)', async () => {
    const { app } = loadApp({
      storage: {
        ict_mexc_api_key: 'k', ict_mexc_api_secret: 's',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: true }),
        ict_scalp_tf_SILVER: '1m',
        ict_mexc_silver_leverage: '10',
      },
    });
    app.loadLiveTradingState();
    app._openPositions = { GOLD: [{ holdVol: 1, holdAvgPrice: 4715, leverage: 10 }] };
    const r = await app.scalpMonitorTick(silverWithBear1m());
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'in-position');
    assert.equal(r.blockingSym, 'GOLD');
  });

  test('global one-at-a-time → same asset in position → in-position', async () => {
    const { app } = loadApp({
      storage: {
        ict_mexc_api_key: 'k', ict_mexc_api_secret: 's',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: true }),
        ict_scalp_tf_SILVER: '1m',
      },
    });
    app.loadLiveTradingState();
    app._openPositions = { SILVER: [{ holdVol: 2, holdAvgPrice: 75.7, leverage: 200 }] };
    const r = await app.scalpMonitorTick(silverWithBear1m());
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'in-position');
    assert.equal(r.blockingSym, 'SILVER');
  });

  test('happy path + dry-run → fires, journals [DRY-RUN]', async () => {
    const ctx = loadApp({
      storage: {
        journal: '[]',
        ict_mexc_api_key: 'k', ict_mexc_api_secret: 's',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: true }),
        ict_scalp_tf_SILVER: '1m',
      },
    });
    ctx.app.loadLiveTradingState();
    ctx.app.setScalpAutoFire(true);
    const r = await ctx.app.scalpMonitorTick(silverWithBear1m());
    assert.equal(r.fired, true, `expected fired:true, got ${JSON.stringify(r)}`);
    assert.equal(r.side, 'SHORT');
    assert.equal(r.result.dryRun, true);
    const j = ctx.app.journal;
    assert.equal(j.length, 1);
    assert.equal(j[0].dryRun, true);
    assert.match(j[0].analysis, /\[DRY-RUN\] SHORT SILVER/);
  });

  test('happy path + live → signs and POSTs through Worker', async () => {
    const calls = [];
    const ctx = loadApp({
      storage: {
        journal: '[]',
        ict_mexc_api_key: 'mykey', ict_mexc_api_secret: 'mysecret',
        ict_mexc_worker_url: 'https://my.workers.dev',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: false }),
        ict_scalp_tf_SILVER: '1m',
      },
      fetch: async (url, init) => {
        calls.push({ url, init });
        const u = String(url);
        if (u.includes('/contract/detail')) {
          return {
            ok: true, status: 200,
            json: async () => ({ data: { symbol: 'SILVER_USDT', priceScale: 4, volScale: 2, minVol: 0.01 } }),
            text: async () => JSON.stringify({ data: { symbol: 'SILVER_USDT', priceScale: 4, volScale: 2, minVol: 0.01 } }),
          };
        }
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ success: true, code: 0, data: { orderId: 'scalp-1' } }),
        };
      },
    });
    ctx.app.loadLiveTradingState();
    ctx.app.setScalpAutoFire(true);
    const r = await ctx.app.scalpMonitorTick(silverWithBear1m());
    assert.equal(r.fired, true);
    assert.equal(r.result.sent, true);
    const orderCalls = calls.filter(c => String(c.url).includes('/order/submit'));
    assert.equal(orderCalls.length, 1);
    assert.equal(orderCalls[0].url, 'https://my.workers.dev/api/v1/private/order/submit');
    const body = JSON.parse(orderCalls[0].init.body);
    assert.equal(body.symbol, 'SILVER_USDT');
    assert.equal(body.side, 3); // 3 = open short
    assert.equal(body.type, 1, 'plain LIMIT order');
    assert.ok(Math.abs(body.price - 75.65) < 0.02, `limit price = entry, got ${body.price}`);
  });

  test('entry side mapping: bull FVG → side=1 (open LONG), bear FVG → side=3 (open SHORT)', async () => {
    // Explicit end-to-end verification of bias→side mapping. User reported
    // "trades always go other way" — this confirms the code mapping itself
    // is correct (any losing pattern they're seeing comes from signal
    // quality / fill selection bias, NOT inverted entries).
    function silverWithBull1m() {
      return {
        symbol: 'SILVER', bias: 'BULLISH', price: 75.65, grade: 'b',
        tfEntries: { '1m': { dir: 'bull', fvgZone: { dir: 'bull', lo: 75.55, mid: 75.65, hi: 75.75 }, score: 3, entryReady: true } },
      };
    }
    const bullCtx = loadApp({
      storage: { journal: '[]', ict_mexc_api_key: 'k', ict_mexc_api_secret: 's',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: true }), ict_scalp_tf_SILVER: '1m' },
    });
    bullCtx.app.loadLiveTradingState();
    bullCtx.app.setScalpAutoFire(true);
    const rBull = await bullCtx.app.scalpMonitorTick(silverWithBull1m());
    assert.equal(rBull.fired, true, `bull fire expected, got ${JSON.stringify(rBull)}`);
    assert.equal(rBull.side, 'LONG', 'bull FVG must map to LONG side');
    assert.equal(bullCtx.app.journal[0].mexcBody.side, 1, 'MEXC body.side must be 1 (open long) for bull');

    const bearCtx = loadApp({
      storage: { journal: '[]', ict_mexc_api_key: 'k', ict_mexc_api_secret: 's',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: true }), ict_scalp_tf_SILVER: '1m' },
    });
    bearCtx.app.loadLiveTradingState();
    bearCtx.app.setScalpAutoFire(true);
    const rBear = await bearCtx.app.scalpMonitorTick(silverWithBear1m());
    assert.equal(rBear.fired, true);
    assert.equal(rBear.side, 'SHORT', 'bear FVG must map to SHORT side');
    assert.equal(bearCtx.app.journal[0].mexcBody.side, 3, 'MEXC body.side must be 3 (open short) for bear');
  });

  test('SECOND fire within pending-fire lock is BLOCKED (closes the duplicate-fire race)', async () => {
    // Real-world bug: user ended up with 12 stacked SILVER trades because
    // _positionsTick (5s poll) didn't reflect the new position before the
    // next scalp tick fired. The pending-fire lock blocks until either the
    // poll catches up or PENDING_FIRE_LOCK_MS elapses.
    const ctx = loadApp({
      storage: {
        journal: '[]',
        ict_mexc_api_key: 'k', ict_mexc_api_secret: 's',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: true }),
        ict_scalp_tf_SILVER: '1m',
      },
    });
    ctx.app.loadLiveTradingState();
    ctx.app.setScalpAutoFire(true);
    const a = silverWithBear1m();
    const first = await ctx.app.scalpMonitorTick(a);
    assert.equal(first.fired, true, 'first fire goes through');
    // _openPositions still empty here — exactly the race the old code lost.
    assert.equal(Object.keys(ctx.app._openPositions).length, 0);
    const second = await ctx.app.scalpMonitorTick(a);
    assert.equal(second.fired, false, 'second fire blocked by pending lock');
    assert.equal(second.reason, 'in-position');
    assert.equal(second.blockingSym, 'SILVER');
  });

  test('concurrent ticks: TOCTOU race closed by sync pending-fire claim', async () => {
    // Real-world bug, live screenshot: two SILVER limit orders at the same
    // 16:00:42 timestamp. The old code marked pending AFTER the await, so
    // two scalp ticks racing inside the same microtask window both passed
    // _findBlockingPosition before either set the lock. The fix claims the
    // lock SYNCHRONOUSLY before yielding, so the second tick sees it.
    const ctx = loadApp({
      storage: {
        journal: '[]',
        ict_mexc_api_key: 'k', ict_mexc_api_secret: 's',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: true }),
        ict_scalp_tf_SILVER: '1m',
      },
    });
    ctx.app.loadLiveTradingState();
    ctx.app.setScalpAutoFire(true);
    const a = silverWithBear1m();
    const [r1, r2] = await Promise.all([
      ctx.app.scalpMonitorTick(a),
      ctx.app.scalpMonitorTick(a),
    ]);
    const fired   = [r1, r2].filter(r => r.fired).length;
    const blocked = [r1, r2].filter(r => r.reason === 'in-position').length;
    assert.equal(fired,   1, `exactly one fire expected, got ${fired}`);
    assert.equal(blocked, 1, `exactly one block expected, got ${blocked}`);
  });

  test('rollback: failed submit (sign-failed / no-keys) clears the pending lock', async () => {
    // If the order never reached MEXC, blocking the symbol for 60s is a
    // false-positive. _clearPendingFire rolls back the claim.
    const ctx = loadApp({
      storage: {
        journal: '[]',
        // no keys → reason 'no-keys' from placeMexcFuturesOrder
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: false }),
        ict_scalp_tf_SILVER: '1m',
      },
    });
    ctx.app.loadLiveTradingState();
    ctx.app.setScalpAutoFire(true);
    const a = silverWithBear1m();
    const r = await ctx.app.scalpMonitorTick(a);
    assert.equal(r.fired, true, 'tick attempted a fire');
    assert.equal(r.result.reason, 'no-keys', 'placeMexc returns no-keys');
    assert.equal(ctx.app._isPendingFire('SILVER'), false, 'failed submit must NOT leave the lock set');
  });

  test('pending-fire lock expires after PENDING_FIRE_LOCK_MS', async () => {
    const ctx = loadApp({
      storage: {
        journal: '[]',
        ict_mexc_api_key: 'k', ict_mexc_api_secret: 's',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: true }),
        ict_scalp_tf_SILVER: '1m',
      },
    });
    ctx.app.loadLiveTradingState();
    ctx.app.setScalpAutoFire(true);
    const a = silverWithBear1m();
    await ctx.app.scalpMonitorTick(a);
    assert.equal(ctx.app._isPendingFire('SILVER'), true);
    // Backdate the lock past expiry — _isPendingFire should evict it
    ctx.app._pendingFires.SILVER = Date.now() - ctx.app.PENDING_FIRE_LOCK_MS - 1000;
    assert.equal(ctx.app._isPendingFire('SILVER'), false);
    const r = await ctx.app.scalpMonitorTick(a);
    assert.equal(r.fired, true, 'fires again after lock expires');
  });
});
