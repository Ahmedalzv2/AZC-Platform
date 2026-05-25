// AZC autonomous trader — server-side execution for the $50 micro-capital lane.
//
// Honours the user's existing safety envelope:
//   $50 micro-capital · one position max · 15-min per-symbol cooldown
//   consecutive-loss halt · futures-only · isolated 10×
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

// Expanded watchlist of liquid USDT perps. SOL excluded — its 1-contract
// min size ($200 notional) + $0.08 roundtrip fee make it negative-EV at
// $50 capital. The rest have small enough contracts that 1.5%/trade risk
// math survives min-size rounding.
// Symbol set chosen by tests/screen-symbols.mjs over 90d fixtures,
// re-scored in 24/7 mode (no killzone gate) since the live trader now
// fires around the clock.
//   ARB   59.8% WR / +0.515R per trade  (top of the 24/7 dataset)
//   DOT   57.6%    / +0.447R
//   NEAR  55.4%    / +0.413R
//   SUI   53.7%    / +0.385R
//   XRP   50.8%    / +0.389R
//   LTC   47.4%    / +0.395R
//   AVAX  50.7%    / +0.331R
//   DOGE  50.3%    / +0.326R
//   SOL   47.0%    / +0.282R
//   BTC   41.7%    / +0.276R  (institutional benchmark; marginal)
// Dropped vs killzone-gated set: INJ (0.308R → 0.198R in 24/7 — falls
// below the +0.20R bar). Stays dropped: BNB, LINK, ETH (also marginal
// or below BE in 24/7 mode).
// 90d aggregate (24/7, 10 symbols): 1844 trades · 45.7% WR · +614R
// total · +0.333R/trade. Versus killzone-gated 11-symbol set (1025
// trades / +382R total / +0.372R/trade): +80% trade volume, +61% total
// R, -14% per-trade quality. Volume + total return wins.
const SYMBOLS = [
  'ARB_USDT',  'DOT_USDT',  'NEAR_USDT', 'SUI_USDT',
  'XRP_USDT',  'LTC_USDT',  'AVAX_USDT', 'DOGE_USDT',
  'SOL_USDT',  'BTC_USDT',
];
const TF_MIN = 5;
const HTF_MIN = 60;
const LOOKBACK_BARS = 40;
const HTF_LOOKBACK = 24;
const HTF_SMA = 20;
const LEVERAGE = 10;

// Graduated sizing — sizes to conviction. Quality score from the scanner
// determines the bucket: top-1 by wide margin (the "best of best"), top-2
// (a strong candidate), or default. No daily $ cap — replaced by the
// consecutive-loss halt below.
const RISK_PCT_DEFAULT = 0.02;   // 2% base ($1 @ $50)
const RISK_PCT_TOP_2    = 0.03;   // 3% for top-2 picks ($1.50 @ $50)
const RISK_PCT_BEST     = 0.05;   // 5% for stand-out best candidate ($2.50)

const MAX_OPEN_POSITIONS = 1;
const COOLDOWN_MS = 15 * 60 * 1000;
// 90d backtest (tests/backtest-azc-trader.mjs) at 5L tolerance ≈ 1-in-18
// halt probability at the methodology's 50% win rate — a real signal, not
// noise. 3L was 1-in-8, fired constantly on variance.
const MAX_CONSECUTIVE_LOSSES = 5;
// 60m force-close was leaving 6pp of win rate on the table — 70 trades
// over 90d hit TP only after the cap. 120m captures them while still
// staying inside a single funding window most of the time.
const MAX_HOLD_MS = 120 * 60 * 1000;
const RR = 1.5;
const TICK_MS = 15_000;
const POSITION_POLL_MS = 5_000;
const MAKER_ORDER_TTL_MS = 180_000;
const FVG_BUFFER_PCT = 0.10;
const TOUCH_TOLERANCE_PCT = 0.0008;   // proximity gate, 0.08% of price
const MIN_FVG_BODY_PCT = 0.0010;      // FVG body must be ≥ 0.10% of price (skip micro-gaps)
const MIN_STOP_PCT     = 0.0020;      // stop distance must be ≥ 0.20% of price (else stop is hunt-bait)

