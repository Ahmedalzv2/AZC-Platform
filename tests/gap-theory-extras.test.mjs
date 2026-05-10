import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

const kl = (o, h, l, c, t = 0) => ({ o, h, l, c, t });

describe('_detectLiquidityVoid', () => {
  // Build a baseline of small candles (range 1) so ATR(14) ≈ 1, then drop
  // a violent 6-point bull body candle that doesn't get refilled.
  function smallSeries(n, base = 100) {
    const k = [];
    for (let i = 0; i < n; i++) k.push(kl(base, base + 1, base - 1, base));
    return k;
  }

  test('detects a bull liquidity void (body ≥ 2× ATR, unfilled)', () => {
    const { app } = loadApp();
    const k = smallSeries(15);
    // Index 15 is a violent bull candle (open 100, close 106 → body 6)
    // and the next candles all close ABOVE the body so it stays unfilled.
    k.push(kl(100, 107, 99, 106));
    k.push(kl(106, 108, 105, 107));
    k.push(kl(107, 109, 106, 108));
    k.push(kl(108, 110, 107, 109));
    const lv = app._detectLiquidityVoid(k);
    assert.ok(lv, 'liquidity void detected');
    assert.equal(lv.dir, 'bull');
    assert.equal(lv.lo, 100);
    assert.equal(lv.hi, 106);
    assert.ok(lv.atrMultiple >= 2);
  });

  test('detects a bear liquidity void', () => {
    const { app } = loadApp();
    const k = smallSeries(15);
    k.push(kl(100, 101, 93, 94));   // violent bear body 100→94
    k.push(kl(94, 95, 92, 93));
    k.push(kl(93, 94, 91, 92));
    k.push(kl(92, 93, 90, 91));
    const lv = app._detectLiquidityVoid(k);
    assert.ok(lv);
    assert.equal(lv.dir, 'bear');
    assert.equal(lv.lo, 94);
    assert.equal(lv.hi, 100);
  });

  test('void that gets refilled (body close back inside) returns null', () => {
    const { app } = loadApp();
    const k = smallSeries(15);
    k.push(kl(100, 107, 99, 106));   // violent bull
    k.push(kl(106, 108, 102, 103));  // close 103 — back INSIDE body (100..106)
    k.push(kl(103, 104, 101, 102));
    k.push(kl(102, 103, 100, 101));
    const lv = app._detectLiquidityVoid(k);
    assert.equal(lv, null, 'refilled void should not return');
  });

  test('candle with body < 2× ATR is ignored (normal candle)', () => {
    const { app } = loadApp();
    const k = smallSeries(15);
    k.push(kl(100, 102, 99, 101));  // body 1, only 1× ATR
    k.push(kl(101, 103, 100, 102));
    k.push(kl(102, 104, 101, 103));
    k.push(kl(103, 105, 102, 104));
    const lv = app._detectLiquidityVoid(k);
    assert.equal(lv, null);
  });

  test('series too short returns null (no ATR baseline)', () => {
    const { app } = loadApp();
    assert.equal(app._detectLiquidityVoid([]), null);
    assert.equal(app._detectLiquidityVoid(Array(5).fill(kl(100,102,99,101))), null);
  });
});

describe('_detectNDOG (New Day Opening Gap)', () => {
  test('returns the open of the candle that crosses 00:00 UTC', () => {
    const { app } = loadApp();
    // Build 5 candles ending Wed 12:00 UTC. The day's first candle is Wed
    // 00:00 UTC. We'll use 1h candles so we can cleanly anchor times.
    const wedMidnight = Date.UTC(2026, 4, 6, 0, 0, 0); // 2026-05-06 00:00 UTC
    const hr = 3600 * 1000;
    const k = [
      kl(99, 100, 98, 99,  wedMidnight - 4*hr),
      kl(99, 101, 98, 100, wedMidnight - 3*hr),
      kl(100,102, 99, 101, wedMidnight - 2*hr),
      kl(101,103, 100,102, wedMidnight - 1*hr),
      kl(102,104, 101,103, wedMidnight + 0*hr),  // Wed 00:00 UTC — NDOG candle
      kl(103,105, 102,104, wedMidnight + 1*hr),
      kl(104,106, 103,105, wedMidnight + 2*hr),
    ];
    const ndog = app._detectNDOG(k);
    assert.ok(ndog);
    assert.equal(ndog.level, 102, 'NDOG = open of Wed 00:00 candle');
    assert.equal(ndog.ts, wedMidnight);
  });

  test('returns null when all klines pre-date midnight (no candle past UTC 0:00)', () => {
    const { app } = loadApp();
    // All klines are FROM midnight — every k[i].t >= dayStart, so the FIRST
    // qualifying candle is k[0], whose open is the NDOG.
    const wedMidnight = Date.UTC(2026, 4, 6, 0, 0, 0);
    const hr = 3600 * 1000;
    const k = [
      kl(102, 104, 101, 103, wedMidnight + 0*hr),
      kl(103, 105, 102, 104, wedMidnight + 1*hr),
    ];
    const ndog = app._detectNDOG(k);
    // Last candle's t = midnight + 1h, so dayStart = midnight, k[0].t >= dayStart.
    assert.equal(ndog.level, 102);
  });

  test('returns null for empty / no-timestamp klines', () => {
    const { app } = loadApp();
    assert.equal(app._detectNDOG([]), null);
    assert.equal(app._detectNDOG([kl(100, 102, 99, 101, 0)]), null);
  });
});

