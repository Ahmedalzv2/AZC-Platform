import http from 'node:http';
import { readFile, stat, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLearningFile } from './trade-learnings.mjs';
import { writeInsightsFile } from './trade-insights.mjs';
import { fetchMarketContext } from './trade-context.mjs';
import { SIDE_GATE_SAMPLE_SINCE_TS } from './trader-config.mjs';
import { readTailEvents } from './trader-events.mjs';
import { summarizeShadowSignals } from './shadow-summary.mjs';
import { buildStats } from './trade-stats.mjs';
import { authedWriteWith } from './relay-auth.mjs';
import { callMexcSigned, ALLOWED_PATH_PREFIX as MEXC_ALLOWED } from './mexc-signer.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3002);
// Default loopback — when run on an exposed host, the operator must opt in
// to 0.0.0.0 explicitly (the docker container's env file does this). Prevents
// "demoing it locally" accidentally publishing the relay's write endpoints.
const host = process.env.HOST || '127.0.0.1';
// Shared token gates write endpoints. When unset, the relay prints a one-time
// warning and runs in legacy unauthenticated mode (so existing dev setups
// don't break). Production env should always set this — when set, /notify,
// /state, /auto-state POST, /learn-trade, and /actions all require the
// `X-ICT-Token` header to match.
const RELAY_TOKEN = String(process.env.ICT_RELAY_TOKEN || '').trim();
if (!RELAY_TOKEN) {
  console.warn('[relay] ICT_RELAY_TOKEN is unset — write endpoints are public. Set it in production.');
}
// MEXC server-side signing keys. When set, /mexc/signed accepts {path,
// method, body, params} from the dashboard, signs server-side, and forwards.
// Browser stops storing the secret. When unset, /mexc/signed returns 503
// and the dashboard falls back to its existing worker+browser-sign path.
const MEXC_API_KEY    = String(process.env.MEXC_API_KEY    || '').trim();
const MEXC_API_SECRET = String(process.env.MEXC_API_SECRET || '').trim();
// User's TradingView auth_token (cookie). When set, every TV WS handshake the
// relay opens identifies as that user and pulls their entitled real-time
// feeds (e.g. paid CME/FPMARKETS data) instead of the anonymous-tier feed,
// which can be 10-15min delayed for futures. Get it from a logged-in
// tradingview.com session: DevTools → Application → Cookies → auth_token.
const TV_AUTH_TOKEN = String(process.env.TV_AUTH_TOKEN || 'unauthorized_user_token').trim();
if (!MEXC_API_KEY || !MEXC_API_SECRET) {
  console.warn('[relay] MEXC_API_KEY/SECRET unset — /mexc/signed disabled. Browser signing still works via the Cloudflare worker.');
}
if (TV_AUTH_TOKEN === 'unauthorized_user_token') {
  console.warn('[relay] TV_AUTH_TOKEN unset — TV feeds will be anonymous-tier (futures may be 10-15min delayed). Set TV_AUTH_TOKEN in relay.env to your tradingview.com auth_token cookie for real-time entitlements.');
} else {
  console.log('[relay] TV_AUTH_TOKEN present — TV WS will authenticate as your user (real-time feeds per your TV subscription).');
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

// Live FPMARKETS:US100 quote via TradingView's public WebSocket — same number
// the embedded chart displays. Scanner API doesn't index FPMARKETS and Yahoo
// NQ=F is a different feed; the WS is the only way to keep the badge in sync
// with the chart. Single-shot connect-subscribe-first-quote-close, ~500ms.
async function us100PriceWS(symbol) {
  const ws = new WebSocket('wss://data.tradingview.com/socket.io/websocket', {
    headers: { 'Origin': 'https://www.tradingview.com' },
  });
  const send = (m) => {
    const s = JSON.stringify(m);
    ws.send(`~m~${s.length}~m~${s}`);
  };
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    send({ m: 'set_auth_token', p: [TV_AUTH_TOKEN] });
    send({ m: 'quote_create_session', p: ['qs_n'] });
    send({ m: 'quote_set_fields', p: ['qs_n', 'lp'] });
    send({ m: 'quote_add_symbols', p: ['qs_n', symbol] });
    const price = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('ws-timeout')), 4000);
      const re = new RegExp(`"n":"${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^}]*"lp":([0-9.]+)`);
      ws.addEventListener('message', (ev) => {
        const text = typeof ev.data === 'string' ? ev.data : ev.data.toString();
        if (text.includes('~h~')) { try { ws.send(text); } catch {} return; }
        const m = text.match(re);
        if (m && Number(m[1]) > 0) { clearTimeout(to); resolve(Number(m[1])); }
      });
      ws.addEventListener('error', () => { clearTimeout(to); reject(new Error('ws-error')); });
      ws.addEventListener('close', () => { clearTimeout(to); reject(new Error('ws-closed')); });
    });
    return { price, source: 'tv-ws:' + symbol, ts: Date.now() };
  } finally {
    try { ws.close(); } catch {}
  }
}

