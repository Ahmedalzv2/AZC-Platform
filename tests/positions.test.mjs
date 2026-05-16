import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, forceLeverage } from './harness.mjs';

function withConnected(app, sandbox) {
  app.saveMexcKeys('k', 's');
  sandbox.localStorage.setItem('ict_mexc_worker_url', 'https://w.workers.dev');
  app.setLiveTradingEnabled(true);
  app.setLiveTradingDryRun(true); // hermetic — order calls won't touch the (mock) network
}

describe('fetchMexcOpenPositions', () => {
  test('returns no-keys when API key is missing', async () => {
    const { app } = loadApp();
    const r = await app.fetchMexcOpenPositions();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no-keys');
  });

  test('returns no-worker when Worker URL is missing', async () => {
    const { app, sandbox } = loadApp();
    app.saveMexcKeys('k', 's');
    sandbox.localStorage.removeItem('ict_mexc_worker_url');
    const r = await app.fetchMexcOpenPositions();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no-worker');
  });

  test('returns positions array when MEXC succeeds', async () => {
    const { app, sandbox } = loadApp();
    withConnected(app, sandbox);
    sandbox.fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        success: true, code: 0,
        data: [
          { symbol: 'SOL_USDT', positionType: 1, holdVol: 2.79, holdAvgPrice: 86.42, leverage: 200, unrealised: 0.23, liquidatePrice: 85.9 },
          { symbol: 'SILVER_USDT', positionType: 2, holdVol: 1.0, holdAvgPrice: 33.2, leverage: 200, unrealised: -0.05, liquidatePrice: 33.5 },
        ],
      }),
    });
    const r = await app.fetchMexcOpenPositions();
    assert.equal(r.ok, true);
    assert.equal(r.positions.length, 2);
    assert.equal(r.positions[0].symbol, 'SOL_USDT');
  });

  test('network failure → ok:false, error="network"', async () => {
    const { app, sandbox } = loadApp();
    withConnected(app, sandbox);
    sandbox.fetch = async () => { throw new Error('econnreset'); };
    const r = await app.fetchMexcOpenPositions();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'network');
  });
});

describe('_positionsTick — populates _openPositions keyed by bare symbol', () => {
  test('skips when master switch is OFF', async () => {
    const { app, sandbox } = loadApp();
    let fetchCalls = 0;
    sandbox.fetch = async () => { fetchCalls++; return { ok: true, status: 200, text: async () => '{"success":true,"data":[]}' }; };
    // master OFF (default)
    await app._positionsTick();
    assert.equal(fetchCalls, 0, 'no fetch when master OFF');
  });

  test('normalizes SOL_USDT → SOL, SILVER_USDT → SILVER, XAUT_USDT → GOLD', async () => {
    const { app, sandbox } = loadApp();
    withConnected(app, sandbox);
    sandbox.fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        success: true, code: 0,
        data: [
          { symbol: 'SOL_USDT',    positionType: 1, holdVol: 2.79, holdAvgPrice: 86.42, leverage: 200, unrealised: 0.23 },
          { symbol: 'SILVER_USDT', positionType: 2, holdVol: 1.0,  holdAvgPrice: 33.2,  leverage: 200, unrealised: -0.05 },
          { symbol: 'XAUT_USDT',   positionType: 1, holdVol: 0.1,  holdAvgPrice: 4710,  leverage: 10,  unrealised: 0.01 },
        ],
      }),
    });
    await app._positionsTick();
    const map = app._openPositions;
    assert.ok(map.SOL,    'SOL key present');
    assert.ok(map.SILVER, 'SILVER key present');
    assert.ok(map.GOLD,   'GOLD key present');
    assert.equal(map.SOL.length, 1);
    assert.equal(map.SOL[0].holdVol, 2.79);
  });

  test('error response leaves prior _openPositions intact + records error', async () => {
    const { app, sandbox } = loadApp();
    withConnected(app, sandbox);
    // First successful fetch
    sandbox.fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ success: true, code: 0, data: [{ symbol: 'SOL_USDT', positionType: 1, holdVol: 1, holdAvgPrice: 80, leverage: 200 }] }),
    });
    await app._positionsTick();
    assert.equal(app._openPositions.SOL.length, 1);
    // Now a failing fetch — the prior state should NOT be wiped (no flash of empty)
    sandbox.fetch = async () => ({ ok: false, status: 500, text: async () => '{"code":500,"msg":"boom"}' });
    await app._positionsTick();
    assert.equal(app._openPositions.SOL.length, 1, 'prior positions preserved on transient error');
  });
});