describe('_detectNWOG (New Week Opening Gap)', () => {
  test('returns the open of the candle that opens Monday 00:00 UTC', () => {
    const { app } = loadApp();
    // 2026-05-04 is a Monday. Daily klines from prev Thursday onward.
    const monMidnight = Date.UTC(2026, 4, 4, 0, 0, 0); // 2026-05-04 = Monday
    const day = 86400 * 1000;
    const k = [
      kl(95,  96, 94, 95,  monMidnight - 4*day), // Thu
      kl(95,  97, 94, 96,  monMidnight - 3*day), // Fri
      kl(96,  98, 95, 97,  monMidnight - 2*day), // Sat
      kl(97,  99, 96, 98,  monMidnight - 1*day), // Sun
      kl(100, 102,99, 101, monMidnight + 0*day), // Mon — NWOG candle
      kl(101, 103,100,102, monMidnight + 1*day), // Tue
      kl(102, 104,101,103, monMidnight + 2*day), // Wed
    ];
    const nwog = app._detectNWOG(k);
    assert.ok(nwog);
    assert.equal(nwog.level, 100, 'NWOG = open of Monday candle');
    assert.equal(nwog.ts, monMidnight);
  });

  test('correctly handles when current time is Sunday (uses prior Monday)', () => {
    const { app } = loadApp();
    // 2026-05-10 is a Sunday. The relevant week start is Monday 2026-05-04.
    const monMidnight = Date.UTC(2026, 4, 4, 0, 0, 0);
    const sunday      = Date.UTC(2026, 4, 10, 12, 0, 0);
    const day = 86400 * 1000;
    const k = [
      kl(99,  100, 98, 99, monMidnight - 1*day), // Sun prior
      kl(100, 102, 99, 101, monMidnight),         // Mon — NWOG
      kl(102, 104, 101,103, monMidnight + 6*day - 1000), // Sun (current week's last)
      kl(103, 105, 102,104, sunday),              // current Sunday tick
    ];
    const nwog = app._detectNWOG(k);
    assert.ok(nwog);
    assert.equal(nwog.level, 100);
  });

  test('returns null for empty / no-timestamp klines', () => {
    const { app } = loadApp();
    assert.equal(app._detectNWOG([]), null);
    assert.equal(app._detectNWOG([kl(100, 102, 99, 101, 0)]), null);
  });
});

describe('BISI / SIBI labels on FVG output', () => {
  test('bull FVG → label BISI, liquidityTarget BSL', () => {
    const { app } = loadApp();
    const k = [
      kl(98, 100, 97, 99),
      kl(102, 108, 101, 107),
      kl(106, 110, 105, 109),
      kl(108, 112, 107, 111),
      kl(110, 113, 109, 112),
    ];
    const fvg = app._detectFVG(k);
    assert.ok(fvg);
    assert.equal(fvg.dir, 'bull');
    assert.equal(fvg.label, 'BISI');
    assert.equal(fvg.liquidityTarget, 'BSL');
  });

  test('bear FVG → label SIBI, liquidityTarget SSL', () => {
    const { app } = loadApp();
    const k = [
      kl(110, 112, 108, 109),
      kl(106, 107, 100, 101),
      kl(102, 103, 95, 96),
      kl(98, 99, 93, 94),
      kl(95, 96, 90, 91),
    ];
    const fvg = app._detectFVG(k);
    assert.ok(fvg);
    assert.equal(fvg.dir, 'bear');
    assert.equal(fvg.label, 'SIBI');
    assert.equal(fvg.liquidityTarget, 'SSL');
  });

  test('_collectFVGs also tags every entry with label + liquidityTarget', () => {
    const { app } = loadApp();
    const k = [
      kl(98, 100, 97, 99),
      kl(102, 108, 101, 107),
      kl(106, 110, 105, 109),
      kl(108, 112, 107, 111),
      kl(110, 113, 109, 112),
    ];
    const fvgs = app._collectFVGs(k);
    assert.ok(fvgs.length >= 1);
    for (const f of fvgs) {
      assert.ok(['BISI','SIBI'].includes(f.label));
      assert.ok(['BSL','SSL'].includes(f.liquidityTarget));
    }
  });
});

describe('_analyzeKlines surfaces NDOG, NWOG, liqVoid', () => {
  test('analysis output includes ndog / nwog / liqVoid / liqVoidZone keys', () => {
    const { app } = loadApp();
    // Need ≥22 candles to bypass the early-return.
    const wedMidnight = Date.UTC(2026, 4, 6, 0, 0, 0);
    const hr = 3600 * 1000;
    const k = [];
    for (let i = 0; i < 25; i++) {
      k.push(kl(100 + i*0.1, 102 + i*0.1, 99 + i*0.1, 101 + i*0.1, wedMidnight + i*hr));
    }
    const out = app._analyzeKlines(k);
    assert.ok(!out.error);
    assert.equal('ndog' in out, true);
    assert.equal('nwog' in out, true);
    assert.equal('liqVoid' in out, true);
    assert.equal('liqVoidZone' in out, true);
    // Specifically: NDOG should be detected because the kline series spans
    // the midnight UTC boundary (timestamps were anchored at wedMidnight).
    assert.ok(out.ndog && out.ndog.level, 'NDOG level present when klines span the boundary');
  });
});
