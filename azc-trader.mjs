// AZC autonomous trader — server-side execution for the $50 micro-capital lane.
//
// Honours the user's existing safety envelope:
//   $50 balance · 0.5% risk/trade · $1 daily loss cap · 1 position max
//   3 trades/day max · 15-min per-symbol cooldown · futures-only · isolated 10×
//
// Strategy: 5m FVG retest. Detect the last unmitigated 5m fair-value gap.
// When price retraces into the gap mid, fire in the gap's direction with
// SL beyond the far edge + 10% buffer and TP at 1.5R. POST_ONLY maker so
// the entry is selective — stale-signal late fills get cancelled after 180s.
//
// State file at /run/azc-trader.json. Resolved trades land in
// trade-learnings/{wins,losses,be}/. Service runs under systemd; stop with
//   systemctl stop azc-trader

import { setTimeout as sleep } from 'node:timers/promises';
import { writeFile, mkdir, access } from 'node:fs/promises';
import { constants as fsConst } from 'node:fs';
import path from 'node:path';
import { callMexcSigned } from './mexc-signer.mjs';
import { writeLearningFile } from './trade-learnings.mjs';

// ──────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────
const API_KEY = process.env.MEXC_API_KEY;
const API_SECRET = process.env.MEXC_API_SECRET;
if (!API_KEY || !API_SECRET) {
  console.error('FATAL: MEXC_API_KEY / MEXC_API_SECRET not set'); process.exit(2);
}