// Pull historical bars for FPMARKETS:US100 across the dashboard's TFs in a
// single WS connection. TV's chart WS rejects browser-origin handshakes from
// github.io, so the analysis ladder can't open these directly; relaying
// through this VPS unblocks it. Returns a map { '1m': [{t,o,h,l,c,v}, …], … }
// where t is ms (matches the Binance/MEXC kline shape _analyzeKlines expects).
const TF_RESOLUTION = {
  '1m':  '1',
  '5m':  '5',
  '15m': '15',
  '1h':  '60',
  '4h':  '240',
  '1d':  '1D',
};
async function tvBars(symbol, tfs, limit = 60) {
  const tvSymbol = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9_:.!\-]{1,64}$/.test(tvSymbol)) throw new Error('invalid-tv-symbol');
  const ws = new WebSocket('wss://data.tradingview.com/socket.io/websocket', {
    headers: { 'Origin': 'https://www.tradingview.com' },
  });
  const send = (m) => {
    const s = JSON.stringify(m);
    ws.send(`~m~${s.length}~m~${s}`);
  };
  // Length-prefixed frame splitter — TV uses `~m~N~m~payload` framing.
  function* parseFrames(buf) {
    let i = 0;
    while (i + 3 <= buf.length) {
      if (buf.substr(i, 3) !== '~m~') return;
      const end = buf.indexOf('~m~', i + 3);
      if (end === -1) return;
      const n = parseInt(buf.substring(i + 3, end), 10);
      if (!Number.isFinite(n)) return;
      const start = end + 3;
      if (start + n > buf.length) return;
      yield buf.substring(start, start + n);
      i = start + n;
    }
  }

  const sessions = {}; // csid → tf
  const out = {};      // tf → bars[]
  const pending = new Set();
  for (const tf of tfs) {
    if (!TF_RESOLUTION[tf]) continue;
    const csid = 'cs_' + tf + '_' + Math.random().toString(36).slice(2, 8);
    sessions[csid] = tf;
    pending.add(tf);
  }

  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    send({ m: 'set_auth_token', p: [TV_AUTH_TOKEN] });
    for (const [csid, tf] of Object.entries(sessions)) {
      send({ m: 'chart_create_session', p: [csid, ''] });
      send({ m: 'resolve_symbol', p: [csid, 'sym', '={"adjustment":"splits","symbol":"' + tvSymbol + '"}'] });
      send({ m: 'create_series', p: [csid, 'ser', 's1', 'sym', TF_RESOLUTION[tf], limit, ''] });
    }

    let buffer = '';
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('bars-timeout')), 8000);
      ws.addEventListener('message', (ev) => {
        const text = typeof ev.data === 'string' ? ev.data : ev.data.toString();
        buffer += text;
        // Echo heartbeat or TV drops the connection.
        if (text.includes('~h~')) { try { ws.send(text); } catch {} }
        // Walk only the COMPLETE frames currently in `buffer`; advance `buffer`
        // past the last complete frame so the next chunk continues cleanly.
        let consumed = 0;
        for (const frame of parseFrames(buffer)) {
          consumed += `~m~${frame.length}~m~${frame}`.length;
          if (!frame || frame[0] !== '{') continue;
          let msg; try { msg = JSON.parse(frame); } catch { continue; }
          if (msg.m !== 'timescale_update') continue;
          const csid = msg.p && msg.p[0];
          const sds  = msg.p && msg.p[1];
          const tf = sessions[csid];
          if (!tf || !sds) continue;
          let bars = null;
          for (const k of Object.keys(sds)) {
            if (sds[k] && Array.isArray(sds[k].s)) { bars = sds[k].s; break; }
          }
          if (!bars) continue;
          out[tf] = bars
            .map(b => ({ t: Math.round((+b.v[0]) * 1000), o: +b.v[1], h: +b.v[2], l: +b.v[3], c: +b.v[4], v: +b.v[5] }))
            .filter(k => Number.isFinite(k.c));
          pending.delete(tf);
          if (pending.size === 0) { clearTimeout(to); resolve(); }
        }
        buffer = buffer.substring(consumed);
      });
      ws.addEventListener('error', () => { clearTimeout(to); reject(new Error('ws-error')); });
      ws.addEventListener('close', () => { clearTimeout(to); reject(new Error('ws-closed')); });
    });
    return { bars: out, ts: Date.now(), source: 'tv-ws:' + tvSymbol, symbol: tvSymbol };
  } finally {
    try { ws.close(); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────
// Persistent FPMARKETS:US100 stream
// ─────────────────────────────────────────────────────────────────────
// One TV WS open for the lifetime of the relay, subscribed once to the
// quote session (live lp) and one chart session per TF (live bars). Every
// request to /us100 and /us100/bars reads the cache (~5ms) instead of
// opening a fresh TV WS handshake (~500ms). Reconnects with exponential
// backoff if TV drops the socket. One-shot path stays as cold-start /
// outage fallback below.
const US100_SYMBOL = 'FPMARKETS:US100';
const US100_TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const us100Cache = {
  price: 0,
  priceTs: 0,
  bars: {},            // tf -> [{t,o,h,l,c,v}, ...]
  barsTs: {},          // tf -> ms when last updated
  wsState: 'init',     // init|connecting|open|closed
  wsConnectedAt: 0,
  reconnectCount: 0,
};
let _us100Ws = null;
let _us100Retry = 0;
let _us100SessionMap = {};   // chart_session_id -> tf
let _us100Buf = '';           // frame-splitter buffer across chunks
const _us100Waiters = [];     // [{ predicate, resolve, timer }]

function _us100NotifyWaiters() {
  for (let i = _us100Waiters.length - 1; i >= 0; i--) {
    const w = _us100Waiters[i];
    if (w.predicate()) {
      clearTimeout(w.timer);
      _us100Waiters.splice(i, 1);
      w.resolve();
    }
  }
}

function _us100WaitFor(predicate, timeoutMs = 3500) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = _us100Waiters.findIndex(w => w.timer === timer);
      if (idx >= 0) _us100Waiters.splice(idx, 1);
      reject(new Error('us100-cache-wait-timeout'));
    }, timeoutMs);
    _us100Waiters.push({ predicate, resolve, timer });
  });
}

function* _us100Frames(buf) {
  let i = 0;
  while (i + 3 <= buf.length) {
    if (buf.substr(i, 3) !== '~m~') return;
    const end = buf.indexOf('~m~', i + 3);
    if (end === -1) return;
    const n = parseInt(buf.substring(i + 3, end), 10);
    if (!Number.isFinite(n)) return;
    const start = end + 3;
    if (start + n > buf.length) return;
    yield { frame: buf.substring(start, start + n), nextI: start + n };
    i = start + n;
  }
}

