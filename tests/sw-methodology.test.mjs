import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('SW (swing) methodology config', () => {
  test('SW_ASSET_CONFIG ships only walk-forward-validated assets', () => {
    const { app } = loadApp();
    const cfg = app.SW_ASSET_CONFIG;
    assert.ok(cfg.ETH, 'ETH must have SW config (passed walk-forward)');
    assert.ok(cfg.XRP, 'XRP must have SW config (passed walk-forward)');
    assert.equal(cfg.BNB, undefined, 'BNB failed walk-forward — must NOT have SW config');
    assert.equal(cfg.SOL, undefined, 'SOL failed walk-forward — must NOT have SW config');
    assert.equal(cfg.BTC, undefined, 'BTC failed walk-forward — must NOT have SW config');
    assert.equal(cfg.GOLD, undefined, 'GOLD failed walk-forward — must NOT have SW config');
  });

  test('ETH config matches SW-O: both dirs, no scoreMin, phase, 1.5/3.0, 24h', () => {
    const { app } = loadApp();
    const c = app.SW_ASSET_CONFIG.ETH;
    assert.equal(c.dir, null, 'ETH SW-O fires both longs and shorts');
    assert.equal(c.scoreMin, null, 'ETH SW-O has no score minimum');
    assert.equal(c.phaseGate, true);
    assert.equal(c.slPct, 1.5);
    assert.equal(c.tpPct, 3.0);
    assert.equal(c.holdH, 24);
  });

  test('XRP config matches SW-OO: shorts only, scoreMin 2, phase, 2.0/3.0, 48h', () => {
    const { app } = loadApp();
    const c = app.SW_ASSET_CONFIG.XRP;
    assert.equal(c.dir, 'bear', 'XRP SW-OO is shorts-only');
    assert.equal(c.scoreMin, 2);
    assert.equal(c.phaseGate, true);
    assert.equal(c.slPct, 2.0);
    assert.equal(c.tpPct, 3.0);
    assert.equal(c.holdH, 48);
  });
});

describe('SW auto-fire gate', () => {
  test('_swAutoFireEnabled defaults to false (safety: no real money fires without explicit opt-in)', () => {
    const { app } = loadApp();
    assert.equal(app.getSwAutoFire(), false);
  });

  test('setSwAutoFire toggles the gate', () => {
    const { app } = loadApp();
    assert.equal(app.setSwAutoFire(true), true);
    assert.equal(app.getSwAutoFire(), true);
    assert.equal(app.setSwAutoFire(false), false);
    assert.equal(app.getSwAutoFire(), false);
  });
});

