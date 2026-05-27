import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('getMarketIntelligence', () => {
  test('macro blackout forces STAND DOWN', () => {
    const { app } = loadApp();
    const read = app.getMarketIntelligence({
      macroBlackout: { event: 'US CPI', mins: 12, impact: 'high' },
      session: { name: 'NY AM', type: 'kz' },
      assets: [],
    });
    assert.equal(read.verdict, 'STAND DOWN');
    assert.match(read.action, /No new trades/i);
    assert.ok(read.reasons.some(r => /US CPI/.test(r)));
  });

  test('broad crypto weakness plus defensive metals returns RISK OFF', () => {
    const { app } = loadApp();
    const read = app.getMarketIntelligence({
      session: { name: 'London Kill Zone', type: 'kz' },
      assets: [
        { symbol: 'BTC', change24h: -2.1 },
        { symbol: 'ETH', change24h: -1.8 },
        { symbol: 'SOL', change24h: -4.0 },
        { symbol: 'GOLD', change24h: 0.9 },
        { symbol: 'SILVER', change24h: 1.1 },
      ],
      newsItems: [{ title: 'SEC lawsuit hits major crypto exchange', published: Math.floor(Date.now() / 1000) }],
      fundingRates: { BTC: 0.071 },
    });
    assert.equal(read.verdict, 'RISK OFF');
    assert.match(read.action, /manual only|stand down/i);
    assert.ok(read.riskScore < 0);
  });

  test('positive crypto breadth in valid session returns RISK ON', () => {
    const { app } = loadApp();
    const read = app.getMarketIntelligence({
      session: { name: 'NY AM', type: 'kz' },
      assets: [
        { symbol: 'BTC', change24h: 1.4 },
        { symbol: 'ETH', change24h: 1.1 },
        { symbol: 'SOL', change24h: 2.3 },
        { symbol: 'BNB', change24h: 0.8 },
      ],
      newsItems: [{ title: 'Bitcoin ETF inflows rise as liquidity improves', published: Math.floor(Date.now() / 1000) }],
      fundingRates: { BTC: 0.012, ETH: 0.009 },
    });
    assert.equal(read.verdict, 'RISK ON');
    assert.match(read.action, /Manual longs|watch/i);
    assert.ok(read.riskScore > 0);
  });

  test('dead zone overrides otherwise bullish context', () => {
    const { app } = loadApp();
    const read = app.getMarketIntelligence({
      session: { name: 'Dead Zone', type: 'dead' },
      assets: [
        { symbol: 'BTC', change24h: 2.2 },
        { symbol: 'ETH', change24h: 1.9 },
      ],
    });
    assert.equal(read.verdict, 'STAND DOWN');
    assert.match(read.action, /Dead Zone/i);
  });
});

describe('AZC Intel Scouts', () => {
  test('keeps SEC and 13F scouts dormant until source-backed collectors exist', () => {
    const { app } = loadApp();
    const read = app._buildIntelScouts({
      market: { verdict: 'MIXED', action: 'Manual watch', reasons: [], cryptoAvg: 0, hotFunding: 0 },
      assets: [],
      fundingRates: {},
      macroBlackout: null,
    });
    const eddie = read.scouts.find(s => s.name === 'Eddie');
    const maggie = read.scouts.find(s => s.name === 'Maggie');
    assert.equal(eddie.state, 'dormant');
    assert.equal(maggie.state, 'dormant');
    assert.equal(read.consensus.status, 'NO CONSENSUS');
  });

  test('fires Sophie consensus only when three active scouts align on same asset and direction', () => {
    const { app } = loadApp();
    const read = app._buildIntelScouts({
      market: { verdict: 'RISK ON', action: 'Manual longs can be watched', reasons: ['NY AM active'], cryptoAvg: 1.2, hotFunding: 0 },
      assets: [
        { symbol: 'US100', bias: 'Bullish', checks: [1,1,1], mtf: { h1: 'bull', h4: 'bull', d1: 'bull' } },
        { symbol: 'BTC', bias: 'Bullish', checks: [1,1,1,1,1,1,1,1,1,1] },
      ],
      fundingRates: { CRYPTO: -0.07 },
      macroBlackout: null,
    });
    assert.equal(read.consensus.status, 'CONSENSUS');
    assert.equal(read.consensus.asset, 'CRYPTO');
    assert.equal(read.consensus.direction, 'BULLISH');
    // Individual asserts instead of deepEqual — loadApp's vm context
    // has its own Array prototype, so deepStrictEqual fails on
    // structurally-equal cross-realm arrays.
    const got = [...read.consensus.scouts].sort();
    assert.equal(got.length, 3);
    assert.equal(got[0], 'Frank');
    assert.equal(got[1], 'Maya');
    assert.equal(got[2], 'Nora');
  });

  test('macro blackout forces Frank bearish but does not create fake consensus alone', () => {
    const { app } = loadApp();
    const read = app._buildIntelScouts({
      market: { verdict: 'STAND DOWN', action: 'No new trades', reasons: ['US CPI'], cryptoAvg: 0, hotFunding: 0 },
      assets: [{ symbol: 'US100', bias: 'Neutral', checks: [] }],
      fundingRates: {},
      macroBlackout: { event: 'US CPI', mins: 12, impact: 'high' },
    });
    const frank = read.scouts.find(s => s.name === 'Frank');
    assert.equal(frank.direction, 'BEARISH');
    assert.equal(read.consensus.status, 'NO CONSENSUS');
  });
});