function _initUs100Stream() {
  if (us100Cache.wsState === 'connecting' || us100Cache.wsState === 'open') return;
  us100Cache.wsState = 'connecting';
  _us100SessionMap = {};
  _us100Buf = '';
  let ws;
  try {
    ws = new WebSocket('wss://data.tradingview.com/socket.io/websocket', {
      headers: { 'Origin': 'https://www.tradingview.com' },
    });
  } catch (e) {
    us100Cache.wsState = 'closed';
    _scheduleUs100Reconnect();
    return;
  }
  _us100Ws = ws;
  const send = (m) => {
    const s = JSON.stringify(m);
    try { ws.send(`~m~${s.length}~m~${s}`); } catch {}
  };
  ws.addEventListener('open', () => {
    us100Cache.wsState = 'open';
    us100Cache.wsConnectedAt = Date.now();
    _us100Retry = 0;
    send({ m: 'set_auth_token', p: [TV_AUTH_TOKEN] });
    send({ m: 'quote_create_session', p: ['qs_persist'] });
    send({ m: 'quote_set_fields', p: ['qs_persist', 'lp'] });
    send({ m: 'quote_add_symbols', p: ['qs_persist', US100_SYMBOL] });
    for (const tf of US100_TFS) {
      const csid = 'cs_persist_' + tf;
      _us100SessionMap[csid] = tf;
      send({ m: 'chart_create_session', p: [csid, ''] });
      send({ m: 'resolve_symbol', p: [csid, 'sym_' + tf, '={"adjustment":"splits","symbol":"' + US100_SYMBOL + '"}'] });
      send({ m: 'create_series', p: [csid, 'ser_' + tf, 's1', 'sym_' + tf, TF_RESOLUTION[tf], 60, ''] });
    }
  });
  ws.addEventListener('message', (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : ev.data.toString();
    if (text.includes('~h~')) { try { ws.send(text); } catch {} }
    const qre = /"n":"FPMARKETS:US100"[^}]*"lp":([0-9.]+)/g;
    let qm, lastPrice = null;
    while ((qm = qre.exec(text)) !== null) lastPrice = Number(qm[1]);
    if (lastPrice && lastPrice > 0) {
      us100Cache.price = lastPrice;
      us100Cache.priceTs = Date.now();
    }
    _us100Buf += text;
    let consumed = 0;
    for (const { frame, nextI } of _us100Frames(_us100Buf)) {
      consumed = nextI;
      if (!frame || frame[0] !== '{') continue;
      let msg; try { msg = JSON.parse(frame); } catch { continue; }
      if (!msg.m) continue;
      const csid = msg.p && msg.p[0];
      const tf = _us100SessionMap[csid];
      if (!tf) continue;
      if (msg.m === 'timescale_update') {
        const sds = msg.p && msg.p[1];
        if (!sds) continue;
        let bars = null;
        for (const k of Object.keys(sds)) {
          if (sds[k] && Array.isArray(sds[k].s)) { bars = sds[k].s; break; }
        }
        if (!bars) continue;
        us100Cache.bars[tf] = bars
          .map(b => ({ t: Math.round((+b.v[0]) * 1000), o: +b.v[1], h: +b.v[2], l: +b.v[3], c: +b.v[4], v: +b.v[5] }))
          .filter(k => Number.isFinite(k.c));
        us100Cache.barsTs[tf] = Date.now();
      } else if (msg.m === 'du') {
        const sds = msg.p && msg.p[1];
        if (!sds) continue;
        let updates = null;
        for (const k of Object.keys(sds)) {
          if (sds[k] && Array.isArray(sds[k].s)) { updates = sds[k].s; break; }
        }
        if (!updates) continue;
        const existing = us100Cache.bars[tf] || [];
        for (const u of updates) {
          const v = u.v;
          if (!v) continue;
          const newBar = { t: Math.round((+v[0]) * 1000), o: +v[1], h: +v[2], l: +v[3], c: +v[4], v: +v[5] };
          if (!Number.isFinite(newBar.c)) continue;
          const lastIdx = existing.length - 1;
          if (u.i === lastIdx + 1) existing.push(newBar);
          else if (u.i >= 0 && u.i <= lastIdx) existing[u.i] = newBar;
        }
        if (existing.length > 240) existing.splice(0, existing.length - 240);
        us100Cache.bars[tf] = existing;
        us100Cache.barsTs[tf] = Date.now();
      }
    }
    _us100Buf = _us100Buf.substring(consumed);
    // Keep the buffer bounded — runaway accumulation if TV ever sends garbage.
    if (_us100Buf.length > 1_000_000) _us100Buf = '';
    _us100NotifyWaiters();
  });
  ws.addEventListener('close', () => {
    us100Cache.wsState = 'closed';
    _us100Ws = null;
    _scheduleUs100Reconnect();
  });
  ws.addEventListener('error', () => {
    try { ws.close(); } catch {}
  });
}

function _scheduleUs100Reconnect() {
  us100Cache.reconnectCount++;
  const delay = Math.min(30_000, 1000 * Math.pow(2, _us100Retry++));
  setTimeout(_initUs100Stream, delay);
}

function _us100PriceFreshness() {
  return Date.now() - us100Cache.priceTs;
}
function _us100BarsFreshness(tf) {
  return Date.now() - (us100Cache.barsTs[tf] || 0);
}

// TV only pushes qsd/du frames when there is actually a tick. During quiet
// stretches (pre-market, holidays, low-volume minutes) a TF can sit silent
// for tens of seconds — the cache still holds the true latest value, the
// stream is healthy. Treat cache as authoritative whenever the WS is open
// AND we have data; only fall back if the stream is closed or so stale it
// looks zombie (>5 min, well past any normal quiet stretch).
const US100_CACHE_ZOMBIE_MS = 5 * 60_000;
function _us100PriceCacheOk() {
  return us100Cache.wsState === 'open'
    && us100Cache.price > 0
    && _us100PriceFreshness() < US100_CACHE_ZOMBIE_MS;
}
function _us100BarsCacheOk(tf) {
  return us100Cache.wsState === 'open'
    && Array.isArray(us100Cache.bars[tf])
    && us100Cache.bars[tf].length >= 22
    && _us100BarsFreshness(tf) < US100_CACHE_ZOMBIE_MS;
}

async function us100Bars(tfs, limit = 60) {
  const wantTfs = (tfs || US100_TFS).filter(tf => TF_RESOLUTION[tf]);
  const missing = wantTfs.filter(tf => !_us100BarsCacheOk(tf));
  if (missing.length) {
    try { await _us100WaitFor(() => missing.every(_us100BarsCacheOk), 5000); }
    catch { return tvBars(US100_SYMBOL, wantTfs, limit); }
  }
  const out = {};
  for (const tf of wantTfs) {
    const bars = us100Cache.bars[tf] || [];
    out[tf] = limit > 0 ? bars.slice(-limit) : bars.slice();
  }
  // ts = oldest TF's last update — surfaces staleness if one chart session drops.
  let oldestTs = Date.now();
  for (const tf of wantTfs) {
    const t = us100Cache.barsTs[tf] || 0;
    if (t && t < oldestTs) oldestTs = t;
  }
  return { bars: out, ts: oldestTs, source: 'tv-ws-persistent:' + US100_SYMBOL, symbol: US100_SYMBOL, cached: true };
}

async function us100Price() {
  // Fast path: persistent stream cache, WS open + non-zombie.
  if (_us100PriceCacheOk()) {
    return { price: us100Cache.price, source: 'tv-ws-persistent:' + US100_SYMBOL, ts: us100Cache.priceTs };
  }
  try {
    await _us100WaitFor(_us100PriceCacheOk, 3500);
    return { price: us100Cache.price, source: 'tv-ws-persistent:' + US100_SYMBOL, ts: us100Cache.priceTs };
  } catch { /* fall through */ }
  // Cold-start / outage fallback: one-shot WS on the SAME symbol the user
  // trades (FPMARKETS:US100). No NQ=F / CME_MINI:NQ1! cross-feeds — those are
  // different instruments and would desync the badge from FP Markets.
  return await us100PriceWS(US100_SYMBOL);
}

