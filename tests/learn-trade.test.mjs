import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  learnBucket,
  learnFileSlug,
  formatLearningMarkdown,
  writeLearningFile,
} from '../trade-learnings.mjs';

describe('trade-learnings (pure)', () => {
  test('learnBucket maps win/loss/be; everything else returns null', () => {
    assert.equal(learnBucket('win'),     'wins');
    assert.equal(learnBucket('WIN'),     'wins');
    assert.equal(learnBucket('loss'),    'losses');
    assert.equal(learnBucket('LOSS'),    'losses');
    assert.equal(learnBucket('be'),      'be');
    assert.equal(learnBucket(null),      null);
    assert.equal(learnBucket('pending'), null);
    assert.equal(learnBucket(''),        null);
  });

  test('learnFileSlug uses UTC date + symbol + side', () => {
    const s = learnFileSlug({
      timestamp: Date.UTC(2026, 4, 24, 8, 30),
      symbol: 'XRP', side: 'long',
    });
    assert.equal(s, '2026-05-24-0830-XRP-LONG.md');
  });

  test('formatLearningMarkdown renders setup/execution/post-mortem sections', () => {
    const md = formatLearningMarkdown({
      timestamp: Date.UTC(2026, 4, 24, 8, 30),
      symbol: 'XRP', side: 'long', outcome: 'win',
      entry: 2.34, sl: 2.30, tp: 2.42,
      priceAtCall: 2.341, exitPrice: 2.42,
      realizedUsd: 0.18, rMultiple: 2.0,
      grade: 'a-plus', bias: 'BULLISH', session: 'NY KZ',
      confluences: ['FVG', 'CHoCH', 'OB'],
      analysis: 'Bullish FVG retest with NY KZ CHoCH confirmation.',
      outcomeChecks: { '30': 2.39, '60': 2.42 },
      orderId: 'TEST-123',
    });
    assert.match(md, /# XRP LONG — WIN/);
    assert.match(md, /## Setup/);
    assert.match(md, /## Execution/);
    assert.match(md, /## Post-mortem/);
    assert.match(md, /Confluences: FVG, CHoCH, OB/);
    assert.match(md, /Order ID: TEST-123/);
    assert.match(md, /Realised:\s+\+0\.1800 USD\s+2\.00R/);
    assert.match(md, /Path:\s+30m=2\.3900.*60m=2\.4200/);
  });

  test('formatLearningMarkdown renders fee + funding accounting block when present', () => {
    const md = formatLearningMarkdown({
      timestamp: Date.UTC(2026, 4, 24, 8, 30),
      symbol: 'XRP', side: 'long', outcome: 'win',
      entry: 2.34, sl: 2.30, tp: 2.42,
      priceAtCall: 2.34, exitPrice: 2.42,
      realizedUsd: 0.0794,
      accounting: {
        grossUsd: 0.0800, feeUsdOpen: 0.0002, feeUsdClose: 0.0002,
        fundingUsd: 0.0002, windowsCrossed: 2, holdMs: 16 * 3600 * 1000,
        netUsd: 0.0794,
      },
    });
    assert.match(md, /Realised:\s+\+0\.0794 USD\s+—\s+\(after fees \+ funding\)/);
    assert.match(md, /Gross:\s+\+0\.0800 USD/);
    assert.match(md, /Fee open:\s+\+0\.0002 USD/);
    assert.match(md, /Funding:\s+\+0\.0002 USD\s+\(2 × 8h windows · held 16\.0h\)/);
  });

  test('formatLearningMarkdown tolerates missing optional fields', () => {
    const md = formatLearningMarkdown({
      timestamp: Date.UTC(2026, 4, 24, 8, 30),
      symbol: 'BTC', side: 'short', outcome: 'loss',
    });
    assert.match(md, /# BTC SHORT — LOSS/);
    assert.match(md, /Realised:\s+—/);
    assert.match(md, /_\(no analysis text recorded\)_/);
  });
});

describe('writeLearningFile', () => {
  test('writes a markdown file under the correct bucket', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'learn-'));
    try {
      const r = await writeLearningFile({
        timestamp: Date.UTC(2026, 4, 24, 8, 30),
        symbol: 'XRP', side: 'long', outcome: 'win',
        entry: 2.34, sl: 2.30, tp: 2.42, realizedUsd: 0.18, rMultiple: 2.0,
      }, root);
      assert.equal(r.ok, true);
      assert.equal(r.deduped, false);
      const wins = await readdir(path.join(root, 'wins'));
      assert.deepEqual(wins, ['2026-05-24-0830-XRP-LONG.md']);
      const body = await readFile(path.join(root, 'wins', wins[0]), 'utf8');
      assert.match(body, /# XRP LONG — WIN/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('re-POSTing the same trade is a no-op (deduped:true, no second file)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'learn-'));
    try {
      const payload = {
        timestamp: Date.UTC(2026, 4, 24, 8, 30),
        symbol: 'XRP', side: 'long', outcome: 'win',
        entry: 2.34, sl: 2.30, tp: 2.42,
      };
      const first  = await writeLearningFile(payload, root);
      const second = await writeLearningFile(payload, root);
      assert.equal(first.deduped, false);
      assert.equal(second.deduped, true);
      const wins = await readdir(path.join(root, 'wins'));
      assert.equal(wins.length, 1, 'still one file after retry');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('bad outcome → returns {ok:false, reason:bad-outcome}; writes nothing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'learn-'));
    try {
      const r = await writeLearningFile({
        timestamp: Date.UTC(2026, 4, 24, 8, 30),
        symbol: 'XRP', side: 'long', outcome: 'pending',
      }, root);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'bad-outcome');
      // No bucket dirs should exist
      const items = await readdir(root);
      assert.equal(items.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('symbol/side are sanitised (no path traversal possible)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'learn-'));
    try {
      const r = await writeLearningFile({
        timestamp: Date.UTC(2026, 4, 24, 8, 30),
        symbol: '../etc/passwd', side: 'long/../../x', outcome: 'win',
        entry: 1, sl: 0.9, tp: 1.1,
      }, root);
      assert.equal(r.ok, true);
      // Slugifier strips /, dots, slashes — file must live inside root/wins
      assert.equal(path.dirname(r.file), path.join(root, 'wins'));
      assert.equal(path.basename(r.file).includes('..'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
