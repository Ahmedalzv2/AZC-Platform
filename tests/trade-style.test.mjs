import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

// ─────────────────────────────────────────────────────────────────────
// compareTradeStyle flow:
//   fetchMexcPositionHistory → orders (per-symbol, completed only)
//   _pairOrdersIntoTrades    → trades (open+close paired)
//   _classifyTradesAgainstJournal → { bot, manual } by orderId match
//   _summarizeTrades         → n, wins, losses, winRate, PnL stats
// ─────────────────────────────────────────────────────────────────────

describe('_pairOrdersIntoTrades', () => {
  test('pairs sequential open/close on the same symbol', () => {
    const { app } = loadApp();
    const t0 = Date.now();
    const orders = [
      // SOL: open long → close long
      { orderId: 'A1', symbol: 'SOL_USDT',    side: 1, state: 3, dealAvgPrice: 200,  dealVol: 5, createTime: t0,          profit: 0,    fee: 0.01, leverage: 200 },
      { orderId: 'A2', symbol: 'SOL_USDT',    side: 4, state: 3, dealAvgPrice: 201,  dealVol: 5, createTime: t0 + 10_000, profit: 0.05, fee: 0.01 },
      // SILVER: open short → close short
      { orderId: 'B1', symbol: 'SILVER_USDT', side: 3, state: 3, dealAvgPrice: 87.5, dealVol: 46, createTime: t0 + 1000,   profit: 0,     fee: 0.01, leverage: 200 },
      { orderId: 'B2', symbol: 'SILVER_USDT', side: 2, state: 3, dealAvgPrice: 87.3, dealVol: 46, createTime: t0 + 8000,   profit: 0.18,  fee: 0.01 },
    ];
    const trades = app._pairOrdersIntoTrades(orders);
    assert.equal(trades.length, 2, 'two paired trades');
    const sol = trades.find(t => t.symbol === 'SOL_USDT');
    assert.equal(sol.openOrderId, 'A1');
    assert.equal(sol.closeOrderId, 'A2');
    assert.equal(sol.sideOpen, 1);
    assert.equal(sol.profit, 0.05);
    const slv = trades.find(t => t.symbol === 'SILVER_USDT');
    assert.equal(slv.sideOpen, 3);
    assert.equal(slv.profit, 0.18);
  });

  test('unpaired open order (still in position) is dropped', () => {
    const { app } = loadApp();
    const t0 = Date.now();
    const orders = [
      { orderId: 'A1', symbol: 'SOL_USDT', side: 1, state: 3, createTime: t0, profit: 0 },
      // no matching close — position still open or close hasn't filled
    ];
    const trades = app._pairOrdersIntoTrades(orders);
    assert.equal(trades.length, 0);
  });

  test('orders sorted by createTime within a symbol', () => {
    const { app } = loadApp();
    // Provided out of order — must be sorted before pairing.
    const orders = [
      { orderId: 'A2', symbol: 'SOL_USDT', side: 4, state: 3, createTime: 1000, profit: 0.5 },
      { orderId: 'A1', symbol: 'SOL_USDT', side: 1, state: 3, createTime: 500,  profit: 0 },
    ];
    const trades = app._pairOrdersIntoTrades(orders);
    assert.equal(trades.length, 1);
    assert.equal(trades[0].openOrderId, 'A1');
    assert.equal(trades[0].closeOrderId, 'A2');
  });

  test('empty / null input', () => {
    const { app } = loadApp();
    assert.equal(app._pairOrdersIntoTrades([]).length, 0);
    assert.equal(app._pairOrdersIntoTrades(null).length, 0);
  });
});

describe('_classifyTradesAgainstJournal', () => {
  test('exact orderId match → bot; non-match → manual', () => {
    const { app } = loadApp();
    const trades = [
      { openOrderId: 'BOT-1', symbol: 'SOL_USDT',    profit:  0.1 },
      { openOrderId: 'BOT-2', symbol: 'SILVER_USDT', profit: -0.2 },
      { openOrderId: 'MAN-1', symbol: 'SOL_USDT',    profit:  0.3 },
    ];
    const journal = [
      { live: true, mexcResponse: { data: { orderId: 'BOT-1' } } },
      { live: true, mexcResponse: { data: { orderId: 'BOT-2' } } },
    ];
    const out = app._classifyTradesAgainstJournal(trades, journal);
    assert.equal(out.bot.length, 2);
    assert.equal(out.manual.length, 1);
    assert.equal(out.manual[0].openOrderId, 'MAN-1');
  });

  test('journal entries without live:true or orderId ignored', () => {
    const { app } = loadApp();
    const trades = [{ openOrderId: 'X', profit: 0.1 }];
    const journal = [
      { live: false, mexcResponse: { data: { orderId: 'X' } } },  // dry-run
      { live: true,  mexcResponse: null },                         // failed submit
      { live: true,  mexcResponse: { data: {} } },                 // no orderId
    ];
    const out = app._classifyTradesAgainstJournal(trades, journal);
    assert.equal(out.bot.length, 0);
    assert.equal(out.manual.length, 1);
  });

  test('empty inputs', () => {
    const { app } = loadApp();
    const out = app._classifyTradesAgainstJournal([], []);
    assert.equal(out.bot.length, 0);
    assert.equal(out.manual.length, 0);
  });
});

