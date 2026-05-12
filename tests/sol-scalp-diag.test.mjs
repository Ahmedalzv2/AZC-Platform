import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('_scalpProximityPct widens for high-lev', () => {
  test('SOL@200x → 0.50 (wider tolerance for the trio ultra-trade loop)', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    app.setAssetLeverage('SOL', 200);
    assert.equal(app._scalpProximityPct('SOL'), 0.50);
  });
  test('SILVER@3x → 0.15 (default tolerance)', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    app.setAssetLeverage('SILVER', 3);
    assert.equal(app._scalpProximityPct('SILVER'), 0.15);
  });
  test('SOL dropped to 50x → 0.15 (no longer high-lev)', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    app.setAssetLeverage('SOL', 50);
    assert.equal(app._scalpProximityPct('SOL'), 0.15);
  });
  test('threshold constants match: SCALP_PROXIMITY_PCT=0.15, SCALP_PROXIMITY_PCT_HIGH_LEV=0.50', () => {
    const { app } = loadApp();
    assert.equal(app.SCALP_PROXIMITY_PCT, 0.15);
    assert.equal(app.SCALP_PROXIMITY_PCT_HIGH_LEV, 0.50);
  });
});

describe('scalpMonitorTick records to _scalpDiag on every return path', () => {
  function bootSolHigh(app) {
    app.loadTradeModes();
    app.setAssetLeverage('SOL', 200);
    app.setLiveTradingEnabled(true);
    return app.ASSETS.find(a => a.symbol === 'SOL');
  }

  test('master-off path writes diag entry', async () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const sol = app.ASSETS.find(a => a.symbol === 'SOL');
    // Master OFF (default in harness)
    const r = await app.scalpMonitorTick(sol);
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'master-off');
    const d = app._scalpDiag.SOL;
    assert.ok(d, 'diag entry written');
    assert.equal(d.reason, 'master-off');
    assert.ok(typeof d.ts === 'number' && d.ts > 0);
  });

  test('scalp-off path writes diag entry (user has tf=htf)', async () => {
    const { app } = loadApp();
    const sol = bootSolHigh(app);
    app.setScalpTf('SOL', 'htf'); // explicit override → not '1m'
    const r = await app.scalpMonitorTick(sol);
    assert.equal(r.reason, 'scalp-off');
    assert.equal(app._scalpDiag.SOL.reason, 'scalp-off');
  });

  test('no-1m-data path writes diag entry', async () => {
    const { app } = loadApp();
    const sol = bootSolHigh(app);
    sol.tfEntries = null;
    const r = await app.scalpMonitorTick(sol);
    assert.equal(r.reason, 'no-1m-data');
    assert.equal(app._scalpDiag.SOL.reason, 'no-1m-data');
  });

  test('too-far path captures distPct + threshold for the modal', async () => {
    const { app } = loadApp();
    const sol = bootSolHigh(app);
    // Entry 1% above current price — outside SOL@200x's widened 0.50% gate.
    sol.price = 86;
    sol.bias  = 'BULLISH';
    sol.tfEntries = {
      '1m': {
        dir: 'bull', entryReady: true, score: 4,
        fvgZone: { dir: 'bull', lo: 86.8, hi: 87.0, mid: 86.9 },
      },
    };
    const r = await app.scalpMonitorTick(sol);
    assert.equal(r.reason, 'too-far');
    const d = app._scalpDiag.SOL;
    assert.ok(d.distPct > 0.50, `expected distPct > 0.50 (the SOL high-lev threshold), got ${d.distPct}`);
    assert.equal(d.proximityPct, 0.50, 'records the high-lev threshold so the modal shows the right gate');
    assert.ok(d.sugEntry, 'records the suggested entry so the modal can show the absolute price');
    assert.equal(d.price, 86);
  });

  test('htf-disagrees path captures sugDir + htfDir (low-lev path)', async () => {
    // HTF gate is only enforced on non-high-lev assets — drop SOL to 50× so
    // the gate fires. Re-pin scalp TF to '1m' since the auto-default flips
    // back to 'htf' when leverage falls below the threshold.
    const { app } = loadApp();
    const sol = bootSolHigh(app);
    app.setAssetLeverage('SOL', 50);
    app.setScalpTf('SOL', '1m');
    sol.bias  = 'BEARISH';
    sol.price = 86;
    sol.tfEntries = {
      '1m': {
        dir: 'bull', entryReady: true, score: 4,
        fvgZone: { dir: 'bull', lo: 85.9, hi: 86.0, mid: 85.95 },
      },
    };
    const r = await app.scalpMonitorTick(sol);
    assert.equal(r.reason, 'htf-disagrees');
    const d = app._scalpDiag.SOL;
    assert.equal(d.sugDir, 'bull');
    assert.equal(d.htfDir, 'bear');
  });

  test('high-lev trio skips HTF gate — fires even on counter-bias 1m setup', async () => {
    const { app } = loadApp();
    const sol = bootSolHigh(app); // 200× → high-lev → skips HTF
    sol.bias  = 'BEARISH';        // HTF says bear, but 1m says bull
    sol.price = 85.95;            // at the FVG mid
    sol.tfEntries = {
      '1m': {
        dir: 'bull', entryReady: true, score: 4,
        fvgZone: { dir: 'bull', lo: 85.9, hi: 86.0, mid: 85.95 },
      },
    };
    const r = await app.scalpMonitorTick(sol);
    assert.notEqual(r.reason, 'htf-disagrees', `HTF gate should be skipped at 200×, got reason=${r.reason}`);
    assert.notEqual(r.reason, 'no-htf-bias');
  });

  test('a tick at 0.40% off entry passes the 0.50% high-lev gate at 200x', async () => {
    const { app } = loadApp();
    const sol = bootSolHigh(app);
    sol.bias  = 'BULLISH';
    // Put price 0.40% off the suggested entry — outside old 0.30 gate,
    // inside the new 0.50 high-lev gate.
    sol.price = 86;
    sol.tfEntries = {
      '1m': {
        dir: 'bull', entryReady: true, score: 4,
        fvgZone: { dir: 'bull', lo: 86.33, hi: 86.35, mid: 86.34 },
      },
    };
    const r = await app.scalpMonitorTick(sol);
    assert.notEqual(r.reason, 'too-far', `expected to pass 0.50 gate, got reason=${r.reason}, dist=${r.distPct}`);
  });
});