// Killzone metadata — these UTC windows are *not* a gate (24/7 trading
// is enabled). They're kept so every fire's post-mortem records which
// session it happened in (currentKillzoneName() in the close payload).
//   Asia:     00:00-04:00 UTC (Tokyo/HK desks; BTC moves often originate)
//   London:   07:00-10:00 UTC (institutional open)
//   NY AM:    12:30-16:00 UTC (peak global volume)
//   Late-NY:  18:30-22:00 UTC (NY close → Asia roll-over)
// Outside these windows session is reported as null on the postmortem.
const KILLZONES_UTC = [
  { startH: 0,  startM: 0,  endH: 4,  endM: 0 },
  { startH: 7,  startM: 0,  endH: 10, endM: 0 },
  { startH: 12, startM: 30, endH: 16, endM: 0 },
  { startH: 18, startM: 30, endH: 22, endM: 0 },
];
function inKillzone(now = new Date()) {
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return KILLZONES_UTC.some(z => {
    const s = z.startH * 60 + z.startM;
    const e = z.endH * 60 + z.endM;
    return m >= s && m < e;
  });
}
function currentKillzoneName(now = new Date()) {
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  const names = ['asia', 'london', 'ny-am', 'late-ny'];
  for (let i = 0; i < KILLZONES_UTC.length; i++) {
    const z = KILLZONES_UTC[i];
    const s = z.startH * 60 + z.startM;
    const e = z.endH * 60 + z.endM;
    if (m >= s && m < e) return names[i];
  }
  return null;
}
const LEARN_ROOT = path.resolve('./trade-learnings');
const STATE_DIR  = path.resolve('./.trader-state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const STOP_FLAG  = path.join(STATE_DIR, 'stop.flag');
const HALT_CLEAR = path.join(STATE_DIR, 'halt-cleared');

// ──────────────────────────────────────────────────────────────────
// Runtime state
// ──────────────────────────────────────────────────────────────────
const cooldownUntil = new Map();      // symbol → ts ms when cooldown expires
const metaCache = new Map();          // symbol → { contractSize, minVol, priceUnit } (cached)
let tradesToday = 0;
let dailyPnlUsd = 0;
let consecutiveLosses = 0;       // resets on a win or break-even, halts at MAX_CONSECUTIVE_LOSSES
let haltedAt = null;             // ISO timestamp set when consec-loss halt fires
let dailyResetAt = nextUtcMidnight();
let pendingOrder = null;              // { symbol, orderId, expiresAt }
let lastError = null;
let lastCycleAt = 0;
let cycleCount = 0;
let lastScanSummary = null;           // top candidates from last scan, surfaced in state.json

function nextUtcMidnight() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

function maybeRollDay() {
  if (Date.now() >= dailyResetAt) {
    log(`[day-roll] resetting daily counters (was trades=${tradesToday} pnl=${dailyPnlUsd.toFixed(4)} losses=${consecutiveLosses} halted=${haltedAt ? 'yes' : 'no'})`);
    tradesToday = 0;
    dailyPnlUsd = 0;
    consecutiveLosses = 0;
    haltedAt = null;
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
    inKillzone: inKillzone(),
    tradesToday,
    dailyPnlUsd: Number(dailyPnlUsd.toFixed(6)),
    dailyResetAt,
    consecutiveLosses,
    maxConsecutiveLosses: MAX_CONSECUTIVE_LOSSES,
    haltedAt,
    riskTiers: { default: RISK_PCT_DEFAULT, top2: RISK_PCT_TOP_2, best: RISK_PCT_BEST },
    cooldownUntil: Object.fromEntries([...cooldownUntil.entries()]),
    pendingOrder,
    positionContext: positionContext ? { symbol: positionContext.symbol, dir: positionContext.dir, posId: positionContext.posId, entry: positionContext.entry, sl: positionContext.sl, tp: positionContext.tp } : null,
    lastScanSummary,
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

// Public klines fetch (no signing). interval default = 5m.
async function fetchKlines(symbol, intervalMin = TF_MIN, limit = LOOKBACK_BARS) {
  const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=Min${intervalMin}&limit=${limit}`;
  const r = await fetch(url);
  const j = await r.json();
  const d = j.data || {};
  if (!Array.isArray(d.open)) return [];
  const bars = d.open.map((o, i) => ({
    o: +o, c: +d.close[i], h: +d.high[i], l: +d.low[i], t: +d.time[i],
  }));
  return bars.slice(0, -1);   // drop in-progress bar
}

// HTF trend filter — 1H SMA(20). Returns 'bull' if last close > SMA,
// 'bear' if below. Used to gate the 5m FVG direction.
async function htfTrend(symbol) {
  const bars = await fetchKlines(symbol, HTF_MIN, HTF_LOOKBACK);
  if (bars.length < HTF_SMA) return null;
  const recent = bars.slice(-HTF_SMA);
  const sma = recent.reduce((a, b) => a + b.c, 0) / recent.length;
  const last = bars[bars.length - 1].c;
  return last > sma ? 'bull' : 'bear';
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

// Build a candidate trade for a single symbol. Returns { skip } if any
// per-symbol gate fails; otherwise returns the prepared trade payload so
// the multi-asset scanner can rank candidates and fire one.
async function buildCandidate(symbol) {
  const cd = cooldownUntil.get(symbol) || 0;
  if (Date.now() < cd) return { skip: 'cooldown', symbol };

  let meta = metaCache.get(symbol);
  const [bars5m, htfBars, ticker] = await Promise.all([
    fetchKlines(symbol, TF_MIN, LOOKBACK_BARS),
    fetchKlines(symbol, HTF_MIN, HTF_LOOKBACK),
    fetchTicker(symbol),
    meta ? Promise.resolve(null) : fetchContractMeta(symbol).then(m => { metaCache.set(symbol, m); meta = m; }),
  ]);
  if (!bars5m.length || !htfBars.length || !ticker || !meta) return { skip: 'no-data', symbol };

  const recent = htfBars.slice(-HTF_SMA);
  if (recent.length < HTF_SMA) return { skip: 'htf-warmup', symbol };
  const sma = recent.reduce((a, b) => a + b.c, 0) / recent.length;
  const htfDir = htfBars[htfBars.length-1].c > sma ? 'bull' : 'bear';

  const fvg = detectUnmitigatedFvg(bars5m);
  if (!fvg) return { skip: 'no-fvg', symbol };
  if (fvg.dir !== htfDir) return { skip: 'htf-disagree', symbol };

  const price = ticker.lastPrice;

  // Minimum FVG size — gaps smaller than 0.10% of price are micro-noise
  // (1-bar wicks, not real displacement). Stop sitting at the FVG edge
  // is hunt-bait when the body is this small.
  const fvgBodyPct = fvg.body / price;
  if (fvgBodyPct < MIN_FVG_BODY_PCT) return { skip: 'fvg-too-small', symbol, fvgBodyPct };

  const distPct = Math.abs((price - fvg.mid) / fvg.mid);
  if (distPct > TOUCH_TOLERANCE_PCT) return { skip: 'far-from-fvg', symbol, distPct };

  const sideOpen = fvg.dir === 'bull' ? 1 : 3;
  const farEdge  = fvg.dir === 'bull' ? fvg.lo : fvg.hi;
  const slDir    = fvg.dir === 'bull' ? -1 : 1;

  // Entry is the FVG mid. SL and TP must be computed FROM THE ENTRY, not
  // from ticker price — earlier code mixed those references which made
  // the math drift (e.g. SL on the wrong side of entry on a small FVG).
  // The entry-anchored math also makes the FVG-edge buffer + min-stop
  // floor work correctly together.
  const entry    = fvg.mid;
  const slRaw    = farEdge + slDir * (fvg.body * FVG_BUFFER_PCT);
  const slMinFloor = entry + slDir * (price * MIN_STOP_PCT);  // floor: at least MIN_STOP_PCT away
  const sl       = fvg.dir === 'bull' ? Math.min(slRaw, slMinFloor) : Math.max(slRaw, slMinFloor);
  const stopDist = Math.abs(entry - sl);
  if (!isFinite(stopDist) || stopDist <= 0) return { skip: 'invalid-stop', symbol };
  if (stopDist / price < MIN_STOP_PCT) return { skip: 'stop-too-tight', symbol };

  const tp = fvg.dir === 'bull' ? entry + stopDist * RR : entry - stopDist * RR;
  const stopDistUsdPerContract = meta.contractSize * stopDist;

  return { symbol, fvg, htfDir, price, entry, sl, tp, sideOpen, stopDistUsdPerContract, meta, distPct };
}

// Always-on scan — runs every cycle whether or not the bot can actually
// fire. Surfaces what the bot is looking at to the dashboard so the
// operator sees continuous activity instead of a silent "outside KZ" log.
async function scanAllSymbols() {
  const results = await Promise.all(
    SYMBOLS.map(s => buildCandidate(s).catch(e => ({ skip: 'err', symbol: s, detail: e.message })))
  );
  lastScanSummary = results.map(r => ({
    symbol: r.symbol,
    skip: r.skip || null,
    dir: r.fvg?.dir || null,
    distPct: r.distPct ?? null,
    fvgBodyPct: r.fvg ? (r.fvg.body / r.price) : null,
    detail: r.detail || null,
    ts: Date.now(),
  }));
  return results;
}

async function tryFire() {
  maybeRollDay();
  const results = await scanAllSymbols();

  if (haltedAt)                                              return { skip: 'consec-loss-halt', detail: `since ${haltedAt}` };
  // No killzone gate — backtest comparison showed 24/7 firing gives ~+80%
  // more trades and +61% more total R over 90d vs killzone-gated, at the
  // cost of 6pp lower win rate. Volume wins. The killzone label is still
  // recorded on every fire (session field in the postmortem) for analysis.
  if (pendingOrder)                                          return { skip: 'pending-order' };

  const openPositions = await getOpenPositions();
  if (openPositions.length >= MAX_OPEN_POSITIONS)            return { skip: 'in-position' };

  const valid = results.filter(r => !r.skip);
  if (!valid.length) return { skip: 'no-candidates' };

  // Rank by quality. Closer to FVG mid AND HTF-agreement strength both
  // matter — we score each candidate and pick the top. Graduated risk %
  // depends on the candidate's rank in this scan.
  valid.sort((a, b) => a.distPct - b.distPct);

  // Quality buckets:
  //   "best" = top-1 AND its distPct is meaningfully better than #2 (margin)
  //   "top2" = ranks #1 or #2 (or sole candidate when only one survives)
  //   default = anything else (shouldn't happen — we only fire top-2)
  const pick = valid[0];
  let tier;
  if (valid.length === 1) {
    tier = 'top2';
  } else if ((valid[1].distPct - pick.distPct) / Math.max(pick.distPct, 1e-9) > 0.5) {
    tier = 'best';
  } else {
    tier = 'top2';
  }
  const riskPct = tier === 'best' ? RISK_PCT_BEST : tier === 'top2' ? RISK_PCT_TOP_2 : RISK_PCT_DEFAULT;

  const equity = await getAccountUsdt();
  const riskUsd = equity * riskPct;
  let qty = Math.floor(riskUsd / pick.stopDistUsdPerContract);
  if (qty < pick.meta.minVol) qty = pick.meta.minVol;
  const maxQtyByMargin = Math.floor((equity * 0.5 * LEVERAGE) / (pick.meta.contractSize * pick.price));
  if (qty > maxQtyByMargin && maxQtyByMargin > 0) qty = maxQtyByMargin;

  const snap = v => Math.round(v / pick.meta.priceUnit) * pick.meta.priceUnit;
  const entry  = snap(pick.entry);
  const slSnap = snap(pick.sl);
  const tpSnap = snap(pick.tp);

  const body = {
    symbol: pick.symbol,
    price: entry,
    vol: qty,
    leverage: LEVERAGE,
    side: pick.sideOpen,
    type: 2,
    openType: 1,
    stopLossPrice: slSnap,
    takeProfitPrice: tpSnap,
  };
  log(`[fire] ${pick.symbol} ${pick.fvg.dir.toUpperCase()} tier=${tier} htf=${pick.htfDir} qty=${qty} entry=${entry} sl=${slSnap} tp=${tpSnap} risk≈$${(pick.stopDistUsdPerContract*qty).toFixed(3)} (${(riskPct*100).toFixed(1)}%) cand=${valid.length}/${SYMBOLS.length}`);
  const r = await placeOrder(body);
  if (!r.json || r.json.success !== true) {
    return { skip: 'mexc-rejected', detail: JSON.stringify(r.json || r.raw).slice(0, 200), symbol: pick.symbol };
  }
  const orderId = r.json.data;
  pendingOrder = { symbol: pick.symbol, orderId, expiresAt: Date.now() + MAKER_ORDER_TTL_MS };
  positionContext = {
    symbol: pick.symbol, dir: pick.fvg.dir, side: pick.sideOpen, entry, sl: slSnap, tp: tpSnap,
    qty, lev: LEVERAGE, contractSize: pick.meta.contractSize, openedAt: Date.now(),
    orderId, fvgFormedAt: pick.fvg.formedAt, htfDir: pick.htfDir,
    // Snapshot the full decision context at fire-time so the post-mortem
    // file written on close has the WHY of the trade, not just the WHAT.
    tier, riskPct, priceAtCall: pick.price,
    distPct: pick.distPct, fvgBody: pick.fvg.body, fvgBodyPct: pick.fvg.body / pick.price,
    session: currentKillzoneName(),
  };
  return { fired: true, orderId, symbol: pick.symbol, entry, sl: slSnap, tp: tpSnap };
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

    // SURVIVAL: verify the exchange-side SL is actually attached to this
    // position. MEXC's order/submit takes stopLossPrice as a hint that it
    // turns into a plan-order; if the precision is wrong, or there's a
    // race, it can silently fail to attach. A naked position at 10x is
    // the fastest way to lose $50. If SL/TP missing, we panic-close.
    try {
      await verifyExchangeStopOrPanicClose(pos, positionContext);
    } catch (e) {
      log(`[stop-verify-err] ${e.message} — closing position to be safe`);
      try { await panicCloseLong(positionContext); } catch (e2) { log('[panic-close-fail]', e2.message); }
    }
  }
}

// Confirm the position has an attached stop. MEXC exposes per-position
// plan-orders via /api/v1/private/stoporder/list/orders (a.k.a. plan
// orders). If the response doesn't show a stop tied to this positionId,
// market-close immediately.
async function verifyExchangeStopOrPanicClose(pos, ctx) {
  const r = await mexcSigned({
    path: '/api/v1/private/stoporder/list/orders',
    method: 'GET',
    params: { symbol: ctx.symbol, page_num: 1, page_size: 20 },
  });
  const plans = Array.isArray(r.json?.data?.resultList) ? r.json.data.resultList
              : Array.isArray(r.json?.data) ? r.json.data : [];
  // We want at least one plan order on this symbol whose trigger is in
  // the right direction (long: trigger BELOW entry; short: trigger ABOVE).
  const hasGuard = plans.some(p => {
    const trig = +p.triggerPrice;
    if (!isFinite(trig)) return false;
    return ctx.dir === 'bull' ? trig < ctx.entry : trig > ctx.entry;
  });
  if (hasGuard) {
    log(`[stop-verify-ok] ${ctx.symbol} — ${plans.length} plan order(s) found, guard present`);
    return;
  }
  log(`[stop-verify-FAIL] ${ctx.symbol} pos=${ctx.posId} — no attached stop. PANIC CLOSE.`);
  await panicCloseLong(ctx);
}

async function panicCloseLong(ctx) {
  // Market-close. Side 4 = close long, side 2 = close short.
  const closeSide = ctx.dir === 'bull' ? 4 : 2;
  const ticker = await fetchTicker(ctx.symbol);
  const px = ctx.dir === 'bull' ? ticker.bid1 - ctx.meta?.priceUnit * 5 : ticker.ask1 + ctx.meta?.priceUnit * 5;
  const snapPx = ctx.meta ? Math.round(px / ctx.meta.priceUnit) * ctx.meta.priceUnit : px;
  const body = {
    symbol: ctx.symbol,
    price: snapPx,
    vol: ctx.qty,
    leverage: ctx.lev,
    side: closeSide,
    type: 1,            // plain limit, fills as taker immediately
    openType: 1,
  };
  const r = await placeOrder(body);
  log(`[panic-close] ${ctx.symbol} side=${closeSide} qty=${ctx.qty} -> ${r.status} ${JSON.stringify(r.json || {}).slice(0,140)}`);
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
  const feeOpen  = +openOrder?.takerFee  || +openOrder?.fee  || 0;
  const feeClose = +closeOrder?.takerFee || +closeOrder?.fee || 0;
  const fees = feeOpen + feeClose;

  const pnlPriceMove = fillPx != null
    ? (ctx.dir === 'bull' ? (fillPx - openPx) : (openPx - fillPx))
    : 0;
  const grossUsd = pnlPriceMove * ctx.contractSize * ctx.qty;
  const pnlUsd = grossUsd - fees;
  dailyPnlUsd += pnlUsd;

  // Hold-time + funding-window crossings (8h boundaries, UTC). The trader
  // doesn't track funding payments directly, but the windows-crossed count
  // is what we need to tell whether funding likely affected this trade.
  const filledAt = ctx.filledAt || ctx.openedAt || Date.now();
  const holdMs = Date.now() - filledAt;
  const windowsCrossed = Math.floor(Date.now() / (8 * 3600 * 1000)) - Math.floor(filledAt / (8 * 3600 * 1000));

  const stopDist = Math.abs(ctx.entry - ctx.sl);
  const rMultiple = stopDist > 0 ? (pnlPriceMove / stopDist) : 0;
  const outcome = pnlUsd > 0.001 ? 'win' : pnlUsd < -0.001 ? 'loss' : 'be';
  log(`[close] ${ctx.symbol} ${ctx.dir} fill=${fillPx} pnl=$${pnlUsd.toFixed(4)} r=${rMultiple.toFixed(2)}R outcome=${outcome}`);

  // Update consecutive-loss counter — the survival gate that replaced the
  // daily $ cap. Win or BE resets; loss increments. Hit MAX → halt.
  if (outcome === 'loss') {
    consecutiveLosses += 1;
    if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
      haltedAt = new Date().toISOString();
      log(`[HALT] ${consecutiveLosses} consecutive losses — pausing fires. Auto-resumes at next UTC midnight (day-roll); touch ${STATE_DIR}/halt-cleared to resume sooner.`);
    }
  } else {
    consecutiveLosses = 0;
  }

  try {
    const confluences = [];
    if (ctx.htfDir) confluences.push(`htf-agree:${ctx.htfDir}`);
    if (ctx.tier)   confluences.push(`tier:${ctx.tier}`);
    if (ctx.session) confluences.push(`kz:${ctx.session}`);
    if (Number.isFinite(ctx.fvgBodyPct)) confluences.push(`fvg-body:${(ctx.fvgBodyPct*100).toFixed(2)}%`);
    if (Number.isFinite(ctx.distPct))    confluences.push(`fvg-dist:${(ctx.distPct*100).toFixed(3)}%`);

    const analysis = [
      `Fired in ${ctx.session || 'no-killzone'} killzone at 5m FVG mid retest.`,
      `HTF(${HTF_MIN}m SMA${HTF_SMA}) bias = ${ctx.htfDir}, quality tier = ${ctx.tier} (${(ctx.riskPct*100).toFixed(1)}% risk).`,
      `FVG body = ${(ctx.fvgBodyPct*100).toFixed(2)}% of price · entry was ${(ctx.distPct*100).toFixed(3)}% from FVG mid.`,
      `Stop = far-edge + ${(FVG_BUFFER_PCT*100).toFixed(0)}% buffer (floored to ${(MIN_STOP_PCT*100).toFixed(2)}% min). TP at ${RR}R.`,
    ].join(' ');

    await writeLearningFile({
      timestamp: Date.now(),
      symbol: ctx.symbol,
      side: ctx.dir === 'bull' ? 'LONG' : 'SHORT',
      outcome,
      entry: openPx,
      sl: ctx.sl,
      tp: ctx.tp,
      exitPrice: fillPx,
      priceAtCall: ctx.priceAtCall,
      qty: ctx.qty,
      leverage: ctx.lev,
      realizedUsd: pnlUsd,
      rMultiple,
      fees,
      grade: ctx.tier || 'auto',
      bias: ctx.htfDir || null,
      session: ctx.session || null,
      confluences,
      analysis,
      accounting: {
        grossUsd, feeUsdOpen: feeOpen, feeUsdClose: feeClose, fundingUsd: 0,
        windowsCrossed, holdMs, netUsd: pnlUsd,
      },
      orderId: ctx.orderId,
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
log(`[start] AZC trader online · symbols=${SYMBOLS.join(',')} · lev=${LEVERAGE}× · risk=${RISK_PCT_DEFAULT*100}/${RISK_PCT_TOP_2*100}/${RISK_PCT_BEST*100}% (def/top2/best) · halt after ${MAX_CONSECUTIVE_LOSSES} consec losses`);
await mkdir(LEARN_ROOT, { recursive: true }).catch(() => {});
await mkdir(STATE_DIR, { recursive: true }).catch(() => {});

// If the stop flag is set at startup, refuse to launch — operator must
// clear it via the dashboard's start button (POST /trader-start).
if (await stopFlagExists()) {
  log('[start] stop.flag present at startup — refusing to launch. Clear via POST /trader-start.');
  await writeState({ refusedStart: true });
  process.exit(0);
}

// Clean up any stale unfilled limit orders on the account before
// resuming. A previous crash could have left margin frozen behind a
// pending order that's no longer in our local pendingOrder state.
try {
  const r = await mexcSigned({ path: '/api/v1/private/order/list/open_orders', method: 'GET' });
  const open = Array.isArray(r.json?.data) ? r.json.data : [];
  if (open.length) {
    log(`[startup-cleanup] ${open.length} stale open order(s) — cancelling`);
    for (const o of open) {
      try {
        const c = await cancelOrder(o.orderId);
        log(`[startup-cleanup] cancel ${o.symbol} #${o.orderId} → ${JSON.stringify(c.json||{}).slice(0,120)}`);
      } catch (e) { log(`[startup-cleanup] cancel-err ${o.orderId} ${e.message}`); }
    }
  }
} catch (e) { log('[startup-cleanup-err]', e.message); }