describe('_summarizeTrades', () => {
  test('aggregate over wins / losses / fee / PnL', () => {
    const { app } = loadApp();
    const s = app._summarizeTrades([
      { profit:  0.20, fee: 0.005 },
      { profit: -0.15, fee: 0.004 },
      { profit:  0.10, fee: 0.003 },
      { profit:  0,    fee: 0.001 },  // break-even — not win or loss
    ]);
    assert.equal(s.n, 4);
    assert.equal(s.wins, 2);
    assert.equal(s.losses, 1);
    assert.ok(Math.abs(s.winRate - 2/3) < 0.001);
    assert.ok(Math.abs(s.totalPnl - 0.15)  < 1e-9);
    assert.ok(Math.abs(s.totalFee - 0.013) < 1e-9);
    assert.ok(Math.abs(s.avgWin  - 0.15)   < 1e-9);
    assert.ok(Math.abs(s.avgLoss + 0.15)   < 1e-9);
  });

  test('empty input → zero stats', () => {
    const { app } = loadApp();
    const s = app._summarizeTrades([]);
    assert.equal(s.n, 0); assert.equal(s.wins, 0); assert.equal(s.losses, 0);
    assert.equal(s.winRate, 0); assert.equal(s.totalPnl, 0); assert.equal(s.avgPnl, 0);
  });
});

describe('fetchMexcPositionHistory — wire format', () => {
  test('hits order/list/history_orders per symbol; signs params alphabetically', async () => {
    const calls = [];
    const ctx = loadApp({
      storage: {
        ict_mexc_api_key: 'k', ict_mexc_api_secret: 's',
        ict_mexc_worker_url: 'https://my.workers.dev',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: false }),
      },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        const u = String(url);
        if (u.includes('/order/list/history_orders')) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ success: true, code: 0, data: [
              { orderId: 'O1', symbol: 'SOL_USDT', side: 1, state: 3, dealAvgPrice: 200, dealVol: 5, createTime: Date.now() - 60_000, profit: 0, fee: 0.01, leverage: 200 },
              { orderId: 'O2', symbol: 'SOL_USDT', side: 4, state: 3, dealAvgPrice: 201, dealVol: 5, createTime: Date.now() - 30_000, profit: 0.05, fee: 0.01 },
            ] }),
          };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, code: 0, data: [] }) };
      },
    });
    ctx.app.loadLiveTradingState();
    const r = await ctx.app.fetchMexcPositionHistory({ days: 1, pageSize: 100, symbols: ['SOL_USDT'] });
    assert.equal(r.ok, true);
    assert.equal(r.orders.length, 2, 'two completed orders returned');
    const hist = calls.find(c => c.url.includes('/order/list/history_orders'));
    assert.ok(hist, 'order-history endpoint must be hit');
    assert.match(hist.url, /symbol=SOL_USDT/);
    // Signature must cover the sorted paramString (page_num, page_size, start_time, symbol).
    const reqTime = hist.init.headers['Request-Time'];
    const startTimeMatch = hist.url.match(/start_time=(\d+)/);
    const startTime = startTimeMatch ? startTimeMatch[1] : '';
    const expected = await ctx.app._signMexcRequest('k', 's', reqTime, `page_num=1&page_size=100&start_time=${startTime}&symbol=SOL_USDT`);
    assert.equal(hist.init.headers['Signature'], expected, 'sig must match HMAC of sorted paramString');
  });

  test('per-symbol error is isolated; other symbols still return data', async () => {
    const calls = [];
    const ctx = loadApp({
      storage: {
        ict_mexc_api_key: 'k', ict_mexc_api_secret: 's',
        ict_mexc_worker_url: 'https://my.workers.dev',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: false }),
      },
      fetch: async (url, init) => {
        calls.push({ url: String(url) });
        const u = String(url);
        if (u.includes('symbol=XAUT_USDT')) {
          // Simulated MEXC "Contract does not exist" for GOLD.
          return { ok: true, status: 200, text: async () => JSON.stringify({ success: false, code: 1001, message: 'Contract does not exist' }) };
        }
        if (u.includes('symbol=SILVER_USDT')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, code: 0, data: [
            { orderId: 'S1', symbol: 'SILVER_USDT', side: 1, state: 3, createTime: Date.now() - 60_000, profit: 0 },
            { orderId: 'S2', symbol: 'SILVER_USDT', side: 2, state: 3, createTime: Date.now() - 30_000, profit: 0.18 },
          ] }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, code: 0, data: [] }) };
      },
    });
    ctx.app.loadLiveTradingState();
    const r = await ctx.app.fetchMexcPositionHistory({ days: 1, symbols: ['SILVER_USDT', 'XAUT_USDT'] });
    assert.equal(r.ok, true, 'overall ok — at least one symbol succeeded');
    assert.equal(r.orders.length, 2, 'SILVER orders returned even though GOLD failed');
    assert.equal(r.errors.length, 1, 'GOLD failure captured in errors[]');
    assert.equal(r.errors[0].symbol, 'XAUT_USDT');
    assert.equal(r.errors[0].response.code, 1001);
  });

  test('no keys → no-keys; no worker → no-worker', async () => {
    const { app } = loadApp();
    let r = await app.fetchMexcPositionHistory();
    assert.equal(r.error, 'no-keys');
    app.saveMexcKeys('k', 's');
    r = await app.fetchMexcPositionHistory();
    assert.equal(r.error, 'no-worker');
  });
});
