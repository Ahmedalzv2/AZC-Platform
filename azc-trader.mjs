// AZC autonomous trader — server-side execution for the $50 micro-capital lane.
//
// Honours the user's existing safety envelope:
//   $50 micro-capital · one position max · 15-min per-symbol cooldown
//   drift-gated live execution · futures-only · isolated 10×
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
import { writeInsightsFile } from './trade-insights.mjs';
import { appendScanEvent } from './trader-events.mjs';
import { collectTrades, summarise } from './trade-stats.mjs';
import { loadTraderStateFromDisk } from './trader-state.mjs';
import { KILLZONES_UTC, inKillzone, currentKillzoneName } from './trader-killzones.mjs';
import { buildSetup } from './trader-signal.mjs';
import { decideGate, groupBySession } from './trader-drift-gate.mjs';
import { decideFireAction } from './trader-fire-decision.mjs';
import { getSentiment } from './trader-sentiment.mjs';
import { sendTelegram, fmtFireAlert, fmtCloseAlert, fmtDriftAlert } from './trader-notify.mjs';
import { sizeTradeByRiskAndMargin } from './trader-sizing.mjs';
import { shouldRefreshWallet } from './trader-wallet.mjs';
import { buildOrphanContext, isReadoptBlocked } from './trader-orphan.mjs';
import { decideRestore } from './trader-restore.mjs';

async function notify(text) {
  // Fire-and-forget — never let a Telegram failure interrupt the loop.
  // sendTelegram already returns {ok, reason} on failure; we just log
  // and move on.
  try {
    const r = await sendTelegram(text);
    if (!r.ok && r.reason !== 'no-creds') log(`[notify-fail] ${r.reason}`);
  } catch (e) { log('[notify-err]', e.message); }
}
import {
  HTF_MIN, HTF_SMA, LOOKBACK_BARS,
  RR, MAX_HOLD_MS, COOLDOWN_MS,
  FVG_BUFFER_PCT, TOUCH_TOLERANCE_PCT, MIN_FVG_BODY_PCT, MIN_STOP_PCT,
  RISK_PCT_DEFAULT, RISK_PCT_TOP_2, RISK_PCT_BEST,
  SIDE_GATE_MIN_SAMPLE, SIDE_GATE_DOWNSHIFT_R, SIDE_GATE_BLOCK_R,
  SIDE_GATE_SAMPLE_SINCE_TS,
  SKIP_SESSIONS,
} from './trader-config.mjs';

const SIGNAL_CONFIG = {
  HTF_SMA, FVG_BUFFER_PCT, TOUCH_TOLERANCE_PCT,
  MIN_FVG_BODY_PCT, MIN_STOP_PCT, RR,
};

// ──────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────
const API_KEY = process.env.MEXC_API_KEY;
const API_SECRET = process.env.MEXC_API_SECRET;
if (!API_KEY || !API_SECRET) {
  console.error('FATAL: MEXC_API_KEY / MEXC_API_SECRET not set'); process.exit(2);
}

// Live symbol set. Re-screened 2026-05-27 against the realistic-TTL
// backtest at 365d of 5m bars (10 candidates with full-year fixtures).
// SOL and XRP are still the only symbols net-positive over a full
// market cycle; every other large-cap bleeds once order-TTL is modelled.
//
//   symbol   365d realistic R/trade   365d realistic net$
//   SOL          +0.073R                 +$8.31
//   XRP          +0.113R                +$15.78
//   BTC          -0.023R                 -$1.11   (was -0.086R; drifted flat)
//   DOGE         -0.253R                -$34.13
//   DOT          -0.045R                 -$4.56
//   LINK         -0.060R                 -$8.86
//   LTC          -0.232R                -$36.45
//   NEAR         -0.172R                -$16.29
//   SUI          -0.354R                -$51.14
//
// Meme/AI-narrative perps (PEPE, WIF, BONK, etc.) are excluded upstream
// in tests/dump-fixtures.mjs — their wick patterns over-trigger
// MIN_STOP_PCT and the strategy has no edge there.
//
// Aggregate SOL+XRP, 365d realistic-TTL: ~+$24.09 net on $50/year (446
// trades, ~+0.095R/trade). 30d 1m-bar TTL diagnostic
// (tests/ttl-resolution-diag.mjs) shows the coarse 5m-bracket gate
// over-counts fills by ~17-19% for SOL/XRP — truthful projection is
// closer to ~+$20/year. Small edge, but the only configuration that
// survives 365d screening. Re-evaluate after ~30 clean live trades
// (post-#221 stop-verify fix) to see whether reality matches.
//
// Per-asset strategy notes live in ./docs/strategies/<SYMBOL>.md — what
// setup is firing, knob values, backtest numbers, why this asset. Adding
// a symbol here without creating its .md file (or vice versa) is a bug.
const SYMBOLS = ['SOL_USDT', 'XRP_USDT'];
// Methodology knobs (RR, MAX_HOLD_MS, MIN_FVG_BODY_PCT, risk tiers, the
// 2L/3L/5L loss-streak cascade, etc.) live in ./trader-config.mjs so the
// proof harness (tests/backtest-azc-trader.mjs) imports the same values
// and cannot drift from production. Only operational constants stay here.
const TF_MIN              = 5;
const HTF_LOOKBACK        = 24;
const LEVERAGE            = 10;
const MAX_OPEN_POSITIONS  = 1;
const TICK_MS             = 15_000;
const POSITION_POLL_MS    = 5_000;
const MAKER_ORDER_TTL_MS  = 180_000;
// Wallet balance refresh cadence — keeps the dashboard chip live without
// pounding the signed-API rate limit. 30s is well below the 5s position
// poll so the freshness is always within one tick of the chart update.
const WALLET_REFRESH_MS   = 30_000;

// Killzone windows live in ./trader-killzones.mjs so tests can pull pure
// helpers without importing this file (which exits at load when MEXC creds
// are missing). 24/7 firing remains active — the killzone label is only
// recorded on every fire (postmortem `session` field) and used by the 3-loss
// pause to find the next session boundary.
const VALID_SENTIMENT_MODES = new Set(['shadow', 'live', 'off']);
const SENTIMENT_GATE_MODE = (() => {
  const v = String(process.env.SENTIMENT_GATE_MODE || 'shadow').toLowerCase();
  if (VALID_SENTIMENT_MODES.has(v)) return v;
  console.warn(`[sentiment-config] unknown SENTIMENT_GATE_MODE='${v}', falling back to 'off'`);
  return 'off';
})();

