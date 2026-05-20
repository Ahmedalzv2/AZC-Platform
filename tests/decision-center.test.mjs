import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('Live Chart Decision Center', () => {
  function bootSol(app) {
    app.loadTradeModes();
    app.setLiveTradingEnabled(true);
    app.setLiveTradingDryRun(true);
    const sol = app.ASSETS.find(a => a.symbol === 'SOL');
    sol.price = 100;
    sol.entry = 100;
    sol.sl = 99;
    sol.tp1 = 103;
    sol.bias = 'BULLISH';
    app.setScalpTf('SOL', '5m');
    sol.tfEntries = {
      '5m': {
        dir: 'bull', entryReady: true, score: 4,
        fvgZone: { dir: 'bull', lo: 99.95, hi: 100.05, mid: 100 },
      },
    };
    return sol;
  }

  test('READY futures decision tells the user to force fire and shows risk', () => {
    const { app } = loadApp();
    const sol = bootSol(app);
    const d = app._buildLiveChartDecision(sol);

    assert.equal(d.state, 'ready');
    assert.equal(d.actionLabel, 'Force Fire');
    assert.match(d.reason, /manual entry/i);
    assert.match(d.riskLine, /10x/);
    assert.match(d.riskLine, /SL 1\.00%/);
    assert.match(d.riskLine, /liq buffer 10\.00%/);
    assert.match(d.riskLine, /DRY-RUN/);
  });

  test('SPOT decision stays out of futures language', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const btc = app.ASSETS.find(a => a.symbol === 'BTC');
    btc.price = 100;
    btc.entry = 95;
    btc.tp1 = 115;
    const d = app._buildLiveChartDecision(btc);

    assert.equal(d.state, 'manual');
    assert.equal(d.actionLabel, 'Open Details');
    assert.match(d.reason, /Spot Watch/i);
    assert.match(d.riskLine, /Spot only/i);
  });

  test('LIVE OFF decision points to the trading controls', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const sol = app.ASSETS.find(a => a.symbol === 'SOL');
    sol.price = 100;
    const d = app._buildLiveChartDecision(sol);

    assert.equal(d.state, 'blocked');
    assert.equal(d.actionLabel, 'Open Live Trading');
    assert.match(d.reason, /kill-switch|Live Trading/i);
  });

  test('US100 decision uses the cockpit state machine and never points at execution', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    us100.price = 27000;

    const d = app._buildLiveChartDecision(us100);

    assert.equal(d.state, 'us100-ict');
    assert.equal(d.actionLabel, 'Build Trade Plan');
    assert.equal(d.actionKind, 'plan');
    assert.match(d.label, /US100 ICT/);
    assert.ok(d.ictState);
    assert.ok(Array.isArray(d.stateRows));
    assert.doesNotMatch(`${d.reason} ${d.riskLine}`, /MEXC|Force Fire|FP Markets/i);
  });

  test('US100 ignores stale seed levels until a fresh plan is applied', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    us100.price = 27000;
    us100.entry = 26800;
    us100.sl = 26950;
    us100.tp1 = 26000;
    us100.entryTf = '5m';

    const d = app._buildLiveChartDecision(us100);

    assert.equal(d.ictState, 'WAITING PLAN');
    assert.match(d.reason, /old seed levels are ignored/i);
    assert.match(d.riskLine, /live price \$27,000/i);
    assert.doesNotMatch(d.riskLine, /26,800|26,950|26,000/);
  });

  test('US100 decision center renders trade-plan action, not Force Fire', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');

    const html = app._renderLiveChartDecisionCenter(us100);

    assert.match(html, /Build Trade Plan/);
    assert.match(html, /State/);
    assert.match(html, /Next/);
    assert.doesNotMatch(html, /Force Fire/);
    assert.doesNotMatch(html, /_onClickForceFire\('US100'\)/);
  });

  test('US100 live chart panel hides auto-TF spinners (manual ICT, no kline source)', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const us100 = app.ASSETS.find(a => a.symbol === 'US100');
    us100.price = 26983;
    us100.tfEntries = null;

    assert.equal(app._renderSelectedTFCard(us100, '5'), '');
    assert.equal(app._renderTfReadinessHTML(us100), '');
    assert.equal(app._renderLiveChartTFLevels(us100), '');
    assert.equal(app._renderTradeOpinions(us100), '');
  });

  test('Non-US100 assets still show the auto-TF spinners while tfEntries is loading', () => {
    const { app } = loadApp();
    app.loadTradeModes();
    const sol = app.ASSETS.find(a => a.symbol === 'SOL');
    sol.price = 100;
    sol.tfEntries = null;

    assert.match(app._renderSelectedTFCard(sol, '5'), /analyzing this timeframe/);
    assert.match(app._renderTfReadinessHTML(sol), /analyzing TFs/);
    assert.match(app._renderLiveChartTFLevels(sol), /analyzing per-TF levels/);
    assert.match(app._renderTradeOpinions(sol), /Computing spot vs futures/);
  });
});