const SYMBOLS = ['BTC_USDT'];        // start with one liquid pair
const TF_MIN = 5;                     // 5-minute timeframe
const LOOKBACK_BARS = 40;             // ~3.3 hours of context
const LEVERAGE = 10;
const RISK_PCT = 0.005;               // 0.5% of equity per trade
const DAILY_LOSS_CAP_USD = 1.0;
const MAX_TRADES_PER_DAY = 3;
const MAX_OPEN_POSITIONS = 1;
const COOLDOWN_MS = 15 * 60 * 1000;
const RR = 1.5;
const TICK_MS = 30_000;               // scan every 30s
const POSITION_POLL_MS = 5_000;       // when in position, check every 5s
const MAKER_ORDER_TTL_MS = 180_000;   // cancel unfilled maker after 3 min
const FVG_BUFFER_PCT = 0.10;          // SL beyond far edge + 10% of FVG body
const TOUCH_TOLERANCE_PCT = 0.0005;   // price must be within 0.05% of FVG mid to fire
const LEARN_ROOT = path.resolve('./trade-learnings');
const STATE_DIR  = path.resolve('./.trader-state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const STOP_FLAG  = path.join(STATE_DIR, 'stop.flag');

// ──────────────────────────────────────────────────────────────────
// Runtime state
// ──────────────────────────────────────────────────────────────────
const cooldownUntil = new Map();      // symbol → ts ms when cooldown expires
let tradesToday = 0;
let dailyPnlUsd = 0;
let dailyResetAt = nextUtcMidnight();
let pendingOrder = null;              // { symbol, orderId, expiresAt }
let lastError = null;
let lastCycleAt = 0;
let cycleCount = 0;

function nextUtcMidnight() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

function maybeRollDay() {
  if (Date.now() >= dailyResetAt) {
    log(`[day-roll] resetting daily counters (was trades=${tradesToday} pnl=${dailyPnlUsd.toFixed(4)})`);
    tradesToday = 0;
    dailyPnlUsd = 0;
    dailyResetAt = nextUtcMidnight();
  }
}

function log(...args) {
  console.log(new Date().toISOString(), '·', ...args);
}

async function writeState(extra = {}) {
  const s = {
    ts: Date.now(),
    cycleCount,
    lastCycleAt,
    symbols: SYMBOLS,
    tradesToday,
    dailyPnlUsd: Number(dailyPnlUsd.toFixed(6)),
    dailyResetAt,
    cooldownUntil: Object.fromEntries([...cooldownUntil.entries()]),
    pendingOrder,
    lastError,
    ...extra,
  };
  try { await writeFile(STATE_FILE, JSON.stringify(s, null, 2)); }
  catch (e) { /* /run may not exist; ignore */ }
}

// ──────────────────────────────────────────────────────────────────
// MEXC helpers
// ──────────────────────────────────────────────────────────────────
async function mexcSigned(opts) {
  const r = await callMexcSigned({ apiKey: API_KEY, apiSecret: API_SECRET, ...opts });
  let body = null;
  try { body = JSON.parse(r.body); } catch (e) { /* keep null */ }
  return { ok: r.ok, status: r.status, raw: r.body, json: body };
}

// Public klines fetch (no signing). 5m candles.
async function fetchKlines(symbol, limit = LOOKBACK_BARS) {
  const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Min${TF_MIN}&limit=${limit}`;
  const r = await fetch(url);
  const j = await r.json();
  const d = j.data || {};
  // MEXC returns parallel arrays: open, close, high, low, time, vol, amount
  if (!Array.isArray(d.open)) return [];
  const bars = d.open.map((o, i) => ({
    o: +o, c: +d.close[i], h: +d.high[i], l: +d.low[i], t: +d.time[i],
  }));
  // Drop the in-progress last bar.
  return bars.slice(0, -1);
}

async function fetchTicker(symbol) {
  const url = `https://contract.mexc.com/api/v1/contract/ticker?symbol=${symbol}`;
  const r = await fetch(url);
  const j = await r.json();
  const d = j.data;
  if (!d) return null;
  const x = Array.isArray(d) ? d[0] : d;
  return { lastPrice: +x.lastPrice, bid1: +x.bid1, ask1: +x.ask1 };
}

async function fetchContractMeta(symbol) {
  const url = `https://contract.mexc.com/api/v1/contract/detail?symbol=${symbol}`;
  const r = await fetch(url);
  const j = await r.json();
  const d = j.data;
  const x = Array.isArray(d) ? d[0] : d;
  return {
    contractSize: +x.contractSize,
    minVol: +x.minVol,
    priceUnit: +x.priceUnit,
    maxLev: +x.maxLeverage,
  };
}

async function getOpenPositions() {
  const r = await mexcSigned({ path: '/api/v1/private/position/open_positions', method: 'GET' });
  return Array.isArray(r.json?.data) ? r.json.data : [];
}

async function getAccountUsdt() {
  const r = await mexcSigned({ path: '/api/v1/private/account/assets', method: 'GET' });
  const rows = Array.isArray(r.json?.data) ? r.json.data : [];
  const usdt = rows.find(x => x.currency === 'USDT');
  return usdt ? +usdt.availableBalance : 0;
}

async function placeOrder(body) {
  return mexcSigned({ path: '/api/v1/private/order/submit', method: 'POST', body });
}

async function cancelOrder(orderId) {
  return mexcSigned({ path: '/api/v1/private/order/cancel', method: 'POST', body: [String(orderId)] });
}

// ──────────────────────────────────────────────────────────────────
// FVG detection — 5m, three-bar gap.
//   Bullish FVG: bars[i-2].high < bars[i].low (gap between i-2 high and i low)
//   Bearish FVG: bars[i-2].low  > bars[i].high
// A gap is "mitigated" when a subsequent bar trades back through its mid.
// We want the most recent unmitigated gap.
// ──────────────────────────────────────────────────────────────────
function detectUnmitigatedFvg(bars) {
  if (bars.length < 3) return null;
  for (let i = bars.length - 1; i >= 2; i--) {
    const a = bars[i - 2], c = bars[i];
    let gap = null;
    if (a.h < c.l)      gap = { dir: 'bull', lo: a.h, hi: c.l };
    else if (a.l > c.h) gap = { dir: 'bear', lo: c.h, hi: a.l };
    if (!gap) continue;
    gap.mid = (gap.lo + gap.hi) / 2;
    gap.body = gap.hi - gap.lo;
    gap.formedAt = c.t;
    gap.formedIdx = i;
    // Check mitigation by any bar AFTER it.
    let mitigated = false;
    for (let j = i + 1; j < bars.length; j++) {
      if (bars[j].l <= gap.mid && bars[j].h >= gap.mid) { mitigated = true; break; }
    }
    if (!mitigated) return gap;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// Trade lifecycle
// ──────────────────────────────────────────────────────────────────
let positionContext = null;  // remembers { symbol, side, entry, sl, tp, qty, lev, posId, openedAt }

async function tryFire(symbol) {
  // ── gates ────────────────────────────────────────────────────
  maybeRollDay();
  if (tradesToday >= MAX_TRADES_PER_DAY)                    return { skip: 'daily-trade-cap' };
  if (dailyPnlUsd <= -DAILY_LOSS_CAP_USD)                   return { skip: 'daily-loss-cap' };
  const cd = cooldownUntil.get(symbol) || 0;
  if (Date.now() < cd)                                       return { skip: 'cooldown', detail: `${Math.round((cd-Date.now())/1000)}s` };
  if (pendingOrder)                                          return { skip: 'pending-order' };

  const openPositions = await getOpenPositions();
  if (openPositions.length >= MAX_OPEN_POSITIONS)            return { skip: 'in-position' };

  // ── data ─────────────────────────────────────────────────────
  const [bars, ticker, meta] = await Promise.all([
    fetchKlines(symbol, LOOKBACK_BARS),
    fetchTicker(symbol),
    fetchContractMeta(symbol),
  ]);
  if (!bars.length || !ticker || !meta)                      return { skip: 'no-data' };

  const fvg = detectUnmitigatedFvg(bars);
  if (!fvg)                                                  return { skip: 'no-fvg' };

  // ── proximity check ─────────────────────────────────────────
  const price = ticker.lastPrice;
  const distPct = Math.abs((price - fvg.mid) / fvg.mid);
  if (distPct > TOUCH_TOLERANCE_PCT) {
    return { skip: 'far-from-fvg', detail: `dist=${(distPct*100).toFixed(3)}% mid=${fvg.mid.toFixed(2)} px=${price.toFixed(2)}` };
  }

  // ── compute levels ──────────────────────────────────────────
  const sideOpen = fvg.dir === 'bull' ? 1 : 3;   // 1 = open long, 3 = open short
  const farEdge = fvg.dir === 'bull' ? fvg.lo : fvg.hi;
  const slDir   = fvg.dir === 'bull' ? -1 : 1;
  const sl      = farEdge + slDir * (fvg.body * FVG_BUFFER_PCT);
  const stopDist = Math.abs(price - sl);
  if (!isFinite(stopDist) || stopDist <= 0)                  return { skip: 'invalid-stop' };

  const tp = fvg.dir === 'bull' ? price + stopDist * RR : price - stopDist * RR;

  // ── sizing ──────────────────────────────────────────────────
  const equity = await getAccountUsdt();
  const riskUsd = equity * RISK_PCT;            // $0.25 at $50
  // notional per contract = contractSize * entryPrice
  // stopDistUsd per contract = contractSize * stopDist
  // qty = riskUsd / stopDistUsd
  const stopDistUsdPerContract = meta.contractSize * stopDist;
  let qty = Math.floor(riskUsd / stopDistUsdPerContract);
  if (qty < meta.minVol) qty = meta.minVol;     // honor minVol even if it nudges risk slightly over
  // Sanity: don't let qty go nuts (e.g. if stopDist is tiny)
  const maxQtyByMargin = Math.floor((equity * 0.5 * LEVERAGE) / (meta.contractSize * price));
  if (qty > maxQtyByMargin && maxQtyByMargin > 0) qty = maxQtyByMargin;

  // ── snap price to priceUnit ─────────────────────────────────
  const snapPrice = v => Math.round(v / meta.priceUnit) * meta.priceUnit;
  const entry = snapPrice(fvg.mid);
  const slSnap = snapPrice(sl);
  const tpSnap = snapPrice(tp);

  // ── fire ────────────────────────────────────────────────────
  const body = {
    symbol,
    price: entry,
    vol: qty,
    leverage: LEVERAGE,
    side: sideOpen,
    type: 2,             // POST_ONLY maker
    openType: 1,         // isolated
    stopLossPrice: slSnap,
    takeProfitPrice: tpSnap,
  };
  log(`[fire] ${symbol} ${fvg.dir.toUpperCase()} qty=${qty} entry=${entry} sl=${slSnap} tp=${tpSnap} risk≈$${(stopDistUsdPerContract*qty).toFixed(3)}`);
  const r = await placeOrder(body);
  if (!r.json || r.json.success !== true) {
    return { skip: 'mexc-rejected', detail: JSON.stringify(r.json || r.raw).slice(0, 200) };
  }
  const orderId = r.json.data;
  pendingOrder = { symbol, orderId, expiresAt: Date.now() + MAKER_ORDER_TTL_MS };
  positionContext = {
    symbol, dir: fvg.dir, side: sideOpen, entry, sl: slSnap, tp: tpSnap,
    qty, lev: LEVERAGE, contractSize: meta.contractSize, openedAt: Date.now(),
    orderId, fvgFormedAt: fvg.formedAt,
  };
  return { fired: true, orderId, entry, sl: slSnap, tp: tpSnap };
}

async function watchPendingOrder() {
  if (!pendingOrder) return;
  if (Date.now() >= pendingOrder.expiresAt) {
    log(`[ttl] cancelling unfilled order ${pendingOrder.orderId} for ${pendingOrder.symbol}`);
    try { await cancelOrder(pendingOrder.orderId); } catch (e) { /* swallow */ }
    pendingOrder = null;
    positionContext = null;
    return;
  }
  // If a position appeared, the order filled — promote.
  const ps = await getOpenPositions();
  const pos = ps.find(p => p.symbol === pendingOrder.symbol);
  if (pos && positionContext) {
    log(`[filled] ${pendingOrder.symbol} pos=${pos.positionId} avgPx=${pos.holdAvgPrice}`);
    positionContext.posId = pos.positionId;
    positionContext.filledAt = Date.now();
    pendingOrder = null;
  }
}

// Once a position is open, MEXC manages the SL/TP. When the position
// disappears from open_positions, look up the fill history to compute the
// outcome and write a learnings file.
async function reconcileClosedPosition() {
  if (!positionContext || !positionContext.posId) return;
  const ps = await getOpenPositions();
  const stillOpen = ps.find(p => p.positionId === positionContext.posId);
  if (stillOpen) return;

  const ctx = positionContext;
  positionContext = null;
  cooldownUntil.set(ctx.symbol, Date.now() + COOLDOWN_MS);
  tradesToday += 1;

  // Pull recent orders to find the close fill price.
  const r = await mexcSigned({
    path: '/api/v1/private/order/list/history_orders',
    method: 'GET',
    params: { symbol: ctx.symbol, page_num: 1, page_size: 10 },
  });
  const orders = Array.isArray(r.json?.data) ? r.json.data : [];
  // Side 4 = close long, 2 = close short.
  const closeSide = ctx.dir === 'bull' ? 4 : 2;
  const closeOrder = orders.find(o => o.side === closeSide && o.state === 3);
  const openOrder  = orders.find(o => String(o.orderId) === String(ctx.orderId));
  const fillPx = closeOrder ? +closeOrder.dealAvgPrice : null;
  const openPx = openOrder ? +openOrder.dealAvgPrice : ctx.entry;
  const fees   = (+closeOrder?.takerFee || +closeOrder?.fee || 0) + (+openOrder?.takerFee || +openOrder?.fee || 0);

  const pnlPriceMove = fillPx != null
    ? (ctx.dir === 'bull' ? (fillPx - openPx) : (openPx - fillPx))
    : 0;
  const pnlUsd = (pnlPriceMove * ctx.contractSize * ctx.qty) - fees;
  dailyPnlUsd += pnlUsd;

  const stopDist = Math.abs(ctx.entry - ctx.sl);
  const rMultiple = stopDist > 0 ? (pnlPriceMove / stopDist) : 0;
  const outcome = pnlUsd > 0.001 ? 'win' : pnlUsd < -0.001 ? 'loss' : 'be';
  log(`[close] ${ctx.symbol} ${ctx.dir} fill=${fillPx} pnl=$${pnlUsd.toFixed(4)} r=${rMultiple.toFixed(2)}R outcome=${outcome}`);

  try {
    await writeLearningFile({
      timestamp: Date.now(),
      symbol: ctx.symbol,
      side: ctx.dir === 'bull' ? 'LONG' : 'SHORT',
      outcome,
      entry: openPx,
      sl: ctx.sl,
      tp: ctx.tp,
      exit: fillPx,
      qty: ctx.qty,
      leverage: ctx.lev,
      pnlUsd,
      rMultiple,
      fees,
      grade: 'auto',
      notes: 'AZC autonomous trader · 5m FVG retest · POST_ONLY maker · isolated 10x.',
    }, LEARN_ROOT);
  } catch (e) {
    log('[learn-write-fail]', e.message);
  }
}

async function stopFlagExists() {
  try { await access(STOP_FLAG, fsConst.F_OK); return true; }
  catch { return false; }
}

async function gracefulShutdown(reason) {
  log(`[shutdown] reason=${reason}`);
  // Cancel any pending unfilled order so we don't leave a stray maker on the book.
  if (pendingOrder) {
    log(`[shutdown] cancelling pending order ${pendingOrder.orderId}`);
    try { await cancelOrder(pendingOrder.orderId); } catch (e) { log('[shutdown] cancel-fail', e.message); }
  }
  // Note: any OPEN position is left untouched. SL/TP are managed by MEXC.
  // The trader doesn't market-close an open position on shutdown — that would
  // be a surprise exit. Operator decides.
  if (positionContext?.posId) {
    log(`[shutdown] WARNING: position ${positionContext.posId} on ${positionContext.symbol} is still open. SL/TP are with MEXC.`);
  }
  await writeState({ shuttingDown: true, shutdownReason: reason });
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ──────────────────────────────────────────────────────────────────
// Main loop
// ──────────────────────────────────────────────────────────────────
log('[start] AZC trader online · symbols=' + SYMBOLS.join(',') + ' · lev=' + LEVERAGE + ' · risk/trade=' + (RISK_PCT*100) + '% · daily cap $' + DAILY_LOSS_CAP_USD);
await mkdir(LEARN_ROOT, { recursive: true }).catch(() => {});
await mkdir(STATE_DIR, { recursive: true }).catch(() => {});

// If the stop flag is set at startup, refuse to launch — operator must
// clear it via the dashboard's start button (POST /trader-start).
if (await stopFlagExists()) {
  log('[start] stop.flag present at startup — refusing to launch. Clear via POST /trader-start.');
  await writeState({ refusedStart: true });
  process.exit(0);
}

while (true) {
  cycleCount += 1;
  lastCycleAt = Date.now();
  // Check kill switch every cycle. gracefulShutdown calls process.exit
  // so control never returns here, but if it ever did, break the loop.
  if (await stopFlagExists()) {
    await gracefulShutdown('stop-flag');
    break;
  }
  try {
    if (positionContext?.posId) {
      await reconcileClosedPosition();
    }
    if (pendingOrder) {
      await watchPendingOrder();
    }
    if (!pendingOrder && !positionContext) {
      maybeRollDay();
      for (const sym of SYMBOLS) {
        const r = await tryFire(sym);
        if (r.fired) break;
        if (r.skip && r.skip !== 'far-from-fvg' && r.skip !== 'no-fvg') {
          log(`[skip:${sym}] ${r.skip}${r.detail ? ' · ' + r.detail : ''}`);
        }
      }
    }
    lastError = null;
  } catch (e) {
    lastError = e.message || String(e);
    log('[cycle-err]', lastError);
  }
  await writeState();
  await sleep(positionContext ? POSITION_POLL_MS : TICK_MS);
}