const LEARN_ROOT = path.resolve('./trade-learnings');
const STATE_DIR  = path.resolve('./.trader-state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const STOP_FLAG  = path.join(STATE_DIR, 'stop.flag');
const EVENTS_FILE = path.join(STATE_DIR, 'trader-events.jsonl');

// ──────────────────────────────────────────────────────────────────
// Runtime state
// ──────────────────────────────────────────────────────────────────
const cooldownUntil = new Map();      // symbol → ts ms when cooldown expires
const closedPosIds = new Map();       // posId → ts booked closed; blocks re-adopt of a flapping MEXC position
const CLOSED_POSID_TTL_MS = 3_600_000;
const metaCache = new Map();          // symbol → { contractSize, minVol, priceUnit } (cached)
let tradesToday = 0;
let dailyPnlUsd = 0;
let dailyResetAt = nextUtcMidnight();
let pendingOrder = null;              // { symbol, orderId, expiresAt }
let lastError = null;
let lastCycleAt = 0;
let cycleCount = 0;
let lastScanSummary = null;           // top candidates from last scan, surfaced in state.json
let sentimentShadowSkips24h = 0;
let sentimentLiveSkips24h = 0;
let lastSentimentSnapshot = null;
let lastSentimentAt = null;
let lastFireSentiment = null;   // { orderId, label, source, agree, shadowWouldSkip } — survives close so the relay can stitch into the post-mortem
// Cached MEXC futures wallet balance (USDT availableBalance). Refreshed
// every WALLET_REFRESH_MS so the dashboard can render the live wallet
// chip without each browser making a signed call. null = never fetched.
let walletUsdt = null;
let walletUsdtAt = 0;
let walletUsdtError = null;
let gateCutoffLogged = false;         // log SIDE_GATE_SAMPLE_SINCE_TS filter once per boot
// Side-aware live drift: { long: {n, expR, status}, short: {n, expR, status} }
//   status ∈ 'enabled' | 'downshifted' | 'blocked'
// Default both 'enabled' (backtest says both sides profitable). The gate
// only activates after SIDE_GATE_MIN_SAMPLE live trades on that side.
let sideStatus = {
  long:  { n: 0, expR: null, status: 'enabled', reason: 'below min sample — backtest +0.182R/trade' },
  short: { n: 0, expR: null, status: 'enabled', reason: 'below min sample — backtest +0.283R/trade' },
};
// Session-aware live drift — same pattern as sideStatus but keyed by
// killzone session label (asia / london / ny-am / late-ny / off). Acts
// on the same SIDE_GATE_* thresholds. Backtest references load from
// tests/baselines/current.json at startup — re-blessing the baseline
// (npm run eval:bless) keeps the gate's expectations honest. 24/7
// firing remains the default; this only acts after min-sample drift.
let sessionStatus = {};
// Per-symbol-side live drift — keyed "SYMBOL:long" / "SYMBOL:short".
// Lets a healthy XRP:short keep firing while SOL:short downshifts or
// blocks. Filtering happens at candidate-list level inside
// decideFireAction, so a blocked combo never wins over a healthy peer.
let symbolSideStatus = {};
// Per-session-side live drift — keyed "<session>:long" / "<session>:short".
// 365d backtest: off+bull -0.019R, london+bull -0.053R, ny-am+bull -0.004R
// while every BEAR bucket is profitable. Same filter shape as
// symbolSideStatus so a blocked off:long never masks a healthy off:short.
let sessionSideStatus = {};

function nextUtcMidnight() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

function maybeRollDay() {
  if (Date.now() >= dailyResetAt) {
    log(`[day-roll] resetting daily counters (was trades=${tradesToday} pnl=${dailyPnlUsd.toFixed(4)})`);
    tradesToday = 0;
    dailyPnlUsd = 0;
    sentimentShadowSkips24h = 0;
    sentimentLiveSkips24h = 0;
    dailyResetAt = nextUtcMidnight();
  }
}

function log(...args) {
  console.log(new Date().toISOString(), '·', ...args);
}

// Recompute LONG/SHORT live expectancy from the post-mortem folder.
// Called on startup and after every trade close so the gate reacts to
// drift within ~1 close instead of accumulating losses silently. Pure
// read + group — no exchange calls.
// Loaded once at startup from tests/baselines/current.json — backtest
// per-session AND per-side expectancyR are the reference values for
// "is live drifting?" log lines. Threshold semantics still use the
// SIDE_GATE_* absolute bands (live expR vs -0.30 / -0.10); the backtest
// numbers only colour the reason string. `npm run eval:bless` updates
// both via a single write — no more duplicated hardcoded refs.
let backtestSessionRef = {};
let backtestSideRef = { long: 0.182, short: 0.283 };
async function loadBacktestRefs() {
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(path.resolve('./tests/baselines/current.json'), 'utf8');
    const parsed = JSON.parse(raw);
    backtestSessionRef = parsed.bySession || {};
    const longRef  = parsed?.sides?.long?.expectancyR;
    const shortRef = parsed?.sides?.short?.expectancyR;
    backtestSideRef = {
      long:  Number.isFinite(longRef)  ? longRef  : backtestSideRef.long,
      short: Number.isFinite(shortRef) ? shortRef : backtestSideRef.short,
    };
  } catch (e) {
    log('[backtest-refs-boot] no baseline at tests/baselines/current.json — reason strings will use fallback refs');
  }
}

const GATE_THRESHOLDS = {
  minSample: SIDE_GATE_MIN_SAMPLE,
  downshiftR: SIDE_GATE_DOWNSHIFT_R,
  blockR: SIDE_GATE_BLOCK_R,
};

