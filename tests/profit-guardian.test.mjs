import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

function liveSetup(app, sandbox) {
  app.loadTradeModes();
  app.saveMexcKeys('k', 's');
  sandbox.localStorage.setItem('ict_mexc_worker_url', 'https://w.workers.dev');
  app.setLiveTradingEnabled(true);
  // Default to LIVE mode so closeMexcPosition actually attempts the
  // signed call — but we stub fetch so nothing hits the network.
  app.setLiveTradingDryRun(false);
}

function openLong(app, sym, entry, mark) {
  app._openPositions = {
    [sym]: [{ symbol: sym + '_USDT', positionType: 1, holdVol: 1, holdAvgPrice: entry, leverage: 200 }],
  };
  const a = app.ASSETS.find(x => x.symbol === sym);
  if (a) a.price = mark;
}

function openShort(app, sym, entry, mark) {
  app._openPositions = {
    [sym]: [{ symbol: sym + '_USDT', positionType: 2, holdVol: 1, holdAvgPrice: entry, leverage: 200 }],
  };
  const a = app.ASSETS.find(x => x.symbol === sym);
  if (a) a.price = mark;
}

describe('_profitGuardian — break-even protection for winning positions', () => {
  test('thresholds: TRIGGER = 0.15%, CLOSE = 0.02%', () => {
    const { app } = loadApp();
    assert.equal(app.BREAK_EVEN_TRIGGER_PCT, 0.15);
    assert.equal(app.BREAK_EVEN_CLOSE_PCT,   0.02);
  });

  test('does not arm when position has never been in profit', async () => {
    const { app, sandbox } = loadApp();
    liveSetup(app, sandbox);
    openLong(app, 'SOL', 100, 99.9);   // -0.1% — losing
    sandbox.fetch = async () => ({ ok: true, status: 200, text: async () => '{"success":true,"code":0}' });
    app._positionPeakProfit = {};
    await app._profitGuardian();
    const t = app._positionPeakProfit.SOL;
    assert.ok(t);
    assert.equal(t.armed, false, 'never crossed +0.15%, must not arm');
  });

  test('arms when long position touches +0.15% favorable', async () => {
    const { app, sandbox } = loadApp();
    liveSetup(app, sandbox);
    openLong(app, 'SOL', 100, 100.16); // +0.16%
    sandbox.fetch = async () => ({ ok: true, status: 200, text: async () => '{"success":true,"code":0}' });
    app._positionPeakProfit = {};
    await app._profitGuardian();
    assert.equal(app._positionPeakProfit.SOL.armed, true);
  });

  test('arms when short position touches +0.15% favorable (price moved DOWN)', async () => {
    const { app, sandbox } = loadApp();
    liveSetup(app, sandbox);
    openShort(app, 'SOL', 100, 99.84); // -0.16% on price = +0.16% for short
    sandbox.fetch = async () => ({ ok: true, status: 200, text: async () => '{"success":true,"code":0}' });
    app._positionPeakProfit = {};
    await app._profitGuardian();
    assert.equal(app._positionPeakProfit.SOL.armed, true);
  });

  test('armed position retracing below +0.02% triggers a market close', async () => {
    const { app, sandbox } = loadApp();
    liveSetup(app, sandbox);
    openLong(app, 'SOL', 100, 100.20);  // peak +0.20%
    let fetchCalls = [];
    sandbox.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, text: async () => '{"success":true,"code":0}' };
    };
    app._positionPeakProfit = {};
    await app._profitGuardian();  // tick 1 — arms at +0.20%
    assert.equal(app._positionPeakProfit.SOL.armed, true);
    // Price retraces to break-even
    app.ASSETS.find(x => x.symbol === 'SOL').price = 100.005; // +0.005% — below 0.02% threshold
    await app._profitGuardian();  // tick 2 — should fire close
    const closeCalls = fetchCalls.filter(c => c.body && c.body.side === 2 && c.body.type === 5);
    assert.equal(closeCalls.length, 1, 'one market-close call (side=2 type=5)');
    assert.equal(closeCalls[0].body.symbol, 'SOL_USDT');
  });

  test('armed short position retracing triggers close with side=4', async () => {
    const { app, sandbox } = loadApp();
    liveSetup(app, sandbox);
    openShort(app, 'SOL', 100, 99.80);  // peak +0.20% for short
    let fetchCalls = [];
    sandbox.fetch = async (url, init) => {
      fetchCalls.push({ body: init && init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, text: async () => '{"success":true,"code":0}' };
    };
    app._positionPeakProfit = {};
    await app._profitGuardian();
    app.ASSETS.find(x => x.symbol === 'SOL').price = 99.995;  // back near break-even
    await app._profitGuardian();
    const closeCalls = fetchCalls.filter(c => c.body && c.body.side === 4 && c.body.type === 5);
    assert.equal(closeCalls.length, 1, 'short close uses side=4');
  });

  test('armed position still in profit (>+0.02%) does NOT close', async () => {
    const { app, sandbox } = loadApp();
    liveSetup(app, sandbox);
    openLong(app, 'SOL', 100, 100.20);
    let closeCallCount = 0;
    sandbox.fetch = async (url, init) => {
      if (init && init.body && JSON.parse(init.body).type === 5) closeCallCount++;
      return { ok: true, status: 200, text: async () => '{"success":true,"code":0}' };
    };
    app._positionPeakProfit = {};
    await app._profitGuardian();  // arms
    app.ASSETS.find(x => x.symbol === 'SOL').price = 100.10;  // +0.10% — still profit but down from peak 0.20%
    await app._profitGuardian();
    assert.equal(closeCallCount, 0, 'still in profit > 0.02% → do not close');
  });

  test('un-armed position retracing does NOT close (peak never hit +0.15%)', async () => {
    const { app, sandbox } = loadApp();
    liveSetup(app, sandbox);
    openLong(app, 'SOL', 100, 100.10);  // peak +0.10% — below trigger
    let closeCallCount = 0;
    sandbox.fetch = async (url, init) => {
      if (init && init.body && JSON.parse(init.body).type === 5) closeCallCount++;
      return { ok: true, status: 200, text: async () => '{"success":true,"code":0}' };
    };
    app._positionPeakProfit = {};
    await app._profitGuardian();
    app.ASSETS.find(x => x.symbol === 'SOL').price = 99.95;  // now losing
    await app._profitGuardian();
    assert.equal(closeCallCount, 0, 'never armed, no guardian close');
  });

  test('clears the tracker when position closes (mechanical SL hit etc.)', async () => {
    const { app, sandbox } = loadApp();
    liveSetup(app, sandbox);
    openLong(app, 'SOL', 100, 100.20);
    sandbox.fetch = async () => ({ ok: true, status: 200, text: async () => '{"success":true,"code":0}' });
    app._positionPeakProfit = {};
    await app._profitGuardian();
    assert.ok(app._positionPeakProfit.SOL);
    // Position closes externally — _openPositions empties.
    app._openPositions = {};
    await app._profitGuardian();
    assert.equal(app._positionPeakProfit.SOL, undefined, 'tracker cleared when position is gone');
  });

  test('skipped entirely when master switch is OFF', async () => {
    const { app, sandbox } = loadApp();
    app.loadTradeModes();
    openLong(app, 'SOL', 100, 100.20);
    // master OFF (default)
    let fetchCalls = 0;
    sandbox.fetch = async () => { fetchCalls++; return { ok: true, status: 200, text: async () => '' }; };
    app._positionPeakProfit = {};
    await app._profitGuardian();
    assert.equal(fetchCalls, 0, 'no calls when master off');
  });
});
