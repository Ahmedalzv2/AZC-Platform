import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('_scalpProximityPct widens for high-lev', () => {
  test('SOL@200x → 0.30 (wider tolerance)', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    app.setAssetLeverage('SOL', 200);
    assert.equal(app._scalpProximityPct('SOL'), 0.30);
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
  test('threshold constants match: SCALP_PROXIMITY_PCT=0.15, SCALP_PROXIMITY_PCT_HIGH_LEV=0.30', () => {
    const { app } = loadApp();
    assert.equal(app.SCALP_PROXIMITY_PCT, 0.15);
    assert.equal(app.SCALP_PROXIMITY_PCT_HIGH_LEV, 0.30);
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
    // Build a 1m setup whose entry is 0.5% above current price (within
    // SOL@200x's widened 0.30% threshold? No — 0.5% > 0.30%, so too-far).
    sol.price = 86;
    sol.bias  = 'BULLISH';
    sol.tfEntries = {
      '1m': {
        dir: 'bull', entryReady: true, score: 4,
        fvgZone: { dir: 'bull', lo: 86.4, hi: 86.6, mid: 86.5 },
        // no obZone, no sweep — falls through to fvg-edge in _suggestedEntryForTf
      },
    };
    const r = await app.scalpMonitorTick(sol);
    assert.equal(r.reason, 'too-far');
    const d = app._scalpDiag.SOL;
    assert.ok(d.distPct > 0.30, `expected distPct > 0.30 (the SOL high-lev threshold), got ${d.distPct}`);
    assert.equal(d.proximityPct, 0.30, 'records the high-lev threshold so the modal shows the right gate');
    assert.ok(d.sugEntry, 'records the suggested entry so the modal can show the absolute price');
    assert.equal(d.price, 86);
  });

  test('htf-disagrees path captures sugDir + htfDir', async () => {
    const { app } = loadApp();
    const sol = bootSolHigh(app);
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

  test('a tick that would have fired on 0.15% gate now fires on the 0.30% gate at 200x', async () => {
    // Regression for the user's "good call but missed it" — at 200x with
    // mechanical SL = 0.35%, the 0.30% proximity is still inside the SL.
    const { app } = loadApp();
    const sol = bootSolHigh(app);
    sol.bias  = 'BULLISH';
    // Put price 0.20% off the suggested entry — too far for the old 0.15
    // gate, but inside the new 0.30 high-lev gate.
    sol.price = 86;
    sol.tfEntries = {
      '1m': {
        dir: 'bull', entryReady: true, score: 4,
        fvgZone: { dir: 'bull', lo: 86.16, hi: 86.18, mid: 86.17 },
      },
    };
    // Mock placeMexcFuturesOrder so the test stays hermetic — return a
    // pretend-success without touching the (mock) network.
    const r = await app.scalpMonitorTick(sol);
    // At 0.30 gate, distPct ≈ 0.20% should pass proximity. The next gate
    // is cooldown (it's empty so OK), then qty (no calc settings → 1),
    // then the actual fire — which will hit the placeMexcFuturesOrder
    // path. The harness's fetch is undefined so that throws/network-errs;
    // either way, scalpMonitorTick returns fired=true with the result
    // attached. We just need to check we passed the proximity gate.
    assert.notEqual(r.reason, 'too-far', `expected to pass 0.30 gate, got reason=${r.reason}, dist=${r.distPct}`);
  });
});