async function recomputeSideStatus() {
  let trades;
  try { trades = await collectTrades(LEARN_ROOT); }
  catch (e) { log('[side-stats] collect failed', e.message); return; }
  if (SIDE_GATE_SAMPLE_SINCE_TS > 0) {
    const before = trades.length;
    trades = trades.filter(t => Number(t.ts) >= SIDE_GATE_SAMPLE_SINCE_TS);
    const filtered = before - trades.length;
    if (filtered > 0 && !gateCutoffLogged) {
      log(`[gate-cutoff] excluding ${filtered} pre-${new Date(SIDE_GATE_SAMPLE_SINCE_TS).toISOString()} trades from gate sample (bug-era pre-#221)`);
      gateCutoffLogged = true;
    }
  }
  const longTrades  = trades.filter(t => String(t.side).toUpperCase() === 'LONG');
  const shortTrades = trades.filter(t => String(t.side).toUpperCase() === 'SHORT');
  const longSum  = summarise(longTrades);
  const shortSum = summarise(shortTrades);
  const tagBacktest = (gate, ref) => ({ ...gate, reason: `${gate.reason} (backtest ${ref >= 0 ? '+' : ''}${ref.toFixed(3)}R/trade)` });
  const next = {
    long:  tagBacktest(decideGate(longSum,  GATE_THRESHOLDS), backtestSideRef.long),
    short: tagBacktest(decideGate(shortSum, GATE_THRESHOLDS), backtestSideRef.short),
  };
  if (next.long.status !== sideStatus.long.status) {
    log(`[side-gate] LONG: ${sideStatus.long.status} → ${next.long.status} (${next.long.reason})`);
    notify(fmtDriftAlert({ gate: 'side', key: 'LONG', fromStatus: sideStatus.long.status, toStatus: next.long.status, reason: next.long.reason }));
  }
  if (next.short.status !== sideStatus.short.status) {
    log(`[side-gate] SHORT: ${sideStatus.short.status} → ${next.short.status} (${next.short.reason})`);
    notify(fmtDriftAlert({ gate: 'side', key: 'SHORT', fromStatus: sideStatus.short.status, toStatus: next.short.status, reason: next.short.reason }));
  }
  sideStatus = next;

  // Same logic, keyed by session label. Buckets the trader writes via
  // currentKillzoneName(): asia / london / ny-am / late-ny / off.
  const sessionGroups = groupBySession(trades);
  const nextSessionStatus = {};
  for (const [label, group] of Object.entries(sessionGroups)) {
    const sum = summarise(group);
    const ref = backtestSessionRef[label]?.expectancyR;
    const gate = decideGate(sum, GATE_THRESHOLDS);
    nextSessionStatus[label] = Number.isFinite(ref)
      ? { ...gate, reason: `${gate.reason} (backtest ${ref >= 0 ? '+' : ''}${ref.toFixed(3)}R/trade)` }
      : gate;
  }
  for (const [label, state] of Object.entries(nextSessionStatus)) {
    const prev = sessionStatus[label]?.status;
    if (prev !== state.status) {
      log(`[session-gate] ${label}: ${prev || '(new)'} → ${state.status} (${state.reason})`);
      // Quiet the noise from initial "(new) → enabled" on first compute —
      // only ping the operator on real transitions.
      if (prev) {
        notify(fmtDriftAlert({ gate: 'session', key: label, fromStatus: prev, toStatus: state.status, reason: state.reason }));
      }
    }
  }
  sessionStatus = nextSessionStatus;

  // Same logic, keyed by "SYMBOL:long" / "SYMBOL:short". Seed every
  // configured SYMBOL × side pair so the dashboard has a stable shape
  // before the first trade lands.
  const nextSymbolSideStatus = {};
  for (const sym of SYMBOLS) {
    for (const sd of ['long', 'short']) {
      const group = trades.filter(t =>
        String(t.symbol) === sym && String(t.side).toUpperCase() === sd.toUpperCase());
      nextSymbolSideStatus[`${sym}:${sd}`] = decideGate(summarise(group), GATE_THRESHOLDS);
    }
  }
  for (const [k, state] of Object.entries(nextSymbolSideStatus)) {
    const prev = symbolSideStatus[k]?.status;
    if (prev !== state.status) {
      log(`[symbol-side-gate] ${k}: ${prev || '(new)'} → ${state.status} (${state.reason})`);
      if (prev) {
        notify(fmtDriftAlert({ gate: 'symbol-side', key: k, fromStatus: prev, toStatus: state.status, reason: state.reason }));
      }
    }
  }
  symbolSideStatus = nextSymbolSideStatus;

  // Same logic, keyed by "<session>:long" / "<session>:short". Sessions
  // come from the live trade records; bucket is created on first
  // observed (session, side) pair rather than seeded with all combos so
  // dormant pairs (asia:long with 0 samples) don't clutter trader-state.
  const nextSessionSideStatus = {};
  for (const t of trades) {
    const sess = (t.session && t.session !== 'no-killzone') ? t.session : 'off';
    const sd   = String(t.side).toUpperCase() === 'LONG' ? 'long' : 'short';
    const key  = `${sess}:${sd}`;
    (nextSessionSideStatus[key] ||= []).push(t);
  }
  const nextSessionSideGates = {};
  for (const [key, group] of Object.entries(nextSessionSideStatus)) {
    nextSessionSideGates[key] = decideGate(summarise(group), GATE_THRESHOLDS);
  }
  for (const [k, state] of Object.entries(nextSessionSideGates)) {
    const prev = sessionSideStatus[k]?.status;
    if (prev !== state.status) {
      log(`[session-side-gate] ${k}: ${prev || '(new)'} → ${state.status} (${state.reason})`);
      if (prev) {
        notify(fmtDriftAlert({ gate: 'session-side', key: k, fromStatus: prev, toStatus: state.status, reason: state.reason }));
      }
    }
  }
  sessionSideStatus = nextSessionSideGates;
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
    riskTiers: { default: RISK_PCT_DEFAULT, top2: RISK_PCT_TOP_2, best: RISK_PCT_BEST },
    sideStatus,
    sessionStatus,
    symbolSideStatus,
    sessionSideStatus,
    cooldownUntil: Object.fromEntries([...cooldownUntil.entries()]),
    closedPosIds: Object.fromEntries([...closedPosIds.entries()]),
    pendingOrder,
    // Persist the full context so a restart mid-trade can rehydrate and
    // still write a correct post-mortem on close. The dashboard already
    // tolerates the extra fields — JS object access is lax.
    positionContext: positionContext || null,
    lastScanSummary,
    lastError,
    walletUsdt,
    walletUsdtAt,
    walletUsdtError,
    sentimentGate: {
      mode: SENTIMENT_GATE_MODE,
      lastSnapshotAt: lastSentimentAt,
      lastLabel: lastSentimentSnapshot?.label || null,
      lastSource: lastSentimentSnapshot?.source || null,
      shadowWouldSkipCount24h: sentimentShadowSkips24h,
      liveSkipCount24h: sentimentLiveSkips24h,
    },
    lastFireSentiment,
    // Inspect from prod: curl https://tv-relay.srv1688368.hstgr.cloud/trader-state | jq .sentimentGate
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
  const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
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
  const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  const j = await r.json();
  const d = j.data;
  if (!d) return null;
  const x = Array.isArray(d) ? d[0] : d;
  return { lastPrice: +x.lastPrice, bid1: +x.bid1, ask1: +x.ask1 };
}