while (true) {
  cycleCount += 1;
  lastCycleAt = Date.now();
  // Check kill switch every cycle.
  if (await stopFlagExists()) {
    await gracefulShutdown('stop-flag');
    break;
  }
  // Check halt-clear flag — if operator created it after a consec-loss
  // halt and reviewed the trades, this resumes the bot.
  if (haltedAt) {
    try {
      await access(HALT_CLEAR, fsConst.F_OK);
      log(`[halt-cleared] resuming after operator review (was halted ${haltedAt})`);
      haltedAt = null;
      consecutiveLosses = 0;
      try { await import('node:fs/promises').then(m => m.unlink(HALT_CLEAR)); } catch (e) {}
    } catch { /* halt-cleared not present, stay halted */ }
  }
  try {
    if (positionContext?.posId) {
      // Max-hold guard: market-close if a position is sitting too long.
      // 120-min cap — backtested as the sweet spot. Shorter caps (60m)
      // killed ~6pp of win rate by closing trades minutes before they
      // would have hit TP. Longer caps (180m+) showed diminishing
      // returns and started crossing funding windows more often.
      if (positionContext.filledAt && (Date.now() - positionContext.filledAt) > MAX_HOLD_MS) {
        log(`[max-hold] ${positionContext.symbol} held ${Math.round((Date.now()-positionContext.filledAt)/1000/60)}m — closing`);
        try { await panicCloseLong(positionContext); } catch (e) { log('[max-hold-close-err]', e.message); }
      }
      await reconcileClosedPosition();
    }
    if (pendingOrder) {
      await watchPendingOrder();
    }
    if (!pendingOrder && !positionContext) {
      maybeRollDay();
      const r = await tryFire();   // always runs scanAllSymbols inside
      if (r.skip && r.skip !== 'no-candidates') {
        log(`[skip] ${r.skip}${r.detail ? ' · ' + r.detail : ''}`);
      }
    } else if (pendingOrder || positionContext) {
      // Keep the dashboard scan feed alive even when bot can't fire.
      try { await scanAllSymbols(); } catch (e) {}
    }
    lastError = null;
  } catch (e) {
    lastError = e.message || String(e);
    log('[cycle-err]', lastError);
  }
  await writeState();
  await sleep(positionContext ? POSITION_POLL_MS : TICK_MS);
}
