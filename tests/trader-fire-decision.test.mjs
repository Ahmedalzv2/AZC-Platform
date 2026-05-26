import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideFireAction } from '../trader-fire-decision.mjs';

const RISK = { default: 0.02, top2: 0.03, best: 0.05 };

// Helper — minimal candidate shape matching what buildCandidate returns.
const cand = (symbol, dir, distPct) => ({
  symbol,
  fvg: { dir, formedAt: 1000 },
  distPct,
  price: 1, sl: 1, tp: 1, sideOpen: dir === 'bull' ? 1 : 3,
  stopDistUsdPerContract: 0.001, meta: { contractSize: 1, minVol: 1, priceUnit: 0.001 },
});
const enabled = (label) => ({ status: 'enabled', reason: `+0.200R over 30 trades` });

const baseInput = (overrides = {}) => ({
  candidates: [cand('SOL_USDT', 'bull', 0.0001)],
  pendingOrder: false,
  openPositions: 0,
  maxOpenPositions: 1,
  sideStatus:    { long: enabled('LONG'),    short: enabled('SHORT') },
  sessionStatus: { asia: enabled('asia'),    london: enabled('london'), 'ny-am': enabled('ny-am'), 'late-ny': enabled('late-ny'), off: enabled('off') },
  currentSession: 'london',
  riskTiers: RISK,
  ...overrides,
});

describe('decideFireAction — skip paths', () => {
  it('pending-order short-circuits before any other gate', () => {
    const r = decideFireAction(baseInput({ pendingOrder: true, candidates: [] }));
    assert.equal(r.action, 'skip');
    assert.equal(r.skip, 'pending-order');
  });

  it('in-position when openPositions >= max', () => {
    const r = decideFireAction(baseInput({ openPositions: 1, maxOpenPositions: 1 }));
    assert.equal(r.skip, 'in-position');
  });

  it('no-candidates on empty array', () => {
    const r = decideFireAction(baseInput({ candidates: [] }));
    assert.equal(r.skip, 'no-candidates');
  });

  it('no-candidates when candidates is not an array', () => {
    const r = decideFireAction(baseInput({ candidates: null }));
    assert.equal(r.skip, 'no-candidates');
  });

  it('side-blocked surfaces the reason in detail', () => {
    const r = decideFireAction(baseInput({
      sideStatus: {
        long:  { status: 'blocked', reason: 'live -0.350R/trade < block threshold -0.30R after 22 trades' },
        short: enabled('SHORT'),
      },
    }));
    assert.equal(r.skip, 'side-blocked');
    assert.match(r.detail, /LONG: live -0\.350R/);
  });

  it('session-blocked surfaces session label + reason', () => {
    const r = decideFireAction(baseInput({
      sessionStatus: {
        ...baseInput().sessionStatus,
        london: { status: 'blocked', reason: 'live -0.40R/trade after 25 trades' },
      },
    }));
    assert.equal(r.skip, 'session-blocked');
    assert.match(r.detail, /london: live -0\.40R/);
  });

  it('side-blocked is checked before session-blocked', () => {
    const r = decideFireAction(baseInput({
      sideStatus: { long: { status: 'blocked', reason: 'side gone' }, short: enabled('SHORT') },
      sessionStatus: { ...baseInput().sessionStatus, london: { status: 'blocked', reason: 'session gone' } },
    }));
    assert.equal(r.skip, 'side-blocked');
  });
});