describe('closeMexcPosition — side mapping', () => {
  test('master OFF → reason=master-off', async () => {
    const { app } = loadApp();
    const r = await app.closeMexcPosition('SOL', 2.79, 1);
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'master-off');
  });

  test('dry-run → does NOT touch network; journals a [DRY-RUN] entry', async () => {
    const { app, sandbox } = loadApp();
    withConnected(app, sandbox);
    let fetchCalls = 0;
    sandbox.fetch = async () => { fetchCalls++; return { ok: true, status: 200, text: async () => '' }; };
    const before = (app.journal || []).length;
    const r = await app.closeMexcPosition('SOL', 2.79, 1);
    assert.equal(r.dryRun, true);
    assert.equal(fetchCalls, 0, 'no HTTP in dry-run');
    assert.equal((app.journal || []).length, before + 1, 'journal entry appended');
  });

  test('LIVE long close → submits side=2 type=5 (market close long)', async () => {
    const { app, sandbox } = loadApp();
    app.saveMexcKeys('k', 's');
    sandbox.localStorage.setItem('ict_mexc_worker_url', 'https://w.workers.dev');
    app.setLiveTradingEnabled(true);
    app.setLiveTradingDryRun(false); // LIVE
    let captured = null;
    sandbox.fetch = async (url, init) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return { ok: true, status: 200, text: async () => '{"success":true,"code":0}' };
    };
    const r = await app.closeMexcPosition('SOL', 2.79, 1);
    assert.equal(r.sent, true);
    assert.match(captured.url, /\/api\/v1\/private\/order\/submit$/);
    assert.equal(captured.body.side, 2, 'side=2 closes a long position');
    assert.equal(captured.body.type, 5, 'type=5 is market order — exit immediately');
    assert.equal(captured.body.vol, 2.79);
    assert.equal(captured.body.symbol, 'SOL_USDT');
  });

  test('LIVE short close → submits side=4 type=5 (market close short)', async () => {
    const { app, sandbox } = loadApp();
    app.saveMexcKeys('k', 's');
    sandbox.localStorage.setItem('ict_mexc_worker_url', 'https://w.workers.dev');
    app.setLiveTradingEnabled(true);
    app.setLiveTradingDryRun(false);
    let captured = null;
    sandbox.fetch = async (url, init) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return { ok: true, status: 200, text: async () => '{"success":true,"code":0}' };
    };
    const r = await app.closeMexcPosition('SILVER', 1.0, 3); // 3 = short open side
    assert.equal(r.sent, true);
    assert.equal(captured.body.side, 4, 'side=4 closes a short position');
    assert.equal(captured.body.symbol, 'SILVER_USDT');
  });

  test('bad side → reason=bad-side', async () => {
    const { app, sandbox } = loadApp();
    withConnected(app, sandbox);
    app.setLiveTradingDryRun(false);
    const r = await app.closeMexcPosition('SOL', 1, 999);
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'bad-side');
  });
});

