import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitPostMortemSentences,
  extractPostMortemBlock,
  normaliseLessonKey,
  rankLessons,
  buildInsights,
  formatInsightsMarkdown,
} from '../trade-insights.mjs';

const sampleBody = (postMortem) => [
  '# X_USDT LONG — LOSS',
  '',
  '- Fired:    2026-05-26T00:00:00.000Z',
  '',
  '## Setup',
  '- Entry: 1',
  '',
  '## Post-mortem',
  postMortem,
  '',
].join('\n');

describe('extractPostMortemBlock', () => {
  it('returns the post-mortem section body', () => {
    const body = sampleBody('Clean SL hit at -1.00R. FVG body too thin.');
    assert.equal(extractPostMortemBlock(body), 'Clean SL hit at -1.00R. FVG body too thin.');
  });

  it('returns empty for missing section', () => {
    assert.equal(extractPostMortemBlock('# header\n\n## Setup\n- x'), '');
  });
});

describe('splitPostMortemSentences', () => {
  it('splits on sentence terminators and trims sub-9-char noise', () => {
    const r = splitPostMortemSentences('Clean SL hit at -1.00R. FVG body too thin. ok.');
    assert.deepEqual(r, ['Clean SL hit at -1.00R.', 'FVG body too thin.']);
  });

  it('drops the markdown italic placeholder', () => {
    const r = splitPostMortemSentences('_To fill in: what went right, what went wrong, what rule to apply next time._');
    assert.deepEqual(r, []);
  });

  it('returns [] for empty or non-string input', () => {
    assert.deepEqual(splitPostMortemSentences(''), []);
    assert.deepEqual(splitPostMortemSentences(null), []);
  });
});

describe('normaliseLessonKey', () => {
  it('collapses numerics so same lesson with different numbers groups', () => {
    const a = normaliseLessonKey('FVG body 0.12% is below 0.20% — gap too thin.');
    const b = normaliseLessonKey('FVG body 0.18% is below 0.20% — gap too thin.');
    assert.equal(a, b);
  });
});

describe('rankLessons', () => {
  const baseTrade = (outcome, ts) => ({
    filename: `f${ts}.md`, ts, symbol: 'X', side: 'LONG',
    outcome, rMultiple: outcome === 'win' ? 1.8 : -1, realizedUsd: 0,
    session: 'ny-am', grade: 'top2', bias: 'bull',
  });

  it('groups recurring loss sentences and ranks by count', () => {
    const files = [
      { trade: baseTrade('loss', 1), body: sampleBody('FVG body 0.12% is below 0.20%. Asia killzone is lower-volume.') },
      { trade: baseTrade('loss', 2), body: sampleBody('FVG body 0.15% is below 0.20%. Clean SL hit at -1R.') },
      { trade: baseTrade('loss', 3), body: sampleBody('FVG body 0.10% is below 0.20%.') },
      { trade: baseTrade('win',  4), body: sampleBody('Hit TP at +1.80R. Setup played as designed.') },
    ];
    const { edges, leaks } = rankLessons([], files);
    assert.equal(leaks[0].count, 3);
    assert.match(leaks[0].example, /FVG body/);
    assert.equal(edges.length, 0); // wins have only 1 trade so nothing recurring at minN=2
  });

  it('respects minN — singletons do not surface', () => {
    const files = [
      { trade: baseTrade('loss', 1), body: sampleBody('Unique sentence one.') },
      { trade: baseTrade('loss', 2), body: sampleBody('Unique sentence two.') },
    ];
    const { leaks } = rankLessons([], files);
    assert.equal(leaks.length, 0);
  });
});

describe('buildInsights + formatInsightsMarkdown', () => {
  const trades = [
    { filename: 'a.md', ts: 1, symbol: 'BTC', side: 'LONG',  outcome: 'win',  rMultiple: 1.8, realizedUsd: 5, session: 'ny-am',  grade: 'best' },
    { filename: 'b.md', ts: 2, symbol: 'BTC', side: 'SHORT', outcome: 'loss', rMultiple: -1,  realizedUsd: -3, session: 'asia',  grade: 'top2' },
    { filename: 'c.md', ts: 3, symbol: 'ETH', side: 'LONG',  outcome: 'loss', rMultiple: -1,  realizedUsd: -3, session: 'asia',  grade: 'top2' },
  ];
  const files = [
    { trade: trades[1], body: sampleBody('Clean SL hit at -1R. Asia killzone is lower-volume.') },
    { trade: trades[2], body: sampleBody('Clean SL hit at -1R. Asia killzone is lower-volume.') },
  ];

  it('produces a structured insights object with the expected sections', () => {
    const insights = buildInsights({ trades, files, now: 4 * 86400 * 1000 });
    assert.equal(insights.all.total, 3);
    assert.equal(insights.all.wins, 1);
    assert.equal(insights.all.losses, 2);
    assert.equal(insights.leaks.length, 2);
    assert.equal(insights.leaks[0].count, 2);
  });

  it('renders markdown with all required sections', () => {
    const insights = buildInsights({ trades, files, now: 4 * 86400 * 1000 });
    const md = formatInsightsMarkdown(insights);
    assert.match(md, /# Trade Insights/);
    assert.match(md, /## Performance/);
    assert.match(md, /## Edges/);
    assert.match(md, /## Leaks/);
    assert.match(md, /Asia killzone is lower-volume/);
  });

  it('renders empty-state copy when there are no recurring lessons', () => {
    const insights = buildInsights({ trades: [], files: [], now: 0 });
    const md = formatInsightsMarkdown(insights);
    assert.match(md, /None yet/);
  });
});
