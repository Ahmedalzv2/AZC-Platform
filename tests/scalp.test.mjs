import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('scalp mode storage', () => {
  // BTC + ETH are non-trio (default 10×), so their default scalp TF stays 'htf'.
  // SILVER/GOLD/SOL are 200× by default → auto-'1m' (covered in its own test).
  test('default is "htf" when not set (non-trio asset)', () => {
    const { app } = loadApp();
    assert.equal(app.getScalpTf('BTC'), 'htf');
    assert.equal(app.getScalpTf('ETH'), 'htf');
  });

  test('trio assets auto-default to "1m" because they sit at 200×', () => {
    const { app } = loadApp();
    assert.equal(app.getScalpTf('SILVER'), '1m');
    assert.equal(app.getScalpTf('GOLD'), '1m');
    assert.equal(app.getScalpTf('SOL'), '1m');
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
    app.setScalpTf('SILVER', 'htf');  // override the 200× auto-default
    assert.equal(app.getScalpTf('SILVER'), 'htf');
    assert.equal(app.getScalpTf('BTC'), 'htf'); // BTC stays at its own default
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
    // SILVER auto-defaults to '1m' (200× trio) — explicitly override to 'htf'
    // so we hit the scalp-off gate.
    app.setScalpTf('SILVER', 'htf');
    const r = await app.scalpMonitorTick(silverWithBear1m());
    assert.equal(r.reason, 'scalp-off');
  });

  test('no tfEntries → no-1m-data', async () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    app.setScalpTf('SILVER', '1m');
    const r = await app.scalpMonitorTick({ symbol: 'SILVER', bias: 'BEARISH', price: 75.65, tfEntries: null });
    assert.equal(r.reason, 'no-1m-data');
  });

  test('tfEntries[1m] has error → no-1m-data', async () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    app.setScalpTf('SILVER', '1m');
    const r = await app.scalpMonitorTick({ symbol: 'SILVER', bias: 'BEARISH', price: 75.65, tfEntries: { '1m': { error: true } } });
    assert.equal(r.reason, 'no-1m-data');
  });

  test('1m has no FVG matching dir → no-1m-setup', async () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    app.setScalpTf('SILVER', '1m');
    // dir present but fvgZone missing → _suggestedEntryForTf returns null
    const r = await app.scalpMonitorTick({
      symbol: 'SILVER', bias: 'BEARISH', price: 75.65,
      tfEntries: { '1m': { dir: 'bear', score: 1 } },
    });
    assert.equal(r.reason, 'no-1m-setup');
  });

  test('HTF disagrees (1m bull, HTF BEARISH) → htf-disagrees (low-lev only)', async () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    app.setScalpTf('SILVER', '1m');
    // HTF gate is enforced only on non-high-lev paths. Drop SILVER to 50×.
    app.setAssetLeverage('SILVER', 50);
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

  test('high-lev trio: GOLD in position does NOT block SILVER (independent fires)', async () => {
    const { app } = loadApp({
      storage: {
        ict_mexc_api_key: 'k', ict_mexc_api_secret: 's',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: true }),
        ict_scalp_tf_SILVER: '1m',
      },
    });
    app.loadLiveTradingState();
    // SILVER defaults to 200× — high-lev → cross-asset gate disabled.
    app._openPositions = { GOLD: [{ holdVol: 1, holdAvgPrice: 4715, leverage: 10 }] };
    const r = await app.scalpMonitorTick(silverWithBear1m());
    assert.equal(r.fired, true, 'SILVER@200× fires while GOLD holds');
  });

  test('low-lev cross-asset gate still applies (focus discipline)', async () => {
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
    const r = await ctx.app.scalpMonitorTick(silverWithBear1m());
    assert.equal(r.fired, true);
    assert.equal(r.result.sent, true);
    const orderCalls = calls.filter(c => String(c.url).includes('/order/submit'));
    assert.equal(orderCalls.length, 1);
    assert.equal(orderCalls[0].url, 'https://my.workers.dev/api/v1/private/order/submit');
    const body = JSON.parse(orderCalls[0].init.body);
    assert.equal(body.symbol, 'SILVER_USDT');
    assert.equal(body.side, 3); // 3 = open short
    // SILVER defaults to 200× (trio) → mechanical SL/TP with quick-take TP.
    // entry 75.65 SHORT, SL = entry × 1.0035 ≈ 75.92,
    // TP = entry × (1 - 0.035/100) ≈ 75.62 (7% margin at 200×).
    assert.equal(body.price, 75.65);
    assert.ok(Math.abs(body.stopLossPrice - 75.92) < 0.02, `sl ${body.stopLossPrice}`);
    assert.ok(Math.abs(body.takeProfitPrice - 75.62) < 0.02, `tp ${body.takeProfitPrice}`);
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
