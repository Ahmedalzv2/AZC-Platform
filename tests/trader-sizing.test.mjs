import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sizeTradeByRiskAndMargin } from '../trader-sizing.mjs';

describe('sizeTradeByRiskAndMargin', () => {
  test('blocks when free margin cannot fund the minimum tradable size', () => {
    const r = sizeTradeByRiskAndMargin({
      balance: 0.45105763872,
      riskPct: 0.05,
      leverage: 10,
      entry: 83.28,
      stopDistUsdPerContract: 0.17,
      contractSize: 0.1,
      minVol: 1,
    });
    assert.equal(r.qty, 0);
    assert.equal(r.reason, 'margin-too-low');
    assert.equal(r.maxQtyByMargin, 0);
  });

  test('caps qty by margin using the resting entry price, not a stale cheaper ticker', () => {
    const conservative = sizeTradeByRiskAndMargin({
      balance: 12,
      riskPct: 0.05,
      leverage: 10,
      entry: 100,
      stopDistUsdPerContract: 0.01,
      contractSize: 0.1,
      minVol: 1,
    });
    const optimistic = sizeTradeByRiskAndMargin({
      balance: 12,
      riskPct: 0.05,
      leverage: 10,
      entry: 80,
      stopDistUsdPerContract: 0.01,
      contractSize: 0.1,
      minVol: 1,
    });
    assert.equal(conservative.qty, 6);
    assert.equal(optimistic.qty, 7);
  });

  test('keeps the prior happy path when both risk and margin caps are valid', () => {
    const r = sizeTradeByRiskAndMargin({
      balance: 50,
      riskPct: 0.03,
      leverage: 10,
      entry: 1.3256,
      stopDistUsdPerContract: 0.026,
      contractSize: 1,
      minVol: 1,
    });
    assert.equal(r.reason, null);
    assert.equal(r.qty, 57);
    assert.ok(r.notional > 0);
  });
});