describe('decideFireAction — happy path', () => {
  it('single candidate → tier=top2, baseRiskPct=RISK.top2', () => {
    const r = decideFireAction(baseInput());
    assert.equal(r.action, 'fire');
    assert.equal(r.tier, 'top2');
    assert.equal(r.baseRiskPct, RISK.top2);
    assert.equal(r.riskPct, RISK.top2);
    assert.deepEqual(r.downshifts, []);
    assert.equal(r.candidateCount, 1);
  });

  it('two close candidates → tier=top2 (margin <= 50%)', () => {
    const r = decideFireAction(baseInput({
      candidates: [cand('SOL', 'bull', 0.0001), cand('ARB', 'bull', 0.00012)],
    }));
    assert.equal(r.tier, 'top2');
    assert.equal(r.riskPct, RISK.top2);
  });

  it('clear winner → tier=best, baseRiskPct=RISK.best', () => {
    const r = decideFireAction(baseInput({
      candidates: [cand('SOL', 'bull', 0.0001), cand('ARB', 'bull', 0.0002)], // 100% margin
    }));
    assert.equal(r.tier, 'best');
    assert.equal(r.baseRiskPct, RISK.best);
    assert.equal(r.riskPct, RISK.best);
  });

  it('picks the closest distPct (lowest)', () => {
    const r = decideFireAction(baseInput({
      candidates: [
        cand('FAR',     'bull', 0.0005),
        cand('CLOSEST', 'bull', 0.0001),
        cand('MID',     'bull', 0.0003),
      ],
    }));
    assert.equal(r.pick.symbol, 'CLOSEST');
  });

  it('sideKey maps bear → short', () => {
    const r = decideFireAction(baseInput({
      candidates: [cand('SOL', 'bear', 0.0001)],
    }));
    assert.equal(r.sideKey, 'short');
  });

  it('sessionKey echoes currentSession', () => {
    const r = decideFireAction(baseInput({ currentSession: 'asia' }));
    assert.equal(r.sessionKey, 'asia');
  });
});

describe('decideFireAction — drift-gate downshifts', () => {
  it('side downshifted halves risk', () => {
    const r = decideFireAction(baseInput({
      sideStatus: {
        long:  { status: 'downshifted', reason: 'live -0.15R/trade after 22 trades — halving risk' },
        short: enabled('SHORT'),
      },
    }));
    assert.equal(r.riskPct, RISK.top2 * 0.5);
    assert.equal(r.downshifts.length, 1);
    assert.equal(r.downshifts[0].source, 'side');
  });

  it('session downshifted halves risk', () => {
    const r = decideFireAction(baseInput({
      sessionStatus: {
        ...baseInput().sessionStatus,
        london: { status: 'downshifted', reason: 'live -0.12R/trade after 25 trades — halving risk' },
      },
    }));
    assert.equal(r.riskPct, RISK.top2 * 0.5);
    assert.equal(r.downshifts.length, 1);
    assert.equal(r.downshifts[0].source, 'session');
  });

  it('both downshifted quarters risk (compounding)', () => {
    const r = decideFireAction(baseInput({
      sideStatus: {
        long:  { status: 'downshifted', reason: 'side reason' },
        short: enabled('SHORT'),
      },
      sessionStatus: {
        ...baseInput().sessionStatus,
        london: { status: 'downshifted', reason: 'session reason' },
      },
    }));
    assert.equal(r.riskPct, RISK.top2 * 0.5 * 0.5);
    assert.equal(r.downshifts.length, 2);
  });

  it('downshift applies on top of the BEST tier when there is a clear winner', () => {
    const r = decideFireAction(baseInput({
      candidates: [cand('SOL', 'bull', 0.0001), cand('ARB', 'bull', 0.0003)],
      sideStatus: {
        long:  { status: 'downshifted', reason: 'side reason' },
        short: enabled('SHORT'),
      },
    }));
    assert.equal(r.tier, 'best');
    assert.equal(r.baseRiskPct, RISK.best);
    assert.equal(r.riskPct, RISK.best * 0.5);
  });

  it('missing session entry behaves as no gate (enabled by default)', () => {
    const r = decideFireAction(baseInput({
      sessionStatus: { /* no entry for london */ },
    }));
    assert.equal(r.action, 'fire');
    assert.deepEqual(r.downshifts, []);
  });
});
