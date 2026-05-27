import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fmtFireAlert, fmtCloseAlert, fmtDriftAlert, sendTelegram } from '../trader-notify.mjs';

describe('fmtFireAlert', () => {
  it('renders the standard fire message', () => {
    const out = fmtFireAlert({
      symbol: 'SOL_USDT', dir: 'bull', tier: 'top2',
      entry: 1.234, sl: 1.20, tp: 1.30,
      riskUsd: 2.5, riskPct: 0.03,
      candidateCount: 2, totalSymbols: 10,
    });
    assert.match(out, /🔥 FIRE · SOL LONG/);
    assert.match(out, /tier=top2 · 2\/10 cand/);
    assert.match(out, /entry=1\.234 sl=1\.2 tp=1\.3/);
    assert.match(out, /risk≈\$2\.50 \(3\.0%\)/);
  });

  it('maps bear to SHORT', () => {
    const out = fmtFireAlert({
      symbol: 'BTC_USDT', dir: 'bear', tier: 'best',
      entry: 65000, sl: 65500, tp: 64000,
      riskUsd: 5, riskPct: 0.05,
      candidateCount: 1, totalSymbols: 10,
    });
    assert.match(out, /BTC SHORT/);
  });

  it('omits cand suffix when candidateCount unknown', () => {
    const out = fmtFireAlert({
      symbol: 'X', dir: 'bull', tier: 'top2',
      entry: 1, sl: 0.99, tp: 1.02, riskUsd: 1, riskPct: 0.02,
    });
    assert.doesNotMatch(out, /cand/);
  });
});

describe('fmtCloseAlert', () => {
  it('uses ✅ on a win', () => {
    const out = fmtCloseAlert({ symbol: 'SOL_USDT', dir: 'bull', outcome: 'win', rMultiple: 1.8, realizedUsd: 2.13, holdMs: 30 * 60 * 1000 });
    assert.match(out, /✅ WIN · SOL LONG/);
    assert.match(out, /\+1\.80R · \+\$2\.13/);
    assert.match(out, /held 30m/);
  });

  it('uses ❌ on a loss with negative formatting', () => {
    const out = fmtCloseAlert({ symbol: 'ARB_USDT', dir: 'bear', outcome: 'loss', rMultiple: -1, realizedUsd: -2.5, holdMs: 0 });
    assert.match(out, /❌ LOSS · ARB SHORT/);
    assert.match(out, /-1\.00R · -\$2\.50/);
    assert.doesNotMatch(out, /held/);
  });

  it('uses ⚖️ on a break-even', () => {
    const out = fmtCloseAlert({ symbol: 'X', dir: 'bull', outcome: 'be', rMultiple: 0, realizedUsd: 0, holdMs: 0 });
    assert.match(out, /⚖️ BE/);
  });

  it('handles missing numeric fields gracefully', () => {
    const out = fmtCloseAlert({ symbol: 'X', dir: 'bull', outcome: 'win' });
    assert.match(out, /✅ WIN/);
    assert.doesNotMatch(out, /NaN/);
  });
});

describe('fmtDriftAlert', () => {
  it('flags worsening transitions with ⚠️', () => {
    const out = fmtDriftAlert({ gate: 'side', key: 'long', fromStatus: 'enabled', toStatus: 'blocked', reason: 'live -0.35R/trade after 22 trades' });
    assert.match(out, /⚠️ side-gate · LONG enabled → blocked/);
    assert.match(out, /live -0\.35R/);
  });

  it('flags recovery (back to enabled) with 🟢', () => {
    const out = fmtDriftAlert({ gate: 'session', key: 'asia', fromStatus: 'blocked', toStatus: 'enabled', reason: 'live +0.20R/trade after 30 trades' });
    assert.match(out, /🟢 session-gate · ASIA blocked → enabled/);
  });

  it('uses 🔄 for sideways transitions (downshifted → blocked)', () => {
    const out = fmtDriftAlert({ gate: 'side', key: 'short', fromStatus: 'downshifted', toStatus: 'blocked', reason: 'r' });
    assert.match(out, /🔄 side-gate · SHORT downshifted → blocked/);
  });

  it('truncates very long reasons to 220 chars', () => {
    const long = 'x'.repeat(500);
    const out = fmtDriftAlert({ gate: 'side', key: 'long', fromStatus: 'enabled', toStatus: 'blocked', reason: long });
    const body = out.split('\n')[1];
    assert.equal(body.length, 220);
  });
});


describe('sendTelegram', () => {
  it('uses an abort signal so Telegram hangs cannot interrupt trader progress', async () => {
    const originalFetch = globalThis.fetch;
    let seenInit = null;
    globalThis.fetch = async (_url, init) => {
      seenInit = init;
      return new Response('{"ok":true}', { status: 200 });
    };
    try {
      const out = await sendTelegram('hello', { token: 't', chat: 'c', timeoutMs: 1234 });
      assert.equal(out.ok, true);
      assert.ok(seenInit.signal instanceof AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
