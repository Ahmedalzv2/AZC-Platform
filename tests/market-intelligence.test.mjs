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