async function fetchContractMeta(symbol) {
  const url = `https://contract.mexc.com/api/v1/contract/detail?symbol=${symbol}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
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

// Refresh the cached MEXC futures wallet figure when the last fetch is
// older than WALLET_REFRESH_MS. Called from the main loop so the value
// in state.json — which the dashboard polls — never drifts more than one
// cycle behind the exchange.
async function maybeRefreshWallet(now = Date.now()) {
  if (!shouldRefreshWallet(walletUsdtAt, now, WALLET_REFRESH_MS)) return;
  try {
    walletUsdt = await getAccountUsdt();
    walletUsdtAt = Date.now();
    walletUsdtError = null;
  } catch (e) {
    walletUsdtError = e.message || String(e);
  }
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
// ──────────────────────────────────────────────────────────────────
// Trade lifecycle
// ──────────────────────────────────────────────────────────────────
let positionContext = null;  // remembers { symbol, side, entry, sl, tp, qty, lev, posId, openedAt }

// Per-symbol wrapper around the pure setup builder in trader-signal.mjs.
// Owns the I/O (klines, ticker, contract meta), cooldown gate, and the
// contract-sizing math that lives outside the shared signal.
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

  const price = ticker.lastPrice;
  const setup = buildSetup({ bars5m, htfBars, price, config: SIGNAL_CONFIG });
  if (setup.skip) return { ...setup, symbol };

  const sideOpen = setup.fvg.dir === 'bull' ? 1 : 3;
  const stopDistUsdPerContract = meta.contractSize * setup.stopDist;

  return {
    symbol,
    fvg: setup.fvg,
    htfDir: setup.htfDir,
    price,
    entry: setup.entry,
    sl: setup.sl,
    tp: setup.tp,
    sideOpen,
    stopDistUsdPerContract,
    meta,
    distPct: setup.distPct,
  };
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
  // Persist the scan to a ring-buffered JSONL so the dashboard can
  // replay the last N decisions. Best-effort — disk failures must not
  // break the trader's main loop. kind:'scan' lets the dashboard
  // distinguish per-cycle scans from kind:'decision' top-level outcomes.
  try {
    await appendScanEvent(EVENTS_FILE, {
      ts: Date.now(),
      cycle: cycleCount,
      kind: 'scan',
      scan: lastScanSummary,
    });
  } catch (e) { log('[events-append-err]', e.message); }
  return results;
}

async function tryFire() {
  maybeRollDay();
  const results = await scanAllSymbols();

  // No history-based halts. The consecutive-loss cascade (2L/3L/5L) was
  // removed — drift gates (side + session, ~20-trade min sample) catch
  // real edge degradation without stopping the bot on small-sample noise.
  //
  // No killzone gate either — backtest comparison showed 24/7 firing gives
  // ~+80% more trades and +61% more total R over 90d vs killzone-gated.
  // The killzone label is still recorded on every fire (session field in
  // the postmortem) for analysis.
  //
  // Pure decision logic lives in trader-fire-decision.mjs so every gate
  // path is testable without mocking MEXC. This wrapper does the I/O:
  // scan, position check, decide, log, size, place order.
  if (pendingOrder) return { skip: 'pending-order' };  // short-circuit the exchange call

  const openPositions = await getOpenPositions();
  const valid = results.filter(r => !r.skip);

  let sentimentSnapshot = null;
  if (SENTIMENT_GATE_MODE !== 'off' && valid.length) {
    // Locally pick the top candidate using the same comparator
    // decideFireAction uses, so we only fetch sentiment for the one
    // symbol we're about to vote on. Duplication is two lines.
    const top = [...valid].sort((a, b) => a.distPct - b.distPct)[0];
    const ticker = String(top.symbol || '').split('_')[0];
    if (ticker) {
      try {
        sentimentSnapshot = await getSentiment({ ticker });
        if (sentimentSnapshot) {
          lastSentimentSnapshot = sentimentSnapshot;
          lastSentimentAt = sentimentSnapshot.fetchedAtMs;
        }
      } catch (e) {
        log(`[sentiment-err] ${e.message}`);
      }
    }
  }

  const decision = decideFireAction({
    candidates: valid,
    pendingOrder: false,
    openPositions: openPositions.length,
    maxOpenPositions: MAX_OPEN_POSITIONS,
    sideStatus,
    sessionStatus,
    symbolSideStatus,
    sessionSideStatus,
    currentSession: currentKillzoneName() || 'off',
    riskTiers: { default: RISK_PCT_DEFAULT, top2: RISK_PCT_TOP_2, best: RISK_PCT_BEST },
    sentimentSnapshot,
    sentimentGateMode: SENTIMENT_GATE_MODE,
    skipSessions: SKIP_SESSIONS,
  });

  if (decision.skip === 'sentiment-disagree') {
    sentimentLiveSkips24h += 1;
    log(`[sentiment-veto] ${decision.detail} (source=${decision.source})`);
  } else if (decision.shadow?.wouldSkip) {
    sentimentShadowSkips24h += 1;
    log(`[sentiment-shadow] would skip: ${decision.shadow.label} vs ${decision.pick.fvg.dir} (source=${decision.shadow.source})`);
  }

  if (decision.action === 'skip') {
    return decision.detail
      ? { skip: decision.skip, detail: decision.detail }
      : { skip: decision.skip };
  }

  const { pick, tier, riskPct, sideKey, sessionKey, downshifts, candidateCount } = decision;
  for (const d of downshifts) {
    if (d.source === 'side') {
      log(`[side-downshift] ${d.key.toUpperCase()} live drift → halving risk to ${(riskPct*100).toFixed(2)}% (${d.reason})`);
    } else if (d.source === 'symbol-side') {
      log(`[symbol-side-downshift] ${d.key} live drift → halving risk to ${(riskPct*100).toFixed(2)}% (${d.reason})`);
    } else if (d.source === 'session-side') {
      log(`[session-side-downshift] ${d.key} live drift → halving risk to ${(riskPct*100).toFixed(2)}% (${d.reason})`);
    } else {
      log(`[session-downshift] ${d.key} live drift → halving risk to ${(riskPct*100).toFixed(2)}% (${d.reason})`);
    }
  }

  const equity = await getAccountUsdt();
  const sized = sizeTradeByRiskAndMargin({
    balance: equity,
    riskPct,
    leverage: LEVERAGE,
    entry: pick.entry,
    stopDistUsdPerContract: pick.stopDistUsdPerContract,
    contractSize: pick.meta.contractSize,
    minVol: pick.meta.minVol,
  });
  if (sized.reason) {
    return {
      skip: sized.reason,
      detail: `equity=${equity.toFixed(4)} entry=${pick.entry} minVol=${pick.meta.minVol} maxQty=${sized.maxQtyByMargin}`,
      symbol: pick.symbol,
    };
  }
  const qty = sized.qty;

  // Snap to MEXC's priceUnit grid and strip JS-float junk digits.
  // Without the .toFixed(decimals) MEXC rejects with code 2015 (e.g.
  // 0.10965 → 0.10965000000000001 after the round/multiply round-trip).
  const priceDecimals = (String(pick.meta.priceUnit).split('.')[1] || '').length;
  const snap = v => Number((Math.round(v / pick.meta.priceUnit) * pick.meta.priceUnit).toFixed(priceDecimals));
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
  const riskUsd = pick.stopDistUsdPerContract * qty;
  log(`[fire] ${pick.symbol} ${pick.fvg.dir.toUpperCase()} tier=${tier} htf=${pick.htfDir} qty=${qty} entry=${entry} sl=${slSnap} tp=${tpSnap} risk≈$${riskUsd.toFixed(3)} (${(riskPct*100).toFixed(1)}%) cand=${candidateCount}/${SYMBOLS.length}`);
  const r = await placeOrder(body);
  if (!r.json || r.json.success !== true) {
    return { skip: 'mexc-rejected', detail: JSON.stringify(r.json || r.raw).slice(0, 200), symbol: pick.symbol };
  }
  notify(fmtFireAlert({
    symbol: pick.symbol, dir: pick.fvg.dir, tier,
    entry, sl: slSnap, tp: tpSnap,
    riskUsd, riskPct,
    candidateCount, totalSymbols: SYMBOLS.length,
  }));
  const orderId = r.json.data;
  pendingOrder = { symbol: pick.symbol, orderId, expiresAt: Date.now() + MAKER_ORDER_TTL_MS };
  positionContext = {
    symbol: pick.symbol, dir: pick.fvg.dir, side: pick.sideOpen, entry, sl: slSnap, tp: tpSnap,
    qty, lev: LEVERAGE, contractSize: pick.meta.contractSize, openedAt: Date.now(),
    // Carry the full contract meta — panicCloseLong needs priceUnit to
    // snap its limit price; without it the close goes out as NaN and
    // MEXC rejects with code 2007 "Order price error".
    meta: pick.meta,
    orderId, fvgFormedAt: pick.fvg.formedAt, htfDir: pick.htfDir,
    // Snapshot the full decision context at fire-time so the post-mortem
    // file written on close has the WHY of the trade, not just the WHAT.
    tier, riskPct, priceAtCall: pick.price,
    distPct: pick.distPct, fvgBody: pick.fvg.body, fvgBodyPct: pick.fvg.body / pick.price,
    session: currentKillzoneName(),
    sentiment: sentimentSnapshot
      ? {
          label: sentimentSnapshot.label,
          source: sentimentSnapshot.source,
          agree: !(decision.shadow?.wouldSkip),
          shadowWouldSkip: !!decision.shadow?.wouldSkip,
        }
      : null,
  };
  lastFireSentiment = positionContext.sentiment
    ? { orderId, ...positionContext.sentiment }
    : null;
  return { fired: true, orderId, symbol: pick.symbol, entry, sl: slSnap, tp: tpSnap };
}

async function watchPendingOrder() {
  if (!pendingOrder) return;
  if (Date.now() >= pendingOrder.expiresAt) {
    const expiredSymbol = pendingOrder.symbol;
    const expiredOrderId = pendingOrder.orderId;
    log(`[ttl] cancelling unfilled order ${expiredOrderId} for ${expiredSymbol}`);
    try { await cancelOrder(expiredOrderId); } catch (e) { /* swallow */ }
    // Cancel race — MEXC's "cancel succeeded" response doesn't prove the
    // order didn't fill in flight. Check open positions before clearing
    // context, otherwise we end up with an orphan position the bot
    // doesn't monitor (happened to SUI on 2026-05-25).
    try {
      const ps = await getOpenPositions();
      const pos = ps.find(p => p.symbol === expiredSymbol);
      if (pos && positionContext && positionContext.orderId === expiredOrderId) {
        log(`[ttl-race] order ${expiredOrderId} filled during cancel — promoting ${expiredSymbol} pos=${pos.positionId} (avgPx=${pos.holdAvgPrice})`);
        positionContext.posId = pos.positionId;
        // Sync the actual filled size — a partial fill leaves ctx.qty at the
        // requested amount, which would mis-size both panic-close and P&L.
        if (Number(pos.holdVol) > 0) positionContext.qty = Number(pos.holdVol);
        positionContext.filledAt = Date.now();
        pendingOrder = null;
        return;  // hand off to normal monitoring loop
      }
    } catch (e) { log('[ttl-race-check-fail]', e.message); }
    pendingOrder = null;
    positionContext = null;
    return;
  }
  // If a position appeared, the order filled — promote. Guard the lookup:
  // an unguarded throw here propagates to the main loop and a filled order
  // never gets promoted to a posId, stranding the position. Returning keeps
  // pendingOrder set so the next cycle retries the check.
  let ps;
  try { ps = await getOpenPositions(); }
  catch (e) { log('[fill-check-fail]', e.message); return; }
  const pos = ps.find(p => p.symbol === pendingOrder.symbol);
  if (pos && positionContext) {
    log(`[filled] ${pendingOrder.symbol} pos=${pos.positionId} avgPx=${pos.holdAvgPrice}`);
    positionContext.posId = pos.positionId;
    // Sync actual filled size (see ttl-race path) — feeds panic-close + P&L.
    if (Number(pos.holdVol) > 0) positionContext.qty = Number(pos.holdVol);
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
//
// Retries: the plan-order endpoint can lag the fill by a couple of
// seconds — observed on 2026-05-25 where every fill triggered a false
// panic-close attempt because the plan list hadn't propagated yet. Poll
// up to 5×2s before giving up.
async function verifyExchangeStopOrPanicClose(pos, ctx, retries = 5, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const r = await mexcSigned({
      path: '/api/v1/private/stoporder/list/orders',
      method: 'GET',
      params: { symbol: ctx.symbol, page_num: 1, page_size: 20 },
    });
    const plans = Array.isArray(r.json?.data?.resultList) ? r.json.data.resultList
                : Array.isArray(r.json?.data) ? r.json.data : [];
    // MEXC's stoporder/list response uses stopLossPrice/takeProfitPrice
    // on the per-position TP/SL plan; there is no triggerPrice field.
    // A guard is "real" only if it belongs to THIS position and is
    // still active (state===1 = untriggered; isFinished===0 means the
    // same on rows that omit state). Without these filters we accept
    // historical, cancelled, or unrelated plans and never panic-close —
    // strictly worse. Without the right field name we accept nothing
    // and panic-close every fill — also strictly worse. Both matter.
    const hasGuard = plans.some(p => {
      if (String(p.positionId || '') !== String(ctx.posId || '')) return false;
      const stateOk = p.state === 1 || p.isFinished === 0;
      if (!stateOk) return false;
      const sl = +p.stopLossPrice;
      if (!isFinite(sl) || sl <= 0) return false;
      return ctx.dir === 'bull' ? sl < ctx.entry : sl > ctx.entry;
    });
    if (hasGuard) {
      log(`[stop-verify-ok] ${ctx.symbol} — ${plans.length} plan(s), guard present (attempt ${attempt}/${retries})`);
      return;
    }
    if (attempt < retries) {
      await sleep(delayMs);
    }
  }
  log(`[stop-verify-FAIL] ${ctx.symbol} pos=${ctx.posId} — no attached stop after ${retries} attempts. PANIC CLOSE.`);
  await panicCloseLong(ctx);
}

async function panicCloseLong(ctx) {
  // Market-close. Side 4 = close long, side 2 = close short.
  const closeSide = ctx.dir === 'bull' ? 4 : 2;
  // Close the LIVE position size, not ctx.qty — a partial fill or top-up can
  // leave ctx.qty stale, and MEXC rejects a close with the wrong volume. If
  // the position is already gone, bail rather than fire a close order into
  // a flat book.
  let vol = ctx.qty;
  if (ctx.posId) {
    try {
      const ps = await getOpenPositions();
      const live = ps.find(p => String(p.positionId) === String(ctx.posId));
      if (!live) { log(`[panic-close-skip] ${ctx.symbol} pos=${ctx.posId} already closed`); return; }
      if (Number(live.holdVol) > 0) vol = Number(live.holdVol);
    } catch (e) { log('[panic-close-vol-fail]', e.message); /* fall back to ctx.qty */ }
  }
  const ticker = await fetchTicker(ctx.symbol);
  // priceUnit defensively pulled from ctx.meta OR a fresh meta fetch —
  // ctx.meta is now stashed at fire-time, but if anything ever leaves
  // it undefined again we want a real number, not NaN.
  const priceUnit = ctx.meta?.priceUnit
    || metaCache.get(ctx.symbol)?.priceUnit
    || (await fetchContractMeta(ctx.symbol).catch(() => null))?.priceUnit;
  if (!isFinite(+priceUnit) || +priceUnit <= 0) {
    log(`[panic-close-abort] ${ctx.symbol} — cannot resolve priceUnit, leaving position to MEXC plan SL/TP`);
    return;
  }
  const px = ctx.dir === 'bull' ? ticker.bid1 - priceUnit * 5 : ticker.ask1 + priceUnit * 5;
  const decimals = (String(priceUnit).split('.')[1] || '').length;
  const snapPx = Number((Math.round(px / priceUnit) * priceUnit).toFixed(decimals));
  const body = {
    symbol: ctx.symbol,
    price: snapPx,
    vol,
    leverage: ctx.lev,
    side: closeSide,
    type: 1,            // plain limit, fills as taker immediately
    openType: 1,
  };
  const r = await placeOrder(body);
  if (r.json?.success === true) {
    log(`[panic-close] ${ctx.symbol} side=${closeSide} qty=${vol} → placed orderId=${r.json.data}`);
    return;
  }
  // Rejected — the position is still open and may be naked at 10x. Escalate
  // loudly so the operator can close by hand; do not silently swallow.
  const detail = `${r.status} ${JSON.stringify(r.json || {}).slice(0, 140)}`;
  log(`[panic-close-REJECTED] ${ctx.symbol} side=${closeSide} qty=${vol} → ${detail}`);
  notify(`🚨 PANIC-CLOSE REJECTED — ${ctx.symbol} ${ctx.dir} qty=${vol} may be NAKED. Close manually. ${detail}`);
}

// Once a position is open, MEXC manages the SL/TP. When the position
// disappears from open_positions, look up the fill history to compute the
// outcome and write a learnings file.
// Adopt an open MEXC position the bot didn't fire (Force Fire / Stage @
// FVG / direct exchange click). Returns true if a positionContext was
// set. Best-effort: if the plan-order or meta fetches fail, we still
// adopt with nulls so close-path P&L lands in the manual learnings.
async function tryAdoptOrphan() {
  let ps;
  try { ps = await getOpenPositions(); }
  catch (e) { log('[orphan-scan-err]', e.message); return false; }
  if (!ps?.length) return false;
  const pos = ps[0];

  // A posId we already booked closed must not be re-adopted. MEXC flaps a
  // closing position in and out of open_positions for minutes after the stop
  // fills; without this the loop re-adopts and re-books the same loss.
  if (isReadoptBlocked(pos.positionId, closedPosIds, Date.now(), CLOSED_POSID_TTL_MS)) {
    log(`[orphan-skip-closed] ${pos.symbol} pos=${pos.positionId} already reconciled — exchange flap, not re-adopting`);
    return false;
  }

  let planOrders = [];
  try {
    const r = await mexcSigned({
      path: '/api/v1/private/stoporder/list/orders',
      method: 'GET',
      params: { symbol: pos.symbol, page_num: 1, page_size: 20 },
    });
    planOrders = Array.isArray(r.json?.data?.resultList) ? r.json.data.resultList
               : Array.isArray(r.json?.data) ? r.json.data : [];
  } catch (e) { log('[orphan-plan-err]', e.message); }

  let contractMeta = metaCache.get(pos.symbol) || null;
  if (!contractMeta) {
    try { contractMeta = await fetchContractMeta(pos.symbol); metaCache.set(pos.symbol, contractMeta); }
    catch (e) { log('[orphan-meta-err]', e.message); }
  }

  const ctx = buildOrphanContext({ pos, planOrders, contractMeta });
  if (!ctx) { log(`[orphan-skip] ${pos.symbol} pos=${pos.positionId} unusable shape`); return false; }
  positionContext = ctx;
  log(`[orphan-adopt] ${ctx.symbol} ${ctx.dir} pos=${ctx.posId} entry=${ctx.entry} sl=${ctx.sl ?? '?'} tp=${ctx.tp ?? '?'} qty=${ctx.qty}`);
  await writeState();
  return true;
}

async function reconcileClosedPosition() {
  if (!positionContext || !positionContext.posId) return;
  const ps = await getOpenPositions();
  const stillOpen = ps.find(p => p.positionId === positionContext.posId);
  if (stillOpen) return;

  const ctx = positionContext;

  // Fetch the close/open fills BEFORE mutating any state. If this throws
  // (network/API), bail with positionContext intact and retry next cycle —
  // rather than booking the trade (tradesToday++, closedPosIds, dailyPnlUsd)
  // but then losing the post-mortem and corrupting the daily counters when
  // the fetch fails mid-reconcile. page_size 50 (was 10): on a busy symbol
  // the close can sit past row 10, and a missed close → fillPx null → zero
  // gross P&L written.
  let orders;
  try {
    const r = await mexcSigned({
      path: '/api/v1/private/order/list/history_orders',
      method: 'GET',
      params: { symbol: ctx.symbol, page_num: 1, page_size: 50 },
    });
    orders = Array.isArray(r.json?.data) ? r.json.data : [];
  } catch (e) {
    log('[reconcile-fetch-fail]', e.message);
    return;  // positionContext intact — retry next cycle
  }

  // Fills secured — now commit the close atomically (no awaits between here
  // and the P&L write that could strand half-mutated state).
  positionContext = null;
  cooldownUntil.set(ctx.symbol, Date.now() + COOLDOWN_MS);
  // Block same-cycle tryAdoptOrphan re-adopt while MEXC flaps the close.
  closedPosIds.set(String(ctx.posId), Date.now());
  for (const [pid, ts] of closedPosIds) {
    if (Date.now() - ts >= CLOSED_POSID_TTL_MS) closedPosIds.delete(pid);
  }
  tradesToday += 1;

  // Side 4 = close long, 2 = close short. Prefer the close fill tied to THIS
  // position when MEXC tags orders with positionId; fall back to the most
  // recent matching close otherwise. The bot holds one position per symbol,
  // so the fallback is unambiguous unless the user also trades it by hand.
  const closeSide = ctx.dir === 'bull' ? 4 : 2;
  const isClose = o => o.side === closeSide && o.state === 3;
  const closeOrder = orders.find(o => isClose(o) && String(o.positionId ?? '') === String(ctx.posId))
                  || orders.find(isClose);
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

  const stopDist = Number.isFinite(ctx.sl) && ctx.sl > 0
    ? Math.abs(ctx.entry - ctx.sl) : 0;
  const rMultiple = stopDist > 0 ? (pnlPriceMove / stopDist) : 0;
  const outcome = pnlUsd > 0.001 ? 'win' : pnlUsd < -0.001 ? 'loss' : 'be';
  const isOrphan = ctx.source === 'manual-orphan';
  const tag = isOrphan ? 'close-manual' : 'close';
  log(`[${tag}] ${ctx.symbol} ${ctx.dir} fill=${fillPx} pnl=$${pnlUsd.toFixed(4)} r=${rMultiple.toFixed(2)}R outcome=${outcome}`);
  notify(fmtCloseAlert({ symbol: ctx.symbol, dir: ctx.dir, outcome, rMultiple, realizedUsd: pnlUsd, holdMs }));

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
      grade: ctx.tier || (isOrphan ? 'manual' : 'auto'),
      bias: ctx.htfDir || null,
      session: ctx.session || null,
      fvgBodyPct: ctx.fvgBodyPct,
      distPct: ctx.distPct,
      confluences,
      analysis: isOrphan
        ? `Manual fire reconciled by the bot — entry/SL/TP read from MEXC position + plan orders. Outcome captured for learning; the bot did not place this trade.`
        : analysis,
      accounting: {
        grossUsd, feeUsdOpen: feeOpen, feeUsdClose: feeClose, fundingUsd: 0,
        windowsCrossed, holdMs, netUsd: pnlUsd,
      },
      orderId: ctx.orderId,
      notes: isOrphan
        ? 'Manual fire (Force Fire / Stage @ FVG / direct MEXC). Orphan-adopted by AZC trader for post-mortem only — excluded from auto-drift gates.'
        : 'AZC autonomous trader · 5m FVG retest · POST_ONLY maker · isolated 10x.',
    }, isOrphan ? path.join(LEARN_ROOT, 'manual') : LEARN_ROOT);
  } catch (e) {
    log('[learn-write-fail]', e.message);
  }
  // Manual orphan trades stay out of the bot's drift gates by design —
  // user-discretion fires would otherwise distort the auto-strategy
  // expectancy and the INSIGHTS roll-up.
  if (isOrphan) return;
  // Refresh LONG/SHORT live expectancy now that the post-mortem just landed.
  // Side gate reacts on the next fire-decision cycle.
  await recomputeSideStatus();
  // Roll up the new lesson into trade-learnings/INSIGHTS.md so the
  // dashboard reflects it on next read. Best-effort — the post-mortem
  // file is canonical, this is a derived view.
  try { await writeInsightsFile(LEARN_ROOT, { sinceTs: SIDE_GATE_SAMPLE_SINCE_TS }); }
  catch (e) { log('[insights-refresh-fail]', e.message); }
}

async function stopFlagExists() {
  try { await access(STOP_FLAG, fsConst.F_OK); return true; }
  catch { return false; }
}

async function gracefulShutdown(reason) {
  log(`[shutdown] reason=${reason}`);
  const openWarn = positionContext?.posId ? ` · OPEN ${positionContext.symbol} left at MEXC` : '';
  await notify(`🛑 AZC trader stopped · ${reason}${openWarn}`);
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
log(`[start] AZC trader online · symbols=${SYMBOLS.join(',')} · lev=${LEVERAGE}× · risk=${RISK_PCT_DEFAULT*100}/${RISK_PCT_TOP_2*100}/${RISK_PCT_BEST*100}% (def/top2/best) · drift-gated only`);
notify(`🟢 AZC trader online · ${SYMBOLS.length} symbols · drift-gated only`);
await mkdir(LEARN_ROOT, { recursive: true }).catch(() => {});
await mkdir(STATE_DIR, { recursive: true }).catch(() => {});

// Restore daily counters + per-symbol cooldowns from the previous run.
// Without this, a systemd restart silently clears trades-today, daily
// P&L, and cooldown timers — losing cross-cycle memory the operator
// can act on.
try {
  const r = await loadTraderStateFromDisk(STATE_FILE);
  if (r) {
    tradesToday  = r.tradesToday;
    dailyPnlUsd  = r.dailyPnlUsd;
    // null = the saved day rolled while we were down; keep the fresh
    // nextUtcMidnight() set at init rather than a stale past boundary.
    if (r.dailyResetAt) dailyResetAt = r.dailyResetAt;
    sentimentShadowSkips24h = r.sentimentShadowSkips24h;
    sentimentLiveSkips24h   = r.sentimentLiveSkips24h;
    for (const [sym, ts] of Object.entries(r.cooldownUntil)) cooldownUntil.set(sym, ts);
    for (const [pid, ts] of Object.entries(r.closedPosIds || {})) closedPosIds.set(pid, ts);
    log(`[restore] trades=${tradesToday} pnl=${dailyPnlUsd.toFixed(4)} cooldowns=${cooldownUntil.size} sentiment-skips=${sentimentShadowSkips24h}/${sentimentLiveSkips24h}`);

    // Reconcile persisted trade state against the live exchange. Covers both
    // a fully-open position (posId known) and the maker window where an order
    // could have filled or stayed resting while the trader was down.
    try {
      const [openPositions, openOrders] = await Promise.all([
        getOpenPositions(),
        mexcSigned({ path: '/api/v1/private/order/list/open_orders', method: 'GET' })
          .then(x => (Array.isArray(x.json?.data) ? x.json.data : []))
          .catch(() => []),
      ]);
      const d = decideRestore({ persisted: r, openPositions, openOrders, now: Date.now() });
      switch (d.kind) {
        case 'position':
          positionContext = d.positionContext;
          log(`[restore-position] ${positionContext.symbol} ${positionContext.dir} pos=${positionContext.posId} entry=${positionContext.entry} sl=${positionContext.sl} tp=${positionContext.tp}`);
          break;
        case 'position-gone':
          log(`[restore-position-gone] persisted pos=${d.posId} ${d.symbol} no longer at MEXC — dropping`);
          break;
        case 'pending-filled':
          positionContext = d.positionContext;
          log(`[restore-pending-filled] ${positionContext.symbol} maker filled during downtime — adopting as bot position pos=${positionContext.posId} entry=${positionContext.entry}`);
          break;
        case 'pending-resting':
          pendingOrder = d.pendingOrder;
          positionContext = d.positionContext;
          log(`[restore-pending] ${pendingOrder.symbol} maker #${pendingOrder.orderId} still resting — resuming watch (expires ${new Date(pendingOrder.expiresAt).toISOString()})`);
          break;
        case 'pending-gone':
          if (r.pendingOrder) log('[restore-pending-gone] persisted pending order absent at MEXC and no position — dropping');
          break;
      }
    } catch (e) { log('[restore-position-fail]', e.message); }
  }
} catch (e) { log('[restore-err]', e.message); }

