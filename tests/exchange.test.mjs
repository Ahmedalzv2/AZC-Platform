import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('_exchangeUrl — MEXC routing per asset and tradeMode', () => {
  test('SILVER (futures) → MEXC futures with SILVER_USDT', () => {
    const { app } = loadApp();
    const a = { symbol: 'SILVER', tradeMode: 'futures' };
    const url = app._exchangeUrl(a);
    assert.match(url, /^https:\/\/futures\.mexc\.com\/exchange\/SILVER_USDT/);
    assert.match(url, /type=swap/);
  });

  test('GOLD (spot) → MEXC spot with XAUT_USDT (Tether Gold)', () => {
    const { app } = loadApp();
    const a = { symbol: 'GOLD', tradeMode: 'spot' };
    const url = app._exchangeUrl(a);
    assert.match(url, /^https:\/\/www\.mexc\.com\/exchange\/XAUT_USDT/);
  });

  test('GOLD (futures override) → MEXC futures with XAUT_USDT', () => {
    const { app } = loadApp();
    const a = { symbol: 'GOLD', tradeMode: 'futures' };
    const url = app._exchangeUrl(a);
    assert.match(url, /futures\.mexc\.com\/exchange\/XAUT_USDT/);
  });

  test('BTC (spot) → MEXC spot with BTC_USDT', () => {
    const { app } = loadApp();
    const a = { symbol: 'BTC', tradeMode: 'spot' };
    const url = app._exchangeUrl(a);
    assert.equal(url, 'https://www.mexc.com/exchange/BTC_USDT');
  });

  test('BTC (futures override) → MEXC futures with BTC_USDT', () => {
    const { app } = loadApp();
    const a = { symbol: 'BTC', tradeMode: 'futures' };
    const url = app._exchangeUrl(a);
    assert.match(url, /^https:\/\/futures\.mexc\.com\/exchange\/BTC_USDT/);
  });

  test('ETH/SOL/BNB/XRP/SUI/ASTR follow the SYMBOL_USDT pattern', () => {
    const { app } = loadApp();
    for (const sym of ['ETH', 'SOL', 'BNB', 'XRP', 'SUI', 'ASTR']) {
      const url = app._exchangeUrl({ symbol: sym, tradeMode: 'spot' });
      assert.equal(url, `https://www.mexc.com/exchange/${sym}_USDT`, `wrong url for ${sym}`);
    }
  });

  test('US100 → null (no MEXC counterpart, lives on FPMARKETS via TV)', () => {
    const { app } = loadApp();
    const url = app._exchangeUrl({ symbol: 'US100', tradeMode: 'futures' });
    assert.equal(url, null);
  });

  test('null / missing fields → null', () => {
    const { app } = loadApp();
    assert.equal(app._exchangeUrl(null), null);
    assert.equal(app._exchangeUrl({}), null);
  });

  test('default tradeMode (anything other than "spot") → futures route', () => {
    const { app } = loadApp();
    // Defensive: if tradeMode is missing/garbled, fall through to futures
    // — surfaces the problem visibly rather than silently defaulting to spot.
    const url = app._exchangeUrl({ symbol: 'BTC' });
    assert.match(url, /futures\.mexc\.com/);
  });
});

describe('openOnExchange — calls _copyLevelsToClipboard + window.open', () => {
  test('non-MEXC asset (US100) shows toast and skips window.open', () => {
    let openCalls = 0;
    const ctx = loadApp();
    ctx.sandbox.window.open = () => { openCalls++; };
    ctx.app.openOnExchange('US100');
    assert.equal(openCalls, 0, 'should not open a window for US100');
  });
});
