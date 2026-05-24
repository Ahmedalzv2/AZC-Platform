import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('MEXC micro-capital safety gate ($50 trial lane)', () => {
  function makeFire({ symbol, ts, dryRun = true, live = false, realizedUsd = null }) {
    return {
      id: ts + Math.random(), timestamp: ts,
      symbol, signal: 'enter',
      priceAtCall: 1, entry: 1, sl: 0.99, tp: 1.02,
      grade: 'a', bias: 'BULLISH', session: 'test',
      analysis: '', outcome: null, outcomeChecks: {},
      live, dryRun, realizedUsd,
    };
  }
  function todayMs(hour = 12, minute = 0) {
    const d = new Date(); d.setHours(hour, minute, 0, 0); return d.getTime();
  }

  test('defaults are loss-aware: lane OFF · $50 / 0.5% risk / $1 daily-loss / 1 open / 15-min cooldown', () => {
    const { app } = loadApp();
    const d = app.MICRO_CAPITAL_DEFAULTS;
    assert.equal(d.laneEnabled, false, 'lane is OFF by default — opt-in selector');
    assert.equal(d.balanceUsd, 50);
    assert.equal(d.maxRiskPctPerTrade, 0.5);
    assert.equal(d.dailyLossCapUsdAbs, 1);
    assert.equal(d.dailyLossCapPct, 2);
    assert.equal(d.maxOpenPositions, 1);
    assert.equal(d.perSymbolCooldownMs, 15 * 60 * 1000);
    assert.equal(d.armed, false, 'live arming gate is OFF by default');
    assert.equal(d.maxTradesPerDay, undefined, 'count cap intentionally removed — loss cap is the real safety');
  });

  test('lane OFF + dry-run → pass-through (research lane stays frictionless)', () => {
    const { app } = loadApp();
    app.journal = [];
    const r = app.checkMicroCapitalGate({
      symbol: 'BTC', dryRun: true, riskUsd: 5_000_000, balanceUsd: 50,
      openPositionCount: 99, nowMs: todayMs(12),
    });
    assert.equal(r.allow, true);
    assert.equal(r.audit.laneEnabled, false);
  });

  test('lane OFF + LIVE → BLOCKED with reason "lane-disabled"', () => {
    const { app } = loadApp();
    app.journal = [];
    const r = app.checkMicroCapitalGate({
      symbol: 'BTC', dryRun: false, riskUsd: 0.20, balanceUsd: 50,
      openPositionCount: 0, nowMs: todayMs(12),
    });
    assert.equal(r.allow, false, 'a live MEXC order must not bypass the gate by simply having the lane toggle off');
    assert.equal(r.reason, 'lane-disabled');
  });

  test('lane ON + dry-run: allowed by default, audits the snapshot, does NOT require armed', () => {
    const { app } = loadApp();
    app.setMicroCapitalConfig({ laneEnabled: true });
    app.journal = [];
    const r = app.checkMicroCapitalGate({
      symbol: 'BTC', dryRun: true, riskUsd: 0.2, balanceUsd: 50,
      openPositionCount: 0, nowMs: todayMs(12),
    });
    assert.equal(r.allow, true);
    assert.equal(r.audit.lane, 'mexc-micro-capital');
    assert.equal(r.audit.dryRun, true);
    assert.equal(r.audit.tradesToday, 0);
    app.setMicroCapitalConfig({ laneEnabled: false });
  });

  test('lane ON + live path is BLOCKED until explicitly armed', () => {
    const { app } = loadApp();
    app.setMicroCapitalConfig({ laneEnabled: true });
    app.journal = [];
    const r = app.checkMicroCapitalGate({
      symbol: 'BTC', dryRun: false, riskUsd: 0.2, balanceUsd: 50,
      openPositionCount: 0, nowMs: todayMs(12),
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, 'not-armed');
    app.setMicroCapitalConfig({ laneEnabled: false });
  });

  test('lane ON + armed + within all caps → allow', () => {
    const { app } = loadApp();
    app.setMicroCapitalConfig({ laneEnabled: true, armed: true });
    app.journal = [];
    const r = app.checkMicroCapitalGate({
      symbol: 'BTC', dryRun: false, riskUsd: 0.2, balanceUsd: 50,
      openPositionCount: 0, nowMs: todayMs(12),
    });
    assert.equal(r.allow, true, r.reason || '');
    app.setMicroCapitalConfig({ laneEnabled: false, armed: false });
  });

  test('risk-per-trade cap: $50 × 0.5% = $0.25 max — $0.30 blocks', () => {
    const { app } = loadApp();
    app.setMicroCapitalConfig({ laneEnabled: true, armed: true });
    app.journal = [];
    const r = app.checkMicroCapitalGate({
      symbol: 'BTC', dryRun: false, riskUsd: 0.30, balanceUsd: 50,
      openPositionCount: 0, nowMs: todayMs(12),
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, 'risk-per-trade-cap');
    assert.equal(r.audit.maxRiskUsd, 0.25);
    app.setMicroCapitalConfig({ laneEnabled: false, armed: false });
  });

  test('daily-loss cap blocks once realised loss ≥ min($1, 2% of balance)', () => {
    const { app } = loadApp();
    app.setMicroCapitalConfig({ laneEnabled: true, armed: true });
    // $50 → 2% = $1.00, abs cap is also $1.00 → effective $1.00
    app.journal = [
      makeFire({ symbol: 'BTC', ts: todayMs(10), live: true, dryRun: false, realizedUsd: -1.20 }),
    ];
    const r = app.checkMicroCapitalGate({
      symbol: 'ETH', dryRun: false, riskUsd: 0.20, balanceUsd: 50,
      openPositionCount: 0, nowMs: todayMs(12),
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, 'daily-loss-cap');
    app.setMicroCapitalConfig({ laneEnabled: false, armed: false });
  });

  test('no count cap: many fires today still allowed if loss cap not breached', () => {
    const { app } = loadApp();
    app.setMicroCapitalConfig({ laneEnabled: true, armed: true });
    app.journal = [
      makeFire({ symbol: 'BTC', ts: todayMs(8),  live: true, dryRun: false, realizedUsd:  0.10 }),
      makeFire({ symbol: 'ETH', ts: todayMs(9),  live: true, dryRun: false, realizedUsd:  0.05 }),
      makeFire({ symbol: 'SOL', ts: todayMs(10), live: true, dryRun: false, realizedUsd: -0.20 }),
      makeFire({ symbol: 'DOGE',ts: todayMs(11), live: true, dryRun: false, realizedUsd:  0.15 }),
    ];
    const r = app.checkMicroCapitalGate({
      symbol: 'XRP', dryRun: false, riskUsd: 0.20, balanceUsd: 50,
      openPositionCount: 0, nowMs: todayMs(12),
    });
    assert.equal(r.allow, true, r.reason || '');
    app.setMicroCapitalConfig({ laneEnabled: false, armed: false });
  });

  test('count-cap surface is gone: setting maxTradesPerDay in override is ignored', () => {
    const { app } = loadApp();
    // Old configs in localStorage may still carry maxTradesPerDay; ignore it.
    app.setMicroCapitalConfig({ laneEnabled: true, armed: true, maxTradesPerDay: 1 });
    app.journal = [
      makeFire({ symbol: 'BTC', ts: todayMs(10), live: true, dryRun: false, realizedUsd: 0.10 }),
    ];
    const r = app.checkMicroCapitalGate({
      symbol: 'ETH', dryRun: false, riskUsd: 0.20, balanceUsd: 50,
      openPositionCount: 0, nowMs: todayMs(12),
    });
    assert.equal(r.allow, true, r.reason || '');
    assert.notEqual(r.reason, 'max-trades-cap');
    app.setMicroCapitalConfig({ laneEnabled: false, armed: false });
  });

  test('per-symbol cooldown: same symbol re-fire inside window blocked, different symbol passes', () => {
    const { app } = loadApp();
    app.setMicroCapitalConfig({ laneEnabled: true, armed: true });
    app.journal = [
      makeFire({ symbol: 'BTC', ts: todayMs(12, 0), live: true, dryRun: false }),
    ];
    const sameSym = app.checkMicroCapitalGate({
      symbol: 'BTC', dryRun: false, riskUsd: 0.20, balanceUsd: 50,
      openPositionCount: 0, nowMs: todayMs(12, 5), // 5 min later
    });
    assert.equal(sameSym.allow, false);
    assert.equal(sameSym.reason, 'symbol-cooldown');
    const otherSym = app.checkMicroCapitalGate({
      symbol: 'ETH', dryRun: false, riskUsd: 0.20, balanceUsd: 50,
      openPositionCount: 0, nowMs: todayMs(12, 5),
    });
    assert.equal(otherSym.allow, true, otherSym.reason || '');
    app.setMicroCapitalConfig({ laneEnabled: false, armed: false });
  });

  test('one-open-position cap: 1 already open → blocked', () => {
    const { app } = loadApp();
    app.setMicroCapitalConfig({ laneEnabled: true, armed: true });
    app.journal = [];
    const r = app.checkMicroCapitalGate({
      symbol: 'BTC', dryRun: false, riskUsd: 0.20, balanceUsd: 50,
      openPositionCount: 1, nowMs: todayMs(12),
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, 'open-position-cap');
    app.setMicroCapitalConfig({ laneEnabled: false, armed: false });
  });

  test('balance=0 blocks even when armed (no capital to risk)', () => {
    const { app } = loadApp();
    app.setMicroCapitalConfig({ laneEnabled: true, armed: true });
    app.journal = [];
    const r = app.checkMicroCapitalGate({
      symbol: 'BTC', dryRun: false, riskUsd: 0.20, balanceUsd: 0,
      openPositionCount: 0, nowMs: todayMs(12),
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, 'no-balance');
    app.setMicroCapitalConfig({ laneEnabled: false, armed: false });
  });

  test('skip entries (skipReason) do NOT count toward trades-today', () => {
    const { app } = loadApp();
    const ts = todayMs(11);
    app.journal = [
      { id: 1, timestamp: ts, symbol: 'BTC', signal: 'skip', dryRun: false, live: false,
        skipReason: 'risk-per-trade-cap', microCapitalAudit: {} },
    ];
    const sum = app._summarizeMicroCapitalDay({ nowMs: todayMs(12) });
    assert.equal(sum.trades, 0, 'skip entries ignored by counter');
  });

  test('_recordMicroCapitalSkip writes a structured journal entry', () => {
    const { app } = loadApp();
    app.journal = [];
    const gate = { allow: false, reason: 'risk-per-trade-cap',
                   audit: { ts: 12345, symbol: 'BTC', dryRun: false, riskUsd: 0.30, maxRiskUsd: 0.25 } };
    app._recordMicroCapitalSkip({ symbol: 'BTC', price: 1, grade: 'a', bias: 'BULL' }, 'LONG', gate);
    assert.equal(app.journal.length, 1);
    const e = app.journal[0];
    assert.equal(e.signal, 'skip');
    assert.equal(e.skipReason, 'risk-per-trade-cap');
    assert.equal(e.symbol, 'BTC');
    assert.equal(e.session, 'mexc-micro-capital-guardrail');
    assert.deepEqual(e.microCapitalAudit.symbol, 'BTC');
  });

  test('setMicroCapitalConfig persists patch and merges with defaults', () => {
    const { app } = loadApp();
    app.setMicroCapitalConfig({ balanceUsd: 100, armed: true });
    const cfg = app._microCapitalConfig();
    assert.equal(cfg.balanceUsd, 100);
    assert.equal(cfg.armed, true);
    assert.equal(cfg.maxRiskPctPerTrade, 0.5, 'unspecified fields fall back to defaults');
    app.setMicroCapitalConfig({ armed: false, balanceUsd: 50 });
  });
});
