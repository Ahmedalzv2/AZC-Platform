import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseLearningFile, summarise, buildStats } from '../trade-stats.mjs';

const fixtureBody = ({ outcome, usd, r, session = 'ny-am', grade = 'top2', bias = 'bull' }) => `
# X LONG — ${outcome.toUpperCase()}

- Fired:    2026-05-25T13:30:00.000Z
- Grade:    ${grade}
- Bias:     ${bias}
- Session:  ${session}
- Lane:     mexc-micro-capital

## Execution
- Outcome:    ${outcome.toUpperCase()}
- Realised:   ${usd >= 0 ? '+' : ''}${usd.toFixed(4)} USD  ${r >= 0 ? '+' : ''}${r.toFixed(2)}R  (after fees + funding)
`;

describe('parseLearningFile', () => {
  test('extracts symbol/side/ts from filename and outcome/R from body', () => {
    const t = parseLearningFile('2026-05-25-1330-XRP_USDT-LONG.md',
      fixtureBody({ outcome: 'win', usd: 0.18, r: 1.5 }));
    assert.equal(t.symbol, 'XRP_USDT');
    assert.equal(t.side, 'LONG');
    assert.equal(t.outcome, 'win');
    assert.equal(t.rMultiple, 1.5);
    assert.equal(t.realizedUsd, 0.18);
    assert.equal(t.session, 'ny-am');
    assert.equal(t.ts, Date.UTC(2026, 4, 25, 13, 30));
  });

  test('returns null for filenames that do not match the slug shape', () => {
    assert.equal(parseLearningFile('README.md', 'whatever'), null);
    assert.equal(parseLearningFile('2026-05-25.md', 'whatever'), null);
  });

  test('treats em-dash placeholders as null', () => {
    const body = fixtureBody({ outcome: 'loss', usd: -0.1, r: -1.0, session: '—', grade: '—' });
    const t = parseLearningFile('2026-05-25-1330-X-LONG.md', body);
    assert.equal(t.session, null);
    assert.equal(t.grade, null);
  });
});

describe('summarise', () => {
  test('empty input returns zeros + null rates', () => {
    const s = summarise([]);
    assert.equal(s.total, 0);
    assert.equal(s.winRate, null);
    assert.equal(s.expectancyR, null);
  });

  test('win rate and expectancy are computed from resolved trades only', () => {
    const trades = [
      { outcome: 'win',  rMultiple: 1.5,  realizedUsd: 0.30, symbol: 'A', session: 'ny',   grade: 'top2', side: 'LONG' },
      { outcome: 'loss', rMultiple: -1.0, realizedUsd: -0.20, symbol: 'A', session: 'asia', grade: 'top2', side: 'LONG' },
      { outcome: 'loss', rMultiple: -1.0, realizedUsd: -0.20, symbol: 'B', session: 'ny',   grade: 'default', side: 'SHORT' },
      { outcome: 'be',   rMultiple: 0.0,  realizedUsd: 0.00, symbol: 'B', session: 'ny',   grade: 'top2', side: 'SHORT' },
    ];
    const s = summarise(trades);
    assert.equal(s.total, 4);
    assert.equal(s.wins, 1);
    assert.equal(s.losses, 2);
    assert.equal(s.be, 1);
    assert.equal(s.winRate, 1/3);
    assert.equal(Math.round(s.netR * 100) / 100, -0.5);
    assert.equal(s.bySymbol.A.n, 2);
    assert.equal(s.bySymbol.A.w, 1);
    assert.equal(s.bySession['ny'].n, 3);
  });
});

describe('buildStats (integration with disk)', () => {
  test('reads wins/losses/be markdown and slices by window', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stats-'));
    try {
      await mkdir(path.join(root, 'wins'),   { recursive: true });
      await mkdir(path.join(root, 'losses'), { recursive: true });
      await mkdir(path.join(root, 'be'),     { recursive: true });
      const now = Date.UTC(2026, 4, 26, 12, 0);
      // recent win (within 24h)
      await writeFile(path.join(root, 'wins', '2026-05-26-0000-XRP_USDT-LONG.md'),
        fixtureBody({ outcome: 'win', usd: 0.20, r: 1.5 }));
      // recent loss
      await writeFile(path.join(root, 'losses', '2026-05-26-0100-LTC_USDT-SHORT.md'),
        fixtureBody({ outcome: 'loss', usd: -0.20, r: -1.0 }));
      // old loss (10 days ago)
      await writeFile(path.join(root, 'losses', '2026-05-16-0100-BTC_USDT-LONG.md'),
        fixtureBody({ outcome: 'loss', usd: -0.30, r: -1.0 }));
      const s = await buildStats(root, now);
      assert.equal(s.all.total, 3);
      assert.equal(s.last24h.total, 2);
      assert.equal(s.last24h.winRate, 0.5);
      assert.equal(s.last7d.total, 2);
      assert.equal(s.recent.length, 3);
      assert.equal(s.recent[s.recent.length-1].symbol, 'LTC_USDT');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('missing folders are tolerated (returns empty stats)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stats-'));
    try {
      const s = await buildStats(root, Date.now());
      assert.equal(s.all.total, 0);
      assert.equal(s.last24h.total, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