// Telegram relay — keeps the bot token server-side so it isn't exposed in
// public github.io JS. The dashboard POSTs {text} to /notify; we forward
// via the Bot API to the single configured chat. Token + chat are wired
// from the `happy` bot the user already has set up for the Hermes agent
// on this VPS (same bot, both lanes — that was the user's explicit ask).
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID   || '';
// Telegram has a single getUpdates lock per bot token: two processes polling
// the same token will both see `Conflict: terminated by other getUpdates`.
// Sending is shared-safe; only the long-poll loop conflicts. AZC default is
// OFF so the same bot can be shared with Hermes; set AZC_TELEGRAM_COMMANDS=1
// on exactly one host if you want /picks /status /win /loss /be commands.
const TG_COMMANDS_ENABLED = String(process.env.AZC_TELEGRAM_COMMANDS || '').trim() === '1';
async function telegramSend(text) {
  if (!TG_TOKEN || !TG_CHAT) throw new Error('telegram-not-configured');
  const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({ chat_id: TG_CHAT, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('telegram-' + (j.description || r.status));
  return { ok: true, message_id: j.result?.message_id, ts: Date.now() };
}

// ─────────────────────────────────────────────────────────────────────
// Two-way Telegram commands
// ─────────────────────────────────────────────────────────────────────
// Architecture: the browser dashboard (running 24/7 in ict-dash Firefox)
// POSTs its current state — positions + zone snapshot — to /state every
// minute. The relay caches it. When a Telegram command arrives, the
// relay answers from the cached state directly, no browser round-trip.
// Cache becomes "stale" after 3 minutes without an update — replies
// include a "stale state" warning instead of pretending the data is fresh.
let _dashState = { positions: [], zones: [], ts: 0 };
const STATE_STALE_MS = 3 * 60 * 1000;

// AUTO on/off cache so "is the dashboard actually running with AUTO on?"
// can be answered with a single curl, without depending on Telegram log
// scraping. Dashboard POSTs to /auto-state on every toggle and heartbeat;
// GET returns the latest record plus a freshness verdict.
let _autoState = { state: 'unknown', ts: 0, lastFireTs: 0 };
const AUTO_STALE_MS = 7 * 60 * 1000;

// Update-poller state. We poll Telegram's getUpdates every 10s with
// offset tracking. Only run if a token is configured.
let _tgOffset = 0;
let _tgPollerStarted = false;
const _tgAcceptedChats = new Set();
if (TG_CHAT) _tgAcceptedChats.add(String(TG_CHAT));

function fmtUsd(n, digits = 4) {
  if (!Number.isFinite(n)) return '$—';
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
}
function _staleNote() {
  if (!_dashState.ts) return ' (no state yet — browser ticker not connected)';
  const age = Date.now() - _dashState.ts;
  if (age > STATE_STALE_MS) return ` (stale ${Math.round(age/60000)}m — browser ticker may be down)`;
  return '';
}
function _handlePicks() {
  const stale = _staleNote();
  const picks = (_dashState.zones || []).filter(z => z.state === 'buy_at' || z.state === 'buy_near');
  if (!picks.length) return `📈 No picks right now${stale}.`;
  const lines = picks
    .sort((a, b) => (a.state === 'buy_at' ? -1 : b.state === 'buy_at' ? 1 : Math.abs(a.distPct) - Math.abs(b.distPct)))
    .map(z => {
      const tag = z.state === 'buy_at' ? 'AT BUY' : `NEAR BUY ${z.distPct.toFixed(1)}%`;
      const tgt = z.sellWide ? ` → ${fmtUsd(z.sellWide)}` : '';
      return `• ${z.symbol} · ${tag} · ${fmtUsd(z.price)}${tgt}`;
    });
  return `📈 ${picks.length} pick${picks.length > 1 ? 's' : ''}${stale}\n` + lines.join('\n');
}
function _handlePositions() {
  const stale = _staleNote();
  const open = (_dashState.positions || []).filter(p => !p.closedAt);
  if (!open.length) return `📌 No open positions${stale}.`;
  const lines = open.map(p => {
    const z = (_dashState.zones || []).find(x => x.symbol === p.symbol);
    const px = z?.price;
    const pnl = px ? ((px - p.entry) / p.entry) * 100 : null;
    const days = Math.max(0, Math.floor((Date.now() - p.ts) / 86400000));
    const pnlStr = pnl == null ? '—' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`;
    const tgt = p.target ? ` · target ${fmtUsd(p.target)}` : '';
    return `• ${p.symbol} · size ${p.size} @ ${fmtUsd(p.entry)} · ${days}d · ${pnlStr}${tgt}`;
  });
  return `📌 ${open.length} open position${open.length > 1 ? 's' : ''}${stale}\n` + lines.join('\n');
}
function _handleStatus() {
  const stale = _staleNote();
  const open = (_dashState.positions || []).filter(p => !p.closedAt).length;
  const picks = (_dashState.zones || []).filter(z => z.state === 'buy_at' || z.state === 'buy_near').length;
  const atSell = (_dashState.zones || []).filter(z => z.state === 'sell_at').length;
  return [
    '🩺 ICT Autopilot status' + stale,
    `• Picks (buy zone): ${picks}`,
    `• Open positions: ${open}`,
    `• AT SELL hits: ${atSell}`,
    `• Last browser update: ${_dashState.ts ? new Date(_dashState.ts).toISOString().slice(11, 19) + ' UTC' : 'never'}`,
  ].join('\n');
}
function _handleHelp() {
  return [
    '🤖 Commands:',
    '/picks — assets currently at/near buy zone',
    '/positions — your open spot holdings + live P/L',
    '/open SYMBOL SIZE — open a position at live price (e.g. /open BNB 100)',
    '/close SYMBOL — close all open positions for SYMBOL at live price',
    '/win [HH:MM] — mark latest US100 pending fire as WIN (or a specific time)',
    '/loss [HH:MM] — mark latest US100 pending fire as LOSS',
    '/be [HH:MM] — mark latest US100 pending fire as BREAKEVEN',
    '/status — quick health snapshot',
    '/help — this message',
  ].join('\n');
}

// Mark a pending US100 journal entry from Telegram. With no arg we target the
// most recent pending fire today; with `HH:MM` we match by the journal time
// label (e.g. "14:30 GST"). Browser ticker drains the queued action, calls
// setManualOutcome, then confirms via /notify so the user sees ✅.
function _handleOutcome(args, outcome) {
  const arg = (args[0] || '').trim();
  const timeTag = arg && /^\d{1,2}:\d{2}$/.test(arg) ? arg : null;
  if (arg && !timeTag) {
    return `❓ Usage: /${outcome} [HH:MM]  (e.g. /${outcome} 14:30, or just /${outcome} for the latest pending)`;
  }
  _queueAction({ type: 'outcome', outcome, timeTag });
  const target = timeTag ? `@ ${timeTag}` : '(latest pending)';
  const note = _staleNote();
  return `⏳ Queued /${outcome} ${target}${note} — browser will mark the US100 fire and confirm here.`;
}

// Pending action queue — the relay can't touch localStorage directly, so
// /close hands off to the browser ticker via /actions polling. Browser
// executes, then POSTs confirmation back to /notify (existing path).
let _pendingActions = [];
let _actionId = 1;
function _queueAction(action) {
  const id = _actionId++;
  _pendingActions.push({ id, ts: Date.now(), ...action });
  return id;
}
function _handleClose(args) {
  const sym = (args[0] || '').toUpperCase().trim();
  if (!sym || !/^[A-Z0-9]{2,8}$/.test(sym)) {
    return '❓ Usage: /close SYMBOL (e.g. /close BNB)';
  }
  // Confirm there's something to close from cached state. We still queue
  // even if cache shows zero — browser is the source of truth — but warn
  // the user so they know what we saw.
  const open = (_dashState.positions || []).filter(p => p.symbol === sym && !p.closedAt);
  _queueAction({ type: 'close', symbol: sym });
  const note = _staleNote();
  if (open.length === 0) return `⚠ Queued /close ${sym}, but no open ${sym} positions in last snapshot${note}. Browser will check and reply.`;
  const total = open.reduce((s, p) => s + (p.size || 0), 0);
  return `⏳ Queued /close ${sym} (${open.length} position${open.length>1?'s':''}, size ${total})${note} — browser will execute at live price and confirm here.`;
}
function _handleOpen(args) {
  const sym = (args[0] || '').toUpperCase().trim();
  const size = parseFloat(args[1]);
  if (!sym || !/^[A-Z0-9]{2,8}$/.test(sym)) {
    return '❓ Usage: /open SYMBOL SIZE (e.g. /open BNB 100)';
  }
  if (!(size > 0) || !Number.isFinite(size)) {
    return '❓ Size must be a positive number (e.g. /open BNB 100)';
  }
  // Sanity-check against cached zone snapshot — warn if the user is buying
  // an asset that isn't in any buy zone right now. Still queue — user knows
  // what they want; this is just a "are you sure" nudge.
  const zone = (_dashState.zones || []).find(z => z.symbol === sym);
  _queueAction({ type: 'open', symbol: sym, size });
  const note = _staleNote();
  if (!zone) {
    return `⏳ Queued /open ${sym} size ${size}${note}. Note: ${sym} not in cached zone snapshot — verify it's a tracked spot asset.`;
  }
  const px = zone.price ? `$${zone.price.toLocaleString('en-US',{maximumFractionDigits:4})}` : 'live';
  const where = zone.state === 'buy_at' ? '🏦 AT BUY ZONE'
              : zone.state === 'buy_near' ? `🏦 NEAR BUY ${zone.distPct?.toFixed(1)}%`
              : zone.state === 'sell_at' ? '⚠ AT SELL ZONE (counterintuitive entry)'
              : zone.state === 'sell_near' ? '⚠ near sell — late entry'
              : 'MID range';
  return `⏳ Queued /open ${sym} size ${size} at ${px} · ${where}${note} — browser will record at live price and confirm here.`;
}
async function _processTgMessage(msg) {
  const chat_id = String(msg.chat?.id || '');
  if (!_tgAcceptedChats.has(chat_id)) return; // ignore strangers
  const text = String(msg.text || '').trim();
  if (!text.startsWith('/')) return;
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@.+$/, '');
  const args = parts.slice(1);
  let reply = null;
  if      (cmd === '/picks')     reply = _handlePicks();
  else if (cmd === '/positions') reply = _handlePositions();
  else if (cmd === '/close')     reply = _handleClose(args);
  else if (cmd === '/open')      reply = _handleOpen(args);
  else if (cmd === '/win')       reply = _handleOutcome(args, 'win');
  else if (cmd === '/loss')      reply = _handleOutcome(args, 'loss');
  else if (cmd === '/be')        reply = _handleOutcome(args, 'be');
  else if (cmd === '/status')    reply = _handleStatus();
  else if (cmd === '/help' || cmd === '/start') reply = _handleHelp();
  if (reply) {
    try { await telegramSend(reply); } catch (e) { console.warn('[tg] reply failed', e.message); }
  }
}
async function _tgPollOnce() {
  if (!TG_TOKEN) return;
  const url = `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=25&offset=${_tgOffset}&allowed_updates=${encodeURIComponent('["message"]')}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    if (!j.ok) { console.warn('[tg] getUpdates not ok', j.description); return; }
    for (const upd of j.result || []) {
      _tgOffset = Math.max(_tgOffset, upd.update_id + 1);
      if (upd.message) {
        _processTgMessage(upd.message).catch(e => console.warn('[tg] handler', e.message));
      }
    }
  } catch (e) {
    // Long-poll timeout / transient — just retry next tick.
  }
}
function _startTgPoller() {
  if (_tgPollerStarted || !TG_TOKEN) return;
  if (!TG_COMMANDS_ENABLED) {
    console.log('[tg] command poller disabled (AZC_TELEGRAM_COMMANDS!=1) — /notify sends still work');
    return;
  }
  _tgPollerStarted = true;
  (async function loop() {
    while (true) {
      await _tgPollOnce();
      await new Promise(r => setTimeout(r, 1000));
    }
  })();
  console.log('telegram command poller running for chat', TG_CHAT);
}

// CORS is open: this server's only public-facing endpoints (/api/us100-price,
// /us100) return non-secret quotes that anyone could scrape from TV directly.
// Worth keeping the dashboard on github.io able to fetch this VPS for users
// who don't run their own Cloudflare Worker.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, X-ICT-Token',
  'access-control-max-age': '86400',
};

function authedWrite(req) { return authedWriteWith(RELAY_TOKEN, req); }
function denyAuth(res) {
  return sendJson(res, 401, { error: 'auth-required' }, CORS_HEADERS);
}

// Trade-learnings post-mortems land under trade-learnings/{wins,losses,be}/.
// The folder is bind-mounted into the docker container so files persist on
// host disk; the user reviews them with normal grep/cat. Per-file dedupe by
// filename — re-POSTing the same id is a no-op so the dashboard can retry.
const LEARN_ROOT = process.env.LEARN_ROOT || path.join(root, 'trade-learnings');
const TRADER_STATE_DIR = process.env.TRADER_STATE_DIR || '/app/.trader-state';
const TRADER_STATE_FILE = path.join(TRADER_STATE_DIR, 'state.json');
const TRADER_STOP_FLAG = path.join(TRADER_STATE_DIR, 'stop.flag');
const TRADER_EVENTS_FILE = path.join(TRADER_STATE_DIR, 'trader-events.jsonl');

// Dry-run shadow lanes (mean-rev + trend+trail). Each writes a health
// state.json to its own bind-mounted dir and a signals JSONL under
// trade-learnings/shadow. One read-only endpoint per lane lets the dashboard
// compare cadence/health side by side. Dirs env-overridable for local runs.
const SHADOW_LANES = {
  meanrev: {
    stateDir: process.env.MEANREV_STATE_DIR || '/app/.meanrev-state',
    signals: path.join(LEARN_ROOT, 'shadow', 'meanrev-signals.jsonl'),
  },
  trend: {
    stateDir: process.env.TREND_STATE_DIR || '/app/.trend-state',
    signals: path.join(LEARN_ROOT, 'shadow', 'trend-signals.jsonl'),
  },
};

async function shadowLaneState(lane) {
  const cfg = SHADOW_LANES[lane];
  const stopFlag = await fileExists(path.join(cfg.stateDir, 'stop.flag'));
  const signals = summarizeShadowSignals(await readTailEvents(cfg.signals, 500));
  try {
    const data = JSON.parse(await readFile(path.join(cfg.stateDir, 'state.json'), 'utf8'));
    return { ok: true, stopFlag, signals, ...data };
  } catch {
    return { ok: false, running: false, reason: 'no-state-file', stopFlag, signals };
  }
}

async function fileExists(file) {
  return access(file).then(() => true).catch(() => false);
}

function freshness(ts, staleMs) {
  const ageMs = ts ? Date.now() - Number(ts) : null;
  return { ts: ts || 0, ageMs, stale: ageMs == null || ageMs > staleMs };
}

async function readRequestBody(req, maxBytes) {
  let body = '';
  await new Promise((resolve, reject) => {
    req.on('data', c => {
      body += c;
      if (body.length > maxBytes) {
        reject(new Error('body-too-large'));
        req.destroy();
      }
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
  return body;
}

async function buildHealth() {
  const browserState = freshness(_dashState.ts, STATE_STALE_MS);
  const browserAuto = freshness(_autoState.ts, AUTO_STALE_MS);
  const stopFlag = await fileExists(TRADER_STOP_FLAG);
  let trader = { ok: false, running: false, reason: 'no-state-file', stopFlag };
  try {
    const data = JSON.parse(await readFile(TRADER_STATE_FILE, 'utf8'));
    const cycle = freshness(data.lastCycleAt, 60_000);
    trader = {
      ok: true,
      running: !cycle.stale && !stopFlag,
      stopFlag,
      cycleCount: data.cycleCount || 0,
      lastCycleAt: data.lastCycleAt || 0,
      cycleAgeMs: cycle.ageMs,
      stale: cycle.stale,
      lastError: data.lastError || null,
      pendingOrder: data.pendingOrder || null,
      positionContext: data.positionContext || null,
    };
  } catch (e) {
    trader.error = e.code || e.message;
  }
  const checks = {
    relayAuth: { ok: Boolean(RELAY_TOKEN) },
    mexcSigning: { ok: Boolean(MEXC_API_KEY && MEXC_API_SECRET) },
    telegramSend: { ok: Boolean(TG_TOKEN && TG_CHAT) },
    learnRoot: { ok: await fileExists(LEARN_ROOT) },
    traderEvents: { ok: await fileExists(TRADER_EVENTS_FILE) },
    browserState: { ok: !browserState.stale, ...browserState },
    browserAuto: { ok: !browserAuto.stale, ...browserAuto, state: _autoState.state },
    us100Stream: {
      ok: us100Cache.wsState === 'open' && _us100PriceFreshness() < 10_000,
      wsState: us100Cache.wsState,
      authed: TV_AUTH_TOKEN !== 'unauthorized_user_token',
      priceAgeMs: us100Cache.priceTs ? _us100PriceFreshness() : null,
      barsAgeMs: Object.fromEntries(US100_TFS.map(tf => [tf, us100Cache.barsTs[tf] ? _us100BarsFreshness(tf) : null])),
      reconnects: us100Cache.reconnectCount,
    },
    trader,
  };
  return {
    ok: checks.learnRoot.ok,
    ts: Date.now(),
    uptimeSec: Math.round(process.uptime()),
    checks,
  };
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS); return res.end();
    }
    if ((url.pathname === '/health' || url.pathname === '/ready') && req.method === 'GET') {
      const health = await buildHealth();
      return sendJson(res, health.ok ? 200 : 503, health, CORS_HEADERS);
    }
    // Same payload exposed under two paths so a hardcoded fallback URL can
    // point at either `/us100` (matches the Cloudflare Worker contract) or
    // `/api/us100-price` (matches the legacy local-proxy path).
    if (url.pathname === '/api/us100-price' || url.pathname === '/us100') {
      try { return sendJson(res, 200, await us100Price(), CORS_HEADERS); }
      catch (error) { return sendJson(res, 502, { error: error.message }, CORS_HEADERS); }
    }
    if (url.pathname === '/us100/bars') {
      const tfsParam = (url.searchParams.get('tfs') || '1m,5m,15m,1h,4h,1d').split(',').map(s => s.trim()).filter(Boolean);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '60', 10) || 60, 22), 300);
      try { return sendJson(res, 200, await us100Bars(tfsParam, limit), CORS_HEADERS); }
      catch (error) { return sendJson(res, 502, { error: error.message }, CORS_HEADERS); }
    }
    if (url.pathname === '/tv/bars') {
      const symbol = url.searchParams.get('symbol') || 'FPMARKETS:US100';
      const tfsParam = (url.searchParams.get('tfs') || '1m,5m,15m,1h,4h,1d').split(',').map(s => s.trim()).filter(Boolean);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '60', 10) || 60, 22), 300);
      try { return sendJson(res, 200, await tvBars(symbol, tfsParam, limit), CORS_HEADERS); }
      catch (error) { return sendJson(res, 502, { error: error.message }, CORS_HEADERS); }
    }
    if (url.pathname === '/stats' && req.method === 'GET') {
      try { return sendJson(res, 200, await buildStats(LEARN_ROOT), CORS_HEADERS); }
      catch (error) { return sendJson(res, 502, { error: error.message }, CORS_HEADERS); }
    }
    if (url.pathname === '/actions' && req.method === 'GET') {
      // Destructive GET (returns + clears the queue). Auth-required so a
      // random scraper can't drain pending Telegram commands before the
      // dashboard sees them.
      if (!authedWrite(req)) return denyAuth(res);
      const out = _pendingActions;
      _pendingActions = [];
      return sendJson(res, 200, { actions: out }, CORS_HEADERS);
    }
    if (url.pathname === '/state' && req.method === 'POST') {
      if (!authedWrite(req)) return denyAuth(res);
      // Browser ticker pushes its current state here every minute so the
      // Telegram command handler can answer /picks /positions /status from
      // cached data without waking the dashboard.
      try {
        const body = await readRequestBody(req, 32 * 1024);
        const payload = JSON.parse(body || '{}');
        _dashState = {
          positions: Array.isArray(payload.positions) ? payload.positions : [],
          zones: Array.isArray(payload.zones) ? payload.zones : [],
          ts: Date.now(),
        };
        return sendJson(res, 200, { ok: true }, CORS_HEADERS);
      } catch (error) {
        return sendJson(res, 400, { error: error.message }, CORS_HEADERS);
      }
    }
    if (url.pathname === '/auto-state' && req.method === 'GET') {
      // The dashboard browser tab and the server-side autonomous trader
      // are two independent execution lanes. Old payload conflated them
      // ("running:false" when the browser AUTO was off, even with the
      // server trader live and firing). Split them so a verifier can
      // tell exactly what's alive.
      const browserAge = _autoState.ts ? Date.now() - _autoState.ts : null;
      const browserFresh = browserAge != null && browserAge < AUTO_STALE_MS;
      const browserAuto = {
        state: _autoState.state,
        ts: _autoState.ts,
        ageMs: browserAge,
        stale: browserAge == null || !browserFresh,
        running: browserFresh && _autoState.state === 'on',
        lastFireTs: _autoState.lastFireTs || 0,
      };

      let serverTrader;
      try {
        const fs = await import('node:fs/promises');
        const text = await fs.readFile(TRADER_STATE_FILE, 'utf8');
        const data = JSON.parse(text);
        const stopFlag = await fs.access(TRADER_STOP_FLAG).then(() => true).catch(() => false);
        const cycleAge = data.lastCycleAt ? Date.now() - data.lastCycleAt : null;
        // 60s is 4× the trader's TICK_MS (15s) — alive if it's been
        // scanning that recently.
        const cycleFresh = cycleAge != null && cycleAge < 60_000;
        serverTrader = {
          running: cycleFresh && !stopFlag,
          stopFlag,
          cycleCount: data.cycleCount || 0,
          lastCycleAt: data.lastCycleAt || 0,
          cycleAgeMs: cycleAge,
          stale: !cycleFresh,
        };
      } catch {
        serverTrader = { running: false, reason: 'no-state-file' };
      }

      const label = serverTrader.running
        ? (browserAuto.running ? 'Server trader live; browser AUTO on'
                               : 'Server trader live; browser AUTO off (this is fine)')
        : (browserAuto.running ? 'Server trader DOWN; browser AUTO on'
                               : 'Both lanes offline');

      return sendJson(res, 200, {
        // New canonical fields:
        browserAuto,
        serverTrader,
        label,
        // Legacy top-level fields preserved so existing readers keep
        // working. `running` now means "any execution lane is alive"
        // (server trader OR browser AUTO), which matches user intent.
        state: browserAuto.state,
        ts: browserAuto.ts,
        ageMs: browserAuto.ageMs,
        stale: browserAuto.stale && serverTrader.stale,
        running: browserAuto.running || serverTrader.running,
        lastFireTs: browserAuto.lastFireTs,
      }, CORS_HEADERS);
    }
    if (url.pathname === '/auto-state' && req.method === 'POST') {
      if (!authedWrite(req)) return denyAuth(res);
      try {
        const body = await readRequestBody(req, 512);
        const payload = JSON.parse(body || '{}');
        const state = payload.state === 'on' ? 'on' : 'off';
        // Only overwrite lastFireTs when the payload explicitly carries a
        // finite positive number. `||` treats 0 as falsy, which made the
        // field sticky once any non-zero value had ever been posted.
        const incomingFire = Number(payload.lastFireTs);
        const nextFireTs = Number.isFinite(incomingFire) && incomingFire > 0
          ? incomingFire
          : _autoState.lastFireTs;
        _autoState = { state, ts: Date.now(), lastFireTs: nextFireTs };
        return sendJson(res, 200, { ok: true, ..._autoState }, CORS_HEADERS);
      } catch (error) {
        return sendJson(res, 400, { error: error.message }, CORS_HEADERS);
      }
    }
    if (url.pathname === '/mexc/signed' && req.method === 'POST') {
      if (!authedWrite(req)) return denyAuth(res);
      if (!MEXC_API_KEY || !MEXC_API_SECRET) {
        return sendJson(res, 503, { error: 'server-signing-disabled' }, CORS_HEADERS);
      }
      try {
        const body = await readRequestBody(req, 8 * 1024);
        const payload = JSON.parse(body || '{}');
        const path = String(payload.path || '');
        if (!path.startsWith(MEXC_ALLOWED)) {
          return sendJson(res, 400, { error: 'bad-path', detail: 'path must start with ' + MEXC_ALLOWED }, CORS_HEADERS);
        }
        const r = await callMexcSigned({
          apiKey: MEXC_API_KEY, apiSecret: MEXC_API_SECRET,
          path, method: payload.method || 'GET',
          body: payload.body, params: payload.params,
        });
        res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS_HEADERS });
        return res.end(r.body);
      } catch (error) {
        return sendJson(res, 502, { error: error.message }, CORS_HEADERS);
      }
    }
    if (url.pathname === '/learn-trade' && req.method === 'POST') {
      if (!authedWrite(req)) return denyAuth(res);
      try {
        const body = await readRequestBody(req, 16 * 1024);
        const payload = JSON.parse(body || '{}');
        if (!payload || !payload.symbol || !payload.outcome) {
          return sendJson(res, 400, { error: 'missing-fields' }, CORS_HEADERS);
        }
        // Snapshot market headlines at close. Internal 2s cap; null on any
        // failure so the post-mortem still gets written even when the news
        // provider is down or unconfigured.
        if (!payload.context) {
          try {
            payload.context = await fetchMarketContext({
              symbol: payload.symbol,
              ts: Number(payload.timestamp) || Date.now(),
            });
          } catch (e) {
            payload.context = null;
            console.error('[context-fetch-err]', e.message);
          }
        }
        // Stitch the last-fire sentiment from trader state if available.
        // positionContext is cleared on close, so we read lastFireSentiment
        // (which survives until the next fire). Match by orderId so we
        // never attach the wrong fire's sentiment to a post-mortem.
        if (!payload.sentiment) {
          try {
            const txt = await readFile(TRADER_STATE_FILE, 'utf8');
            const ts = JSON.parse(txt);
            const lfs = ts?.lastFireSentiment;
            if (lfs && payload.orderId && String(lfs.orderId) === String(payload.orderId)) {
              const { orderId: _, ...rest } = lfs;
              payload.sentiment = rest;
            }
          } catch (e) {
            // best-effort; never block the post-mortem
          }
        }
        const out = await writeLearningFile(payload, LEARN_ROOT);
        if (!out.ok) return sendJson(res, 400, { error: out.reason || 'write-failed' }, CORS_HEADERS);
        // Refresh INSIGHTS.md so the dashboard sees the new edge/leak
        // counts on the next read. Failure here must not break the
        // /learn-trade response — the post-mortem file is the canonical
        // record; insights are a derived view.
        try { await writeInsightsFile(LEARN_ROOT, { sinceTs: SIDE_GATE_SAMPLE_SINCE_TS }); }
        catch (e) { console.error('[insights-refresh-err]', e.message); }
        return sendJson(res, 200, out, CORS_HEADERS);
      } catch (error) {
        return sendJson(res, 500, { error: error.message }, CORS_HEADERS);
      }
    }
    // Trader state — read the JSON the azc-trader.mjs process writes to
    // /app/.trader-state/state.json (bind-mounted from host
    // .trader-state/). Public GET so the dashboard can poll without
    // sending the token.
    if (url.pathname === '/trader-state' && req.method === 'GET') {
      try {
        const text = await import('node:fs/promises').then(m => m.readFile(TRADER_STATE_FILE, 'utf8'));
        const data = JSON.parse(text);
        const stopFlag = await import('node:fs/promises').then(m => m.access(TRADER_STOP_FLAG).then(() => true).catch(() => false));
        return sendJson(res, 200, { ok: true, stopFlag, ...data }, CORS_HEADERS);
      } catch (error) {
        return sendJson(res, 200, { ok: false, running: false, reason: 'no-state-file' }, CORS_HEADERS);
      }
    }

    // Trader events — append-only JSONL ring buffer of recent scan
    // decisions. Public GET so the dashboard can render decision
    // provenance ("why didn't the bot fire?") without sending the token.
    if (url.pathname === '/trader-events' && req.method === 'GET') {
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 200));
      try {
        const events = await readTailEvents(TRADER_EVENTS_FILE, limit);
        return sendJson(res, 200, { ok: true, count: events.length, events }, CORS_HEADERS);
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error.message }, CORS_HEADERS);
      }
    }

    // Shadow lane state — liveness + signal summary for the dry-run mean-rev
    // and trend+trail lanes. Public GET so the dashboard polls without a token;
    // both lanes open nothing, so there's no write surface to gate.
    if ((url.pathname === '/meanrev-state' || url.pathname === '/trend-state') && req.method === 'GET') {
      const lane = url.pathname.slice(1).replace('-state', '');
      try {
        return sendJson(res, 200, { lane, ...(await shadowLaneState(lane)) }, CORS_HEADERS);
      } catch (error) {
        return sendJson(res, 500, { ok: false, lane, error: error.message }, CORS_HEADERS);
      }
    }

    // Trader stop — creates the stop.flag file. The trader checks for it
    // each tick and exits gracefully. Auth-required (write endpoint).
    if (url.pathname === '/trader-stop' && req.method === 'POST') {
      if (!authedWrite(req)) return denyAuth(res);
      try {
        const fs = await import('node:fs/promises');
        await fs.mkdir(TRADER_STATE_DIR, { recursive: true });
        await fs.writeFile(TRADER_STOP_FLAG, new Date().toISOString());
        return sendJson(res, 200, { ok: true, stopped: true }, CORS_HEADERS);
      } catch (error) {
        return sendJson(res, 500, { error: error.message }, CORS_HEADERS);
      }
    }

    // Trader start — removes stop.flag so systemd's auto-restart can bring
    // the trader back up. The trader process must already be enabled in
    // systemd; this just clears the brake.
    if (url.pathname === '/trader-start' && req.method === 'POST') {
      if (!authedWrite(req)) return denyAuth(res);
      try {
        const fs = await import('node:fs/promises');
        await fs.unlink(TRADER_STOP_FLAG).catch(() => {});
        return sendJson(res, 200, { ok: true, cleared: true }, CORS_HEADERS);
      } catch (error) {
        return sendJson(res, 500, { error: error.message }, CORS_HEADERS);
      }
    }

    if (url.pathname === '/notify' && req.method === 'POST') {
      if (!authedWrite(req)) return denyAuth(res);
      // Read body, expect { text }. Cap at 2KB so a stuck client can't flood us.
      try {
        const body = await readRequestBody(req, 2048);
        const payload = JSON.parse(body || '{}');
        const text = String(payload.text || '').trim();
        if (!text) return sendJson(res, 400, { error: 'empty-text' }, CORS_HEADERS);
        return sendJson(res, 200, await telegramSend(text), CORS_HEADERS);
      } catch (error) {
        return sendJson(res, 502, { error: error.message }, CORS_HEADERS);
      }
    }

    const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const parts = requested.split('/').filter(Boolean);
    if (parts.some(part => part.startsWith('.')) || parts.some(part => part === 'node_modules')) {
      res.writeHead(404); return res.end('Not found');
    }
    const file = path.normalize(path.join(root, requested));
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403); return res.end('Forbidden');
    }
    const s = await stat(file);
    if (!s.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(port, host, () => {
  console.log(`ICT AutoPilot serving http://${host}:${port}/`);
  _startTgPoller();
  _initUs100Stream();
});