// Load backtest per-session reference, then compute live drift status
// for both side and session gates so they're honest from cycle 1.
await loadBacktestRefs();
await recomputeSideStatus();
log(`[side-gate-boot] LONG=${sideStatus.long.status} (${sideStatus.long.reason}); SHORT=${sideStatus.short.status} (${sideStatus.short.reason})`);
for (const [label, state] of Object.entries(sessionStatus)) {
  log(`[session-gate-boot] ${label}=${state.status} (${state.reason})`);
}
for (const [k, state] of Object.entries(symbolSideStatus)) {
  log(`[symbol-side-gate-boot] ${k}=${state.status} (${state.reason})`);
}
for (const [k, state] of Object.entries(sessionSideStatus)) {
  log(`[session-side-gate-boot] ${k}=${state.status} (${state.reason})`);
}

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
      if (pendingOrder && String(o.orderId) === String(pendingOrder.orderId)) {
        log(`[startup-cleanup] keeping restored pending order ${o.orderId} (${o.symbol})`);
        continue;
      }
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
  try {
    // Roll the day at the TOP of every cycle, before any close is booked.
    // When this only ran on idle cycles, a position held across UTC midnight
    // closed into the OLD day's counters, which the next idle cycle then
    // reset to zero — silently losing that trade from the daily P&L.
    maybeRollDay();
    if (positionContext?.posId) {
      // Max-hold guard: market-close if a position is sitting too long.
      // 120-min cap — backtested as the sweet spot. Shorter caps (60m)
      // killed ~6pp of win rate by closing trades minutes before they
      // would have hit TP. Longer caps (180m+) showed diminishing
      // returns and started crossing funding windows more often.
      // Orphans are user-owned — never force-close them.
      if (positionContext.source !== 'manual-orphan'
          && positionContext.filledAt && (Date.now() - positionContext.filledAt) > MAX_HOLD_MS) {
        log(`[max-hold] ${positionContext.symbol} held ${Math.round((Date.now()-positionContext.filledAt)/1000/60)}m — closing`);
        try { await panicCloseLong(positionContext); } catch (e) { log('[max-hold-close-err]', e.message); }
      }
      await reconcileClosedPosition();
    }
    if (pendingOrder) {
      await watchPendingOrder();
    }
    if (!pendingOrder && !positionContext) {
      // Pick up Force Fire / Stage @ FVG / direct exchange clicks so the
      // close path writes a post-mortem to trade-learnings/manual/. When
      // adoption happens, skip the scan — the orphan is now the active
      // position and the next cycle handles monitoring + close.
      const adopted = await tryAdoptOrphan();
      if (!adopted) {
        const r = await tryFire();   // always runs scanAllSymbols inside
        if (r.skip && r.skip !== 'no-candidates') {
          log(`[skip] ${r.skip}${r.detail ? ' · ' + r.detail : ''}`);
        }
        // Persist the top-level fire decision so the dashboard can show
        // "at 11:11 fire vetoed by side-gate: LONG -0.384R/trade" instead
        // of just the latest scan snapshot. Best-effort — disk failures
        // never break the trader loop.
        try {
          await appendScanEvent(EVENTS_FILE, {
            ts: Date.now(),
            cycle: cycleCount,
            kind: 'decision',
            action: r.fired ? 'fire' : 'skip',
            vetoed_by: r.fired ? null : (r.skip || 'unknown'),
            reason: r.detail || null,
            symbol: r.symbol || null,
            ...(r.fired ? { orderId: r.orderId, entry: r.entry, sl: r.sl, tp: r.tp } : {}),
          });
        } catch (e) { log('[decision-event-err]', e.message); }
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
  await maybeRefreshWallet();
  await writeState();
  await sleep(positionContext ? POSITION_POLL_MS : TICK_MS);
}
