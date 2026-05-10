import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

// Build a minimal kline series. Each entry: { o, h, l, c }.
const kl = (o, h, l, c) => ({ o, h, l, c });

describe('_collectFVGs', () => {
  test('collects bull FVG from a clean 3-candle gap (a.h < c.l)', () => {
    const { app } = loadApp();
    // Candle 0: small range topping at 100. Candle 1: gap up. Candle 2:
    // bottoming at 105 (above candle 0 high) → bull FVG between 100 and 105.
    const k = [
      kl(98, 100, 97, 99),   // 0: a (high = 100)
      kl(102, 108, 101, 107),// 1: displacement
      kl(106, 110, 105, 109),// 2: c (low = 105) — gap exists
      kl(108, 112, 107, 111),
      kl(110, 113, 109, 112),
    ];
    const fvgs = app._collectFVGs(k);
    assert.equal(fvgs.length, 1);
    assert.equal(fvgs[0].dir, 'bull');
    assert.equal(fvgs[0].lo,  100);
    assert.equal(fvgs[0].hi,  105);
    assert.equal(fvgs[0].mid, 102.5);
  });

  test('collects bear FVG from a clean gap-down (a.l > c.h)', () => {
    const { app } = loadApp();
    const k = [
      kl(110, 112, 108, 109),// 0: a (low = 108)
      kl(106, 107, 100, 101),// 1: displacement down
      kl(102, 103, 95, 96),  // 2: c (high = 103) — bear FVG between 103 and 108
      kl(98, 99, 93, 94),
      kl(95, 96, 90, 91),
    ];
    const fvgs = app._collectFVGs(k);
    // The cascading drop produces multiple bear FVGs (idx 0/2, 1/3, ...).
    // We only assert the FIRST is the expected zone — the count varies with
    // how the drop unfolds candle-to-candle.
    assert.ok(fvgs.length >= 1);
    assert.equal(fvgs[0].dir, 'bear');
    assert.equal(fvgs[0].lo,  103);
    assert.equal(fvgs[0].hi,  108);
  });

  test('returns multiple FVGs in chronological order', () => {
    const { app } = loadApp();
    const k = [
      kl(98, 100, 97, 99),    // 0
      kl(102, 108, 101, 107), // 1
      kl(106, 110, 105, 109), // 2: bull FVG #1 (100→105) at idx 2
      kl(115, 116, 114, 115), // 3: gap up (no FVG by 3-candle rule unless next pair forms)
      kl(120, 125, 119, 124), // 4: candle, prev a is idx 2 (high 110), c is idx 4 (low 119) → bull FVG #2 110→119 at idx 4
      kl(122, 130, 121, 129),
    ];
    const fvgs = app._collectFVGs(k);
    assert.ok(fvgs.length >= 2, `expected ≥ 2 FVGs, got ${fvgs.length}`);
    assert.ok(fvgs[fvgs.length-1].idx > fvgs[0].idx, 'chronological order');
  });
});

