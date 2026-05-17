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
});
