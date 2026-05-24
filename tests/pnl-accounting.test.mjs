import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEXC_FEE_DEFAULTS,
  mexcFeeConfig,
  fundingWindowsCrossed,
  computeRealizedNet,
} from '../pnl-accounting.mjs';

const H = 60 * 60 * 1000;

describe('MEXC_FEE_DEFAULTS', () => {
  test('zero-fee promo defaults', () => {
    assert.equal(MEXC_FEE_DEFAULTS.taker, 0);
    assert.equal(MEXC_FEE_DEFAULTS.maker, 0);
    assert.equal(MEXC_FEE_DEFAULTS.fundingPct8h, 0.0001);
  });
});

describe('mexcFeeConfig', () => {
  test('null/empty/invalid → defaults', () => {
    assert.deepEqual(mexcFeeConfig(null), MEXC_FEE_DEFAULTS);
    assert.deepEqual(mexcFeeConfig(''),   MEXC_FEE_DEFAULTS);
    assert.deepEqual(mexcFeeConfig('not-json'), MEXC_FEE_DEFAULTS);
  });
  test('override merges over defaults', () => {
    const cfg = mexcFeeConfig(JSON.stringify({ taker: 0.0002 }));
    assert.equal(cfg.taker, 0.0002);
    assert.equal(cfg.maker, 0);             // default kept
    assert.equal(cfg.fundingPct8h, 0.0001); // default kept
  });
});

describe('fundingWindowsCrossed (00/08/16 UTC boundaries)', () => {
  test('within a single window → 0', () => {
    const start = Date.UTC(2026, 4, 24, 9, 0);
    const end   = Date.UTC(2026, 4, 24, 15, 30);
    assert.equal(fundingWindowsCrossed(start, end), 0);
  });
  test('open 07:55 close 08:05 → 1 window (crosses 08:00)', () => {
    const start = Date.UTC(2026, 4, 24, 7, 55);
    const end   = Date.UTC(2026, 4, 24, 8, 5);
    assert.equal(fundingWindowsCrossed(start, end), 1);
  });
  test('open 08:05 close 08:15 → 0 windows', () => {
    const start = Date.UTC(2026, 4, 24, 8, 5);
    const end   = Date.UTC(2026, 4, 24, 8, 15);
    assert.equal(fundingWindowsCrossed(start, end), 0);
  });
  test('24h hold → 3 windows', () => {
    const start = Date.UTC(2026, 4, 24, 7, 55);
    const end   = start + 24 * H;
    assert.equal(fundingWindowsCrossed(start, end), 3);
  });
  test('closeTs < openTs → 0 (clamped)', () => {
    assert.equal(fundingWindowsCrossed(1000, 500), 0);
  });
});

describe('computeRealizedNet', () => {
  test('long winner, zero fees + zero funding (default promo) → net = gross', () => {
    const r = computeRealizedNet({
      side: 'long', entry: 100, exit: 110, qty: 2,
      openTs: 1, closeTs: 2,
      feePctOpen: 0, feePctClose: 0, fundingPct8h: 0,
    });
    assert.equal(r.grossUsd, 20);
    assert.equal(r.netUsd, 20);
    assert.equal(r.fundingUsd, 0);
  });
  test('short winner: gross is positive when exit < entry', () => {
    const r = computeRealizedNet({
      side: 'short', entry: 100, exit: 90, qty: 2,
      openTs: 1, closeTs: 2,
      feePctOpen: 0, feePctClose: 0, fundingPct8h: 0,
    });
    assert.equal(r.grossUsd, 20);
    assert.equal(r.netUsd, 20);
  });
  test('taker fees on both legs subtract from gross', () => {
    // 0.02% taker each side: opens at $100 × 1 = $0.02; closes at $110 × 1 = $0.022
    // gross = 10; net = 10 - 0.02 - 0.022 = 9.958
    const r = computeRealizedNet({
      side: 'long', entry: 100, exit: 110, qty: 1,
      openTs: 1, closeTs: 2,
      feePctOpen: 0.0002, feePctClose: 0.0002, fundingPct8h: 0,
    });
    assert.equal(r.grossUsd, 10);
    assert.ok(Math.abs(r.feeUsdOpen  - 0.02 ) < 1e-9);
    assert.ok(Math.abs(r.feeUsdClose - 0.022) < 1e-9);
    assert.ok(Math.abs(r.netUsd - 9.958) < 1e-9);
  });
  test('maker rebate (negative fee) increases net', () => {
    // -0.005% maker on open: -$0.005 cost = +$0.005 rebate; netUsd = gross - openFee = 10 - (-0.005) = 10.005
    const r = computeRealizedNet({
      side: 'long', entry: 100, exit: 110, qty: 1,
      openTs: 1, closeTs: 2,
      feePctOpen: -0.00005, feePctClose: 0, fundingPct8h: 0,
    });
    assert.ok(Math.abs(r.netUsd - 10.005) < 1e-9);
  });
  test('funding charged per crossed window: 2 windows × notional × rate', () => {
    // notionalOpen = 100. fundingPct8h = 0.0001 → per window = 0.01
    // 16h hold crossing 2 windows → fundingUsd = 0.02; net = gross - 0.02
    const start = Date.UTC(2026, 4, 24, 7, 55);
    const end   = start + 16 * H + 30 * 60 * 1000; // 16h30 → crosses 08:00 + 16:00 + 00:00 = 3
    const r = computeRealizedNet({
      side: 'long', entry: 100, exit: 110, qty: 1,
      openTs: start, closeTs: end,
      feePctOpen: 0, feePctClose: 0, fundingPct8h: 0.0001,
    });
    assert.equal(r.windowsCrossed, 3);
    assert.ok(Math.abs(r.fundingUsd - 0.03) < 1e-9);
    assert.ok(Math.abs(r.netUsd - (10 - 0.03)) < 1e-9);
  });
  test('losing trade: net is more negative once fees subtracted', () => {
    const r = computeRealizedNet({
      side: 'long', entry: 100, exit: 90, qty: 1,
      openTs: 1, closeTs: 2,
      feePctOpen: 0.0002, feePctClose: 0.0002, fundingPct8h: 0,
    });
    assert.equal(r.grossUsd, -10);
    assert.ok(r.netUsd < r.grossUsd, 'fees make a losing trade lose more');
  });
  test('invalid inputs → zero everything (defensive)', () => {
    const r = computeRealizedNet({ side: 'long', entry: NaN, exit: 110, qty: 1, openTs:1, closeTs:2 });
    assert.equal(r.netUsd, 0);
  });
});