describe('_detectInversionFVG', () => {
  test('bull FVG that gets violated (close below lo) inverts to bearish', () => {
    const { app } = loadApp();
    // Bull FVG 100→105 forms at idx 2, then idx 4 closes at 95 (below 100) →
    // inverted. dir flips to 'bear'.
    const k = [
      kl(98, 100, 97, 99),    // 0
      kl(102, 108, 101, 107), // 1
      kl(106, 110, 105, 109), // 2: FVG completion
      kl(102, 103, 96, 98),   // 3
      kl(96, 97, 90, 95),     // 4: close 95 < 100 → violated
    ];
    const fvgs = app._collectFVGs(k);
    const iFVG = app._detectInversionFVG(k, fvgs);
    assert.ok(iFVG, 'inversion detected');
    assert.equal(iFVG.dir, 'bear', 'flipped polarity');
    assert.equal(iFVG.originalDir, 'bull');
    assert.equal(iFVG.lo, 100);
    assert.equal(iFVG.hi, 105);
  });

  test('bear FVG that gets violated (close above hi) inverts to bullish', () => {
    const { app } = loadApp();
    const k = [
      kl(110, 112, 108, 109), // 0
      kl(106, 107, 100, 101), // 1
      kl(102, 103, 95, 96),   // 2: bear FVG 103→108 at idx 2
      kl(105, 110, 104, 109), // 3
      kl(110, 115, 109, 114), // 4: close 114 > 108 → violated, flips to bull
    ];
    const fvgs = app._collectFVGs(k);
    const iFVG = app._detectInversionFVG(k, fvgs);
    assert.ok(iFVG);
    assert.equal(iFVG.dir, 'bull');
    assert.equal(iFVG.originalDir, 'bear');
  });

  test('FVG that has been retested AFTER inversion is NOT returned (stale)', () => {
    const { app } = loadApp();
    // Bull FVG forms, gets violated, then a later candle wicks back into the
    // zone — the iFVG already fired, no fresh signal.
    const k = [
      kl(98, 100, 97, 99),    // 0
      kl(102, 108, 101, 107), // 1
      kl(106, 110, 105, 109), // 2: FVG 100→105 at idx 2
      kl(96, 97, 90, 95),     // 3: violated (close 95 < 100)
      kl(98, 102, 96, 101),   // 4: retest — wick into [100, 105]
      kl(99, 100, 94, 95),    // 5
    ];
    const fvgs = app._collectFVGs(k);
    const iFVG = app._detectInversionFVG(k, fvgs);
    assert.equal(iFVG, null, 'retested iFVG is stale, should not return');
  });

  test('FVG never violated returns null', () => {
    const { app } = loadApp();
    const k = [
      kl(98, 100, 97, 99),
      kl(102, 108, 101, 107),
      kl(106, 110, 105, 109),
      kl(108, 112, 107, 111),
      kl(110, 113, 109, 112),
    ];
    const fvgs = app._collectFVGs(k);
    const iFVG = app._detectInversionFVG(k, fvgs);
    assert.equal(iFVG, null);
  });
});

describe('_detectBPR', () => {
  test('overlapping bull + bear FVG = BPR with overlap as the zone', () => {
    const { app } = loadApp();
    // Construct two FVGs that overlap. Manually feed the list to skip kline
    // construction (the function only consumes the FVG array).
    const fvgs = [
      { dir: 'bull', lo: 100, hi: 110, mid: 105, idx: 5  },
      { dir: 'bear', lo: 105, hi: 115, mid: 110, idx: 12 }, // overlap [105, 110]
    ];
    const bpr = app._detectBPR(fvgs);
    assert.ok(bpr);
    assert.equal(bpr.lo,  105);
    assert.equal(bpr.hi,  110);
    assert.equal(bpr.mid, 107.5);
    assert.equal(bpr.dir, 'bear', 'most-recent FVG sets the dir');
  });

  test('non-overlapping bull + bear pair → null', () => {
    const { app } = loadApp();
    const fvgs = [
      { dir: 'bull', lo: 100, hi: 105, mid: 102.5, idx: 5  },
      { dir: 'bear', lo: 110, hi: 115, mid: 112.5, idx: 12 },
    ];
    assert.equal(app._detectBPR(fvgs), null);
  });

  test('two same-direction FVGs (no opposing pair) → null', () => {
    const { app } = loadApp();
    const fvgs = [
      { dir: 'bull', lo: 100, hi: 110, mid: 105, idx: 5  },
      { dir: 'bull', lo: 105, hi: 115, mid: 110, idx: 12 },
    ];
    assert.equal(app._detectBPR(fvgs), null);
  });

  test('most recent overlap wins when multiple opposing pairs exist', () => {
    const { app } = loadApp();
    const fvgs = [
      { dir: 'bull', lo: 100, hi: 110, mid: 105, idx: 5  },
      { dir: 'bear', lo: 108, hi: 112, mid: 110, idx: 8  }, // overlap [108, 110]
      { dir: 'bull', lo: 200, hi: 210, mid: 205, idx: 20 }, // far away
      { dir: 'bear', lo: 205, hi: 215, mid: 210, idx: 25 }, // overlap [205, 210], more recent
    ];
    const bpr = app._detectBPR(fvgs);
    assert.equal(bpr.lo, 205, 'picks the more recent overlap');
    assert.equal(bpr.hi, 210);
  });
});

