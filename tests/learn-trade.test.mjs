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
  generatePostMortem,
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
    assert.match(md, /Realised:\s+\+0\.0794 USD\s+—\s+\(net, after fees \+ funding\)/);
    assert.match(md, /Gross:\s+\+0\.0800 USD/);
    assert.match(md, /Fee open:\s+\+0\.0002 USD/);
    assert.match(md, /Funding:\s+\+0\.0002 USD\s+\(2 × 8h windows · held 16\.0h\)/);
  });

  test('formatLearningMarkdown renders sentiment label on headlines when present', () => {
    const md = formatLearningMarkdown({
      timestamp: Date.UTC(2026, 4, 24, 8, 30),
      symbol: 'BTC', side: 'long', outcome: 'win',
      entry: 70000, sl: 69500, tp: 71000, rMultiple: 2.0,
      context: {
        source: 'lunarcrush',
        headlines: [
          { title: 'BTC squeezes higher', sentiment: 'bullish' },
          { title: 'Hack drains exchange', sentiment: 'bearish' },
          { title: 'Neutral commentary', sentiment: null },
        ],
      },
    });
    assert.match(md, /BTC squeezes higher.*\[bullish\]/);
    assert.match(md, /Hack drains exchange.*\[bearish\]/);
    // Neutral / missing sentiment renders no bracketed label
    assert.doesNotMatch(md, /Neutral commentary.*\[/);
  });

  test('formatLearningMarkdown renders Context section when payload.context has headlines', () => {
    const md = formatLearningMarkdown({
      timestamp: Date.UTC(2026, 4, 24, 8, 30),
      symbol: 'BTC', side: 'long', outcome: 'win',
      entry: 70000, sl: 69500, tp: 71000, rMultiple: 2.0,
      context: {
        source: 'cryptopanic',
        fetchedAtMs: Date.UTC(2026, 4, 24, 8, 30),
        headlines: [
          { title: 'BTC squeezes higher on ETF inflows', url: 'https://x/1', publishedAt: '2026-05-24T08:00:00Z' },
          { title: 'Macro: CPI print at 8:30 ET', url: 'https://x/2' },
        ],
      },
    });
    assert.match(md, /## Context/);
    assert.match(md, /Source: cryptopanic/);
    assert.match(md, /BTC squeezes higher on ETF inflows/);
    assert.match(md, /CPI print at 8:30 ET/);
  });

  test('formatLearningMarkdown omits Context section when no context present', () => {
    const md = formatLearningMarkdown({
      timestamp: Date.UTC(2026, 4, 24, 8, 30),
      symbol: 'BTC', side: 'long', outcome: 'win',
      entry: 70000, sl: 69500, tp: 71000, rMultiple: 2.0,
    });
    assert.doesNotMatch(md, /## Context/);
  });

  test('formatLearningMarkdown omits Context section when context.headlines is empty / malformed', () => {
    const md1 = formatLearningMarkdown({
      symbol: 'BTC', side: 'long', outcome: 'win', rMultiple: 1.0,
      context: { source: 'x', headlines: [] },
    });
    const md2 = formatLearningMarkdown({
      symbol: 'BTC', side: 'long', outcome: 'win', rMultiple: 1.0,
      context: { headlines: 'not-an-array' },
    });
    const md3 = formatLearningMarkdown({
      symbol: 'BTC', side: 'long', outcome: 'win', rMultiple: 1.0,
      context: 'not-an-object',
    });
    assert.doesNotMatch(md1, /## Context/);
    assert.doesNotMatch(md2, /## Context/);
    assert.doesNotMatch(md3, /## Context/);
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
      assert.equal(path.dirname(r.file), path.join(root, 'wins'));
      assert.equal(path.basename(r.file).includes('..'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('formatLearningMarkdown — ## Sentiment section', () => {
  const base = {
    symbol: 'SOL_USDT', side: 'long', outcome: 'win',
    entry: 100, sl: 99, tp: 102, priceAtCall: 100,
    realizedUsd: 1, rMultiple: 1, timestamp: 1779950000000,
    analysis: 'x',
  };

  test('emits section when sentiment present', () => {
    const md = formatLearningMarkdown({
      ...base,
      sentiment: { label: 'bull', source: 'topic', agree: true, shadowWouldSkip: false },
    });
    assert.match(md, /## Sentiment \(at fire\)/);
    assert.match(md, /source: topic/);
    assert.match(md, /label: +bull/);
    assert.match(md, /agree: +yes/);
    assert.doesNotMatch(md, /shadow gate would have vetoed/);
  });

  test('flags shadow would-veto when shadowWouldSkip true', () => {
    const md = formatLearningMarkdown({
      ...base,
      sentiment: { label: 'bear', source: 'news', agree: false, shadowWouldSkip: true },
    });
    assert.match(md, /agree: +no/);
    assert.match(md, /shadow gate would have vetoed/);
  });

  test('omits section entirely when sentiment absent', () => {
    const md = formatLearningMarkdown({ ...base, sentiment: null });
    assert.doesNotMatch(md, /## Sentiment \(at fire\)/);
  });
});

describe('generatePostMortem', () => {
  test('clean -1R loss returns clean-SL line', () => {
    const pm = generatePostMortem({ outcome: 'loss', rMultiple: -1.0, side: 'long', bias: 'bear', session: 'ny' });
    assert.match(pm, /Clean SL hit at -1\.00R/);
    assert.doesNotMatch(pm, /Early exit/);
  });
  test('shallow loss (|r| < 0.85) flags early-exit path', () => {
    const pm = generatePostMortem({ outcome: 'loss', rMultiple: -0.20, side: 'short', bias: 'bear', session: 'asia' });
    assert.match(pm, /Early exit at -0\.20R/);
    assert.match(pm, /verify exit code/i);
  });
  test('asia + thin FVG loss surfaces both warnings', () => {
    const pm = generatePostMortem({ outcome: 'loss', rMultiple: -1.0, side: 'short', session: 'asia', fvgBodyPct: 0.0015 });
    assert.match(pm, /Asia killzone/);
    assert.match(pm, /below 0\.20%/);
  });
  test('win records R achieved + aligned confluences', () => {
    const pm = generatePostMortem({ outcome: 'win', rMultiple: 1.5, side: 'long', confluences: ['htf-agree:bull', 'tier:top2'] });
    assert.match(pm, /Hit TP at \+1\.50R/);
    assert.match(pm, /htf-agree:bull/);
  });
  test('be returns neutral note', () => {
    const pm = generatePostMortem({ outcome: 'be', rMultiple: 0, side: 'long' });
    assert.match(pm, /Closed flat/);
  });
  test('unknown outcome returns empty string', () => {
    assert.equal(generatePostMortem({ outcome: 'pending' }), '');
    assert.equal(generatePostMortem(null), '');
  });
  test('fee drag warning fires when fees > 30% of gross', () => {
    const pm = generatePostMortem({
      outcome: 'win', rMultiple: 1.5, side: 'long',
      accounting: { grossUsd: 0.10, feeUsdOpen: -0.02, feeUsdClose: -0.02 },
    });
    assert.match(pm, /Fees were 40% of gross/);
  });
  test('formatLearningMarkdown auto-derives post-mortem when none supplied', () => {
    const md = formatLearningMarkdown({
      timestamp: Date.UTC(2026, 4, 26, 1, 53),
      symbol: 'LTC', side: 'short', outcome: 'loss',
      entry: 52.23, sl: 52.33, tp: 52.07,
      realizedUsd: -0.0068, rMultiple: -0.20,
      bias: 'bear', session: 'asia', fvgBodyPct: 0.0017,
    });
    assert.match(md, /## Post-mortem/);
    assert.match(md, /Early exit at -0\.20R/);
    assert.doesNotMatch(md, /_To fill in/);
  });
  test('formatLearningMarkdown still shows placeholder when context has nothing to say', () => {
    const md = formatLearningMarkdown({ symbol: 'X', side: 'long', outcome: 'pending' });
    assert.match(md, /_To fill in/);
  });
  test('explicit postMortem takes precedence over auto-generation', () => {
    const md = formatLearningMarkdown({
      symbol: 'X', side: 'long', outcome: 'win',
      rMultiple: 1.5, postMortem: 'manual override text',
    });
    assert.match(md, /manual override text/);
    assert.doesNotMatch(md, /Hit TP at/);
  });
});