describe('getFireStatus — IN POSITION state', () => {
  test('asset with an open position shows IN POSITION with PnL', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const sol = app.ASSETS.find(a => a.symbol === 'SOL');
    sol.price = 86.5;
    app._openPositions = {
      SOL: [{ positionType: 1, holdVol: 2.79, holdAvgPrice: 86.42, leverage: 200, unrealised: 0.23 }],
    };
    const s = app.getFireStatus(sol);
    assert.equal(s.state, 'in-position');
    assert.match(s.label, /IN POSITION/);
    assert.match(s.label, /LONG/);
    assert.match(s.label, /\+\$/);
  });

  test('negative PnL surfaces in red', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const sol = app.ASSETS.find(a => a.symbol === 'SOL');
    sol.price = 86.0;
    app._openPositions = {
      SOL: [{ positionType: 1, holdVol: 2.79, holdAvgPrice: 86.42, leverage: 200, unrealised: -0.20 }],
    };
    const s = app.getFireStatus(sol);
    assert.equal(s.state, 'in-position');
    assert.equal(s.color, 'var(--bear)', 'losing position renders in bear colour');
    assert.match(s.label, /-\$/);
  });

  test('IN POSITION takes priority over READY (do not advertise re-fire on top of an open trade)', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    forceLeverage(app, 'SOL', 200);
    app.setLiveTradingEnabled(true);
    const sol = app.ASSETS.find(a => a.symbol === 'SOL');
    sol.price = 100;
    sol.bias = 'BULLISH';
    sol.tfEntries = {
      '1m': {
        dir: 'bull', entryReady: true, score: 4,
        fvgZone: { dir: 'bull', lo: 99.95, hi: 100.05, mid: 100.00 },
      },
    };
    // Without a position, this would be 'ready'. With a position, it should be 'in-position'.
    app._openPositions = {
      SOL: [{ positionType: 1, holdVol: 1, holdAvgPrice: 100, leverage: 200, unrealised: 0 }],
    };
    const s = app.getFireStatus(sol);
    assert.equal(s.state, 'in-position');
  });

  test('Low-lev: other asset in position blocks SILVER with WAITING ON {sym}', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    app.setAssetLeverage('SILVER', 10);  // low-lev → cross-asset gate applies
    app.setLiveTradingEnabled(true);
    const silver = app.ASSETS.find(a => a.symbol === 'SILVER');
    silver.price = 32.5;
    silver.bias = 'BULLISH';
    silver.tfEntries = {
      '1m': {
        dir: 'bull', entryReady: true, score: 4,
        fvgZone: { dir: 'bull', lo: 32.48, hi: 32.52, mid: 32.50 },
      },
    };
    app._openPositions = {
      SOL: [{ positionType: 1, holdVol: 1, holdAvgPrice: 100, leverage: 200, unrealised: 0 }],
    };
    const s = app.getFireStatus(silver);
    assert.equal(s.state, 'blocked');
    assert.match(s.label, /WAITING ON SOL/);
  });

  test('High-lev trio: SOL in position does NOT block SILVER badge (READY)', () => {
    // Pin wall clock to a Thursday so SILVER's CME weekend gate doesn't fire.
    const { app } = loadApp({ now: new Date('2026-05-07T15:00:00Z') });
    app.loadTradeModes();
    forceLeverage(app, 'SILVER', 200);  // high-lev → independent fires
    app.setLiveTradingEnabled(true);
    const silver = app.ASSETS.find(a => a.symbol === 'SILVER');
    silver.price = 32.5;
    silver.bias = 'BULLISH';
    silver.tfEntries = {
      // High-lev default scalp TF is now '5m' (1m was failing).
      '5m': {
        dir: 'bull', entryReady: true, score: 4,
        fvgZone: { dir: 'bull', lo: 32.48, hi: 32.52, mid: 32.50 },
      },
    };
    app._openPositions = {
      SOL: [{ positionType: 1, holdVol: 1, holdAvgPrice: 100, leverage: 200, unrealised: 0 }],
    };
    const s = app.getFireStatus(silver);
    assert.notEqual(s.state, 'blocked', 'high-lev SILVER fires independently of SOL position');
  });

  test('SILVER own position still shows IN POSITION (not WAITING ON SILVER)', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    app.setLiveTradingEnabled(true);
    const silver = app.ASSETS.find(a => a.symbol === 'SILVER');
    silver.price = 32.5;
    app._openPositions = {
      SILVER: [{ positionType: 1, holdVol: 0.47, holdAvgPrice: 32.45, leverage: 200, unrealised: 0.05 }],
    };
    const s = app.getFireStatus(silver);
    assert.equal(s.state, 'in-position');
    assert.match(s.label, /IN POSITION/);
  });
});