describe('_analyzeKlines surfaces iFVG and BPR fields', () => {
  test('analysis output includes iFVG / iFVGZone / bpr / bprZone keys', () => {
    const { app } = loadApp();
    // Make the simplest kline series long enough (≥22 candles) so
    // _analyzeKlines does not bail early.
    const k = [];
    for (let i = 0; i < 25; i++) {
      k.push(kl(100 + i, 102 + i, 99 + i, 101 + i));
    }
    const out = app._analyzeKlines(k);
    assert.ok(!out.error, 'no error for sufficient kline length');
    // The keys are always present (boolean false / null), not silently dropped.
    assert.equal(typeof out.iFVG, 'boolean');
    assert.equal(typeof out.bpr,  'boolean');
    assert.equal('iFVGZone' in out, true);
    assert.equal('bprZone'  in out, true);
  });

  test('score still capped at 4 (entryReady gate stays backwards-compatible)', () => {
    const { app } = loadApp();
    const k = [];
    for (let i = 0; i < 25; i++) k.push(kl(100, 102, 99, 101));
    const out = app._analyzeKlines(k);
    assert.ok(out.score <= 4, `score must stay /4 for the existing gate, got ${out.score}`);
  });
});

describe('_suggestedEntryForTf preference ladder (BPR > iFVG > OB > FVG)', () => {
  // Build a minimal analysis object that mimics _analyzeKlines output for
  // _suggestedEntryForTf — we're testing the conviction ladder, not the
  // detection itself.
  const baseFvg = { dir: 'bull', lo: 100, hi: 110, mid: 105 };

  test('prefers BPR when present and dir-aligned (tightest SL)', () => {
    const { app } = loadApp();
    const analysis = {
      dir: 'bull',
      fvgZone: baseFvg,
      obZone:  { dir: 'bull', lo: 102, hi: 108, mid: 105 },
      iFVGZone:{ dir: 'bull', lo: 95,  hi: 105, mid: 100, originalDir: 'bear' },
      bprZone: { dir: 'bull', lo: 103, hi: 107, mid: 105 },
    };
    const sug = app._suggestedEntryForTf(analysis, '1h');
    assert.equal(sug.source, 'bpr');
    // SL just past the far edge of the BPR overlap (lo - 10% of body)
    const bprBody = 107 - 103;
    const expectedSL = 103 - bprBody * 0.10;
    assert.ok(Math.abs(sug.sl - expectedSL) < 0.01, `SL near ${expectedSL}, got ${sug.sl}`);
  });

  test('falls back to iFVG when no BPR but iFVG matches dir', () => {
    const { app } = loadApp();
    const analysis = {
      dir: 'bull',
      fvgZone: baseFvg,
      obZone:  { dir: 'bull', lo: 102, hi: 108, mid: 105 },
      iFVGZone:{ dir: 'bull', lo: 95,  hi: 105, mid: 100, originalDir: 'bear' },
      bprZone: null,
    };
    const sug = app._suggestedEntryForTf(analysis, '1h');
    assert.equal(sug.source, 'ifvg');
    assert.equal(sug.entry, 100);
  });

  test('falls back to OB+FVG when neither BPR nor iFVG matches dir', () => {
    const { app } = loadApp();
    const analysis = {
      dir: 'bull',
      fvgZone: baseFvg,
      obZone:  { dir: 'bull', lo: 102, hi: 108, mid: 105 },
      iFVGZone:{ dir: 'bear', lo: 95,  hi: 105, mid: 100, originalDir: 'bull' }, // wrong dir
      bprZone: { dir: 'bear', lo: 103, hi: 107, mid: 105 },                       // wrong dir
    };
    const sug = app._suggestedEntryForTf(analysis, '1h');
    assert.equal(sug.source, 'ob+fvg');
  });

  test('falls back to bare FVG when nothing else aligns', () => {
    const { app } = loadApp();
    const analysis = {
      dir: 'bull',
      fvgZone: baseFvg,
      obZone:  null,
      iFVGZone:null,
      bprZone: null,
    };
    const sug = app._suggestedEntryForTf(analysis, '1h');
    assert.equal(sug.source, 'fvg-edge');
    assert.equal(sug.entry, 105);
  });
});