describe('_swingMonitorTick — gate behavior', () => {
  function setupEth(app, opts = {}) {
    app.loadTradeModes();
    app.saveMexcKeys('k', 's');
    app.setLiveTradingEnabled(true);
    app.setLiveTradingDryRun(true);
    const eth = app.ASSETS.find(a => a.symbol === 'ETH');
    eth.price = opts.price ?? 3000;
    eth.tfEntries = eth.tfEntries || {};
    eth.tfEntries['1h'] = {
      dir: opts.dir ?? 'bear',
      score: opts.score ?? 3,
      phase: opts.phase ?? 'trend',
      entryReady: true,
      fvgZone: { dir: opts.dir ?? 'bear', lo: 2998, mid: 3000, hi: 3002 },
    };
    return eth;
  }

  test('no SW config for asset → returns no-sw-config', async () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const btc = app.ASSETS.find(a => a.symbol === 'BTC');
    btc.price = 50000;
    btc.tfEntries = { '1h': { dir: 'bear', score: 3, phase: 'trend' } };
    const r = await app._swingMonitorTick(btc);
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'no-sw-config');
  });

  test('master off → returns master-off', async () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const eth = app.ASSETS.find(a => a.symbol === 'ETH');
    eth.price = 3000;
    eth.tfEntries = { '1h': { dir: 'bear', score: 3, phase: 'trend' } };
    const r = await app._swingMonitorTick(eth);
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'master-off');
  });

  test('phase=consolidation → phase-gated (when cfg.phaseGate)', async () => {
    const { app } = loadApp();
    const eth = setupEth(app, { phase: 'consolidation' });
    const r = await app._swingMonitorTick(eth);
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'phase-gated');
  });

  test('XRP shorts-only: bull signal → dir-filter blocks it', async () => {
    const { app } = loadApp();
    app.loadTradeModes();
    app.setLiveTradingEnabled(true);
    const xrp = app.ASSETS.find(a => a.symbol === 'XRP');
    xrp.price = 1.5;
    xrp.tfEntries = { '1h': {
      dir: 'bull', score: 3, phase: 'trend', entryReady: true,
      fvgZone: { dir: 'bull', lo: 1.499, mid: 1.5, hi: 1.501 },
    }};
    const r = await app._swingMonitorTick(xrp);
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'dir-filter');
    assert.equal(r.want, 'bear');
  });

  test('XRP scoreMin=2: score 1 → score-too-low blocks it', async () => {
    const { app } = loadApp();
    app.loadTradeModes();
    app.setLiveTradingEnabled(true);
    const xrp = app.ASSETS.find(a => a.symbol === 'XRP');
    xrp.price = 1.5;
    xrp.tfEntries = { '1h': {
      dir: 'bear', score: 1, phase: 'trend', entryReady: true,
      fvgZone: { dir: 'bear', lo: 1.499, mid: 1.5, hi: 1.501 },
    }};
    const r = await app._swingMonitorTick(xrp);
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'score-too-low');
  });

  test('all gates pass + auto-fire OFF → returns auto-fire-disabled with order shape', async () => {
    const { app } = loadApp();
    const eth = setupEth(app);
    // auto-fire defaults to false → should report the *intended* order
    const r = await app._swingMonitorTick(eth);
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'auto-fire-disabled');
    assert.equal(r.side, 'SHORT');
    assert.equal(r.holdH, 24);
    assert.ok(r.sl > r.entry, 'short SL above entry');
    assert.ok(r.tp < r.entry, 'short TP below entry');
    // SL ≈ entry × (1 + 1.5%); TP ≈ entry × (1 − 3.0%)
    const slPct = (r.sl - r.entry) / r.entry * 100;
    const tpPct = (r.entry - r.tp) / r.entry * 100;
    assert.ok(Math.abs(slPct - 1.5) < 0.01, `expected SL 1.5%, got ${slPct.toFixed(3)}%`);
    assert.ok(Math.abs(tpPct - 3.0) < 0.01, `expected TP 3.0%, got ${tpPct.toFixed(3)}%`);
  });

  test('all gates pass + auto-fire ON + dry-run → returns fired:true', async () => {
    const { app } = loadApp();
    const eth = setupEth(app);
    app.setSwAutoFire(true);
    const r = await app._swingMonitorTick(eth);
    assert.equal(r.fired, true);
    assert.equal(r.side, 'SHORT');
    assert.equal(r.holdH, 24);
    // SW position tracker populated on fire
    assert.ok(app._swPositions.ETH, 'SW position tracker recorded');
    assert.equal(app._swPositions.ETH.holdH, 24);
  });

  test('SW position already open → sw-already-open blocks re-entry', async () => {
    const { app } = loadApp();
    const eth = setupEth(app);
    app._swPositions.ETH = { openTs: Date.now(), holdH: 24, side: 'SHORT' };
    const r = await app._swingMonitorTick(eth);
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'sw-already-open');
  });
});

describe('_swHoldKillTick — hold-horizon force-close', () => {
  test('no SW positions tracked → no-op', async () => {
    const { app } = loadApp();
    app.setLiveTradingEnabled(true);
    // _swPositions empty by default; should not throw
    await app._swHoldKillTick();
    assert.equal(Object.keys(app._swPositions).length, 0);
  });

  test('young SW position (1h old, 24h horizon) → no close', async () => {
    const { app } = loadApp();
    app.setLiveTradingEnabled(true);
    app._swPositions.ETH = { openTs: Date.now() - 3600 * 1000, holdH: 24, side: 'SHORT' };
    app._openPositions = { ETH: [{ holdVol: 1, positionType: 2 }] };
    await app._swHoldKillTick();
    assert.ok(app._swPositions.ETH, 'still tracked');
  });

  test('SW position past horizon but position already closed externally → drops tracker', async () => {
    const { app } = loadApp();
    app.setLiveTradingEnabled(true);
    app._swPositions.ETH = { openTs: Date.now() - 25 * 3600 * 1000, holdH: 24, side: 'SHORT' };
    app._openPositions = {}; // closed externally (SL/TP hit)
    await app._swHoldKillTick();
    assert.equal(app._swPositions.ETH, undefined, 'tracker dropped when position is gone');
  });

  test('master off → no-op (safety)', async () => {
    const { app } = loadApp();
    app._swPositions.ETH = { openTs: Date.now() - 100 * 3600 * 1000, holdH: 24, side: 'SHORT' };
    app._openPositions = { ETH: [{ holdVol: 1, positionType: 2 }] };
    // master OFF (default)
    await app._swHoldKillTick();
    assert.ok(app._swPositions.ETH, 'still tracked when master off');
  });
});
