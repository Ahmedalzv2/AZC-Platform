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

  it('session-skiplist short-circuits before pick/side/session gates', () => {
    const r = decideFireAction(baseInput({
      currentSession: 'london',
      skipSessions: ['london'],
    }));
    assert.equal(r.skip, 'session-skiplist');
    assert.match(r.detail, /london session is in SKIP_SESSIONS/);
  });

  it('session-skiplist is a no-op when current session is not in the list', () => {
    const r = decideFireAction(baseInput({
      currentSession: 'ny-am',
      skipSessions: ['london'],
    }));
    assert.notEqual(r.skip, 'session-skiplist');
  });

  it('empty/missing skipSessions defaults to no-op', () => {
    const r1 = decideFireAction(baseInput({ currentSession: 'london', skipSessions: [] }));
    assert.notEqual(r1.skip, 'session-skiplist');
    const r2 = decideFireAction(baseInput({ currentSession: 'london', skipSessions: undefined }));
    assert.notEqual(r2.skip, 'session-skiplist');
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

describe('decideFireAction — sentiment gate, off mode', () => {
  it('matches baseline output when mode=off and no snapshot', () => {
    const baseline = decideFireAction(baseInput());
    const withOff = decideFireAction(baseInput({
      sentimentGateMode: 'off',
      sentimentSnapshot: null,
    }));
    assert.deepEqual(withOff, baseline);
  });

  it('matches baseline when mode=off even with a disagree snapshot', () => {
    const baseline = decideFireAction(baseInput());
    const withOff = decideFireAction(baseInput({
      sentimentGateMode: 'off',
      sentimentSnapshot: { label: 'bear', source: 'topic', fetchedAtMs: 1 },
    }));
    assert.deepEqual(withOff, baseline);
  });
});

describe('decideFireAction — sentiment gate, shadow mode', () => {
  it('attaches shadow.wouldSkip when sentiment disagrees with bull setup', () => {
    const r = decideFireAction(baseInput({
      sentimentGateMode: 'shadow',
      sentimentSnapshot: { label: 'bear', source: 'topic', fetchedAtMs: 1 },
    }));
    assert.equal(r.action, 'fire');
    assert.deepEqual(r.shadow, { gate: 'sentiment', wouldSkip: true, label: 'bear', source: 'topic' });
    // risk + tier must be unchanged
    const baseline = decideFireAction(baseInput());
    assert.equal(r.tier, baseline.tier);
    assert.equal(r.riskPct, baseline.riskPct);
  });

  it('no shadow field when sentiment agrees', () => {
    const r = decideFireAction(baseInput({
      sentimentGateMode: 'shadow',
      sentimentSnapshot: { label: 'bull', source: 'topic', fetchedAtMs: 1 },
    }));
    assert.equal(r.action, 'fire');
    assert.equal(r.shadow, undefined);
  });

  it('no shadow field on neutral sentiment (fail-open)', () => {
    const r = decideFireAction(baseInput({
      sentimentGateMode: 'shadow',
      sentimentSnapshot: { label: 'neutral', source: 'news', fetchedAtMs: 1 },
    }));
    assert.equal(r.action, 'fire');
    assert.equal(r.shadow, undefined);
  });

  it('no shadow field on null snapshot (fail-open)', () => {
    const r = decideFireAction(baseInput({
      sentimentGateMode: 'shadow',
      sentimentSnapshot: null,
    }));
    assert.equal(r.action, 'fire');
    assert.equal(r.shadow, undefined);
  });
});

describe('decideFireAction — sentiment gate, live mode', () => {
  it('skips with sentiment-disagree when bear sentiment vs bull setup', () => {
    const r = decideFireAction(baseInput({
      sentimentGateMode: 'live',
      sentimentSnapshot: { label: 'bear', source: 'topic', fetchedAtMs: 1 },
    }));
    assert.equal(r.action, 'skip');
    assert.equal(r.skip, 'sentiment-disagree');
    assert.match(r.detail, /bear sentiment vs bull setup/);
    assert.equal(r.source, 'topic');
  });

  it('skips with sentiment-disagree when bull sentiment vs bear setup', () => {
    const r = decideFireAction(baseInput({
      candidates: [cand('SOL_USDT', 'bear', 0.0001)],
      sentimentGateMode: 'live',
      sentimentSnapshot: { label: 'bull', source: 'news', fetchedAtMs: 1 },
    }));
    assert.equal(r.action, 'skip');
    assert.equal(r.skip, 'sentiment-disagree');
    assert.match(r.detail, /bull sentiment vs bear setup/);
  });

  it('fires normally when sentiment agrees', () => {
    const r = decideFireAction(baseInput({
      sentimentGateMode: 'live',
      sentimentSnapshot: { label: 'bull', source: 'topic', fetchedAtMs: 1 },
    }));
    assert.equal(r.action, 'fire');
  });

  it('fail-open on null snapshot in live mode', () => {
    const r = decideFireAction(baseInput({
      sentimentGateMode: 'live',
      sentimentSnapshot: null,
    }));
    assert.equal(r.action, 'fire');
  });

  it('side-blocked beats sentiment-disagree (gate ordering)', () => {
    const r = decideFireAction(baseInput({
      sideStatus: { long: { status: 'blocked', reason: 'side gone' }, short: enabled('SHORT') },
      sentimentGateMode: 'live',
      sentimentSnapshot: { label: 'bear', source: 'topic', fetchedAtMs: 1 },
    }));
    assert.equal(r.skip, 'side-blocked');
  });
});

describe('decideFireAction — per-symbol-side gate', () => {
  it('omitted symbolSideStatus is a no-op (fail-open)', () => {
    const r = decideFireAction(baseInput());
    assert.equal(r.action, 'fire');
    assert.deepEqual(r.downshifts, []);
  });

  it('blocked symbol-side filters that candidate out and the next survivor wins', () => {
    const r = decideFireAction(baseInput({
      candidates: [
        cand('SOL_USDT', 'bear', 0.0001),   // closest, but blocked below
        cand('XRP_USDT', 'bear', 0.0002),
      ],
      symbolSideStatus: {
        'SOL_USDT:short': { status: 'blocked', reason: 'live -0.40R/trade after 12 trades' },
        'XRP_USDT:short': { status: 'enabled', reason: '+0.20R/trade over 14' },
      },
    }));
    assert.equal(r.action, 'fire');
    assert.equal(r.pick.symbol, 'XRP_USDT');
    assert.equal(r.candidateCount, 1, 'blocked candidate is removed from the surviving count');
  });

  it('all candidates blocked by symbol-side → skip symbol-side-blocked-all', () => {
    const r = decideFireAction(baseInput({
      candidates: [
        cand('SOL_USDT', 'bear', 0.0001),
        cand('XRP_USDT', 'bear', 0.0002),
      ],
      symbolSideStatus: {
        'SOL_USDT:short': { status: 'blocked', reason: 'live -0.40R after 12' },
        'XRP_USDT:short': { status: 'blocked', reason: 'live -0.50R after 11' },
      },
    }));
    assert.equal(r.action, 'skip');
    assert.equal(r.skip, 'symbol-side-blocked-all');
    assert.match(r.detail, /2 candidate/);
  });

  it('downshifted symbol-side halves risk and records source=symbol-side', () => {
    const r = decideFireAction(baseInput({
      symbolSideStatus: {
        'SOL_USDT:long':  { status: 'downshifted', reason: 'live -0.12R/trade after 12 — halving risk' },
        'SOL_USDT:short': { status: 'enabled',     reason: '+0.20R/trade over 14' },
      },
    }));
    assert.equal(r.action, 'fire');
    assert.equal(r.riskPct, RISK.top2 * 0.5);
    assert.equal(r.downshifts.length, 1);
    assert.equal(r.downshifts[0].source, 'symbol-side');
    assert.equal(r.downshifts[0].key, 'SOL_USDT:long');
  });

  it('compound downshift: side + session + symbol-side → eighths risk', () => {
    const r = decideFireAction(baseInput({
      sideStatus: {
        long:  { status: 'downshifted', reason: 'side reason' },
        short: enabled('SHORT'),
      },
      sessionStatus: {
        ...baseInput().sessionStatus,
        london: { status: 'downshifted', reason: 'session reason' },
      },
      symbolSideStatus: {
        'SOL_USDT:long': { status: 'downshifted', reason: 'symbol-side reason' },
      },
    }));
    assert.equal(r.riskPct, RISK.top2 * 0.5 * 0.5 * 0.5);
    assert.equal(r.downshifts.length, 3);
    assert.ok(r.downshifts.some(d => d.source === 'symbol-side'));
  });

  it('missing key in symbolSideStatus fails open (treated as enabled)', () => {
    const r = decideFireAction(baseInput({
      symbolSideStatus: {
        'XRP_USDT:long': { status: 'blocked', reason: 'unrelated' },
        // SOL_USDT:long intentionally missing
      },
    }));
    assert.equal(r.action, 'fire');
    assert.deepEqual(r.downshifts, []);
  });

  it('session-side: omitted is a no-op (fail-open)', () => {
    const r = decideFireAction(baseInput());
    assert.equal(r.action, 'fire');
  });

  it('session-side: blocked for current session+side filters all bulls when session is london', () => {
    const r = decideFireAction(baseInput({
      candidates: [
        cand('SOL_USDT', 'bull', 0.0001),
        cand('XRP_USDT', 'bear', 0.0002),
      ],
      currentSession: 'london',
      sessionSideStatus: {
        'london:long':  { status: 'blocked', reason: 'live -0.40R after 22' },
        'london:short': { status: 'enabled', reason: '+0.15R over 20' },
      },
    }));
    assert.equal(r.action, 'fire');
    // Bull is filtered; bear survives and wins.
    assert.equal(r.pick.symbol, 'XRP_USDT');
    assert.equal(r.candidateCount, 1);
  });

  it('session-side: all candidates filtered → session-side-blocked-all', () => {
    const r = decideFireAction(baseInput({
      candidates: [
        cand('SOL_USDT', 'bull', 0.0001),
        cand('XRP_USDT', 'bull', 0.0002),
      ],
      currentSession: 'off',
      sessionSideStatus: {
        'off:long':  { status: 'blocked', reason: 'off-bull bleeds' },
      },
    }));
    assert.equal(r.action, 'skip');
    assert.equal(r.skip, 'session-side-blocked-all');
    assert.match(r.detail, /2 candidate/);
  });

  it('session-side: downshifted halves risk and records source=session-side', () => {
    const r = decideFireAction(baseInput({
      currentSession: 'off',
      sessionSideStatus: {
        'off:long': { status: 'downshifted', reason: 'live -0.08R after 20' },
      },
    }));
    assert.equal(r.action, 'fire');
    assert.equal(r.riskPct, RISK.top2 * 0.5);
    assert.equal(r.downshifts.some(d => d.source === 'session-side' && d.key === 'off:long'), true);
  });

  it('session-side: all four downshift sources compound to 1/16 risk', () => {
    const r = decideFireAction(baseInput({
      sideStatus: { long: { status: 'downshifted', reason: 's' }, short: enabled('SHORT') },
      sessionStatus: { ...baseInput().sessionStatus, london: { status: 'downshifted', reason: 's' } },
      symbolSideStatus: { 'SOL_USDT:long': { status: 'downshifted', reason: 's' } },
      sessionSideStatus: { 'london:long': { status: 'downshifted', reason: 's' } },
    }));
    assert.equal(r.riskPct, RISK.top2 * 0.5 * 0.5 * 0.5 * 0.5);
    assert.equal(r.downshifts.length, 4);
  });

  it('session-side: missing key fails open (treated as enabled)', () => {
    const r = decideFireAction(baseInput({
      currentSession: 'asia',
      sessionSideStatus: { 'london:long': { status: 'blocked', reason: 'unrelated' } },
    }));
    assert.equal(r.action, 'fire');
  });

  it('symbol-side filter runs before side-blocked check (so a blocked side does not mask a survivor)', () => {
    // SOL:short blocked by symbol-side, XRP:short survives. Even if a
    // hypothetical global SHORT side state were degraded later we still
    // need the survivor to be evaluated — verify by giving sideStatus
    // an enabled SHORT and confirming we fire on XRP rather than skipping.
    const r = decideFireAction(baseInput({
      candidates: [
        cand('SOL_USDT', 'bear', 0.0001),
        cand('XRP_USDT', 'bear', 0.0002),
      ],
      sideStatus: { long: enabled('LONG'), short: enabled('SHORT') },
      symbolSideStatus: {
        'SOL_USDT:short': { status: 'blocked', reason: 'SOL-short bleeding' },
      },
    }));
    assert.equal(r.action, 'fire');
    assert.equal(r.pick.symbol, 'XRP_USDT');
  });
});
