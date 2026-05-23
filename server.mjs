import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3002);
const host = process.env.HOST || '0.0.0.0';

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
    send({ m: 'set_auth_token', p: ['unauthorized_user_token'] });
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
async function us100Bars(tfs, limit = 60) {
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
    send({ m: 'set_auth_token', p: ['unauthorized_user_token'] });
    for (const [csid, tf] of Object.entries(sessions)) {
      send({ m: 'chart_create_session', p: [csid, ''] });
      send({ m: 'resolve_symbol', p: [csid, 'sym', '={"adjustment":"splits","symbol":"FPMARKETS:US100"}'] });
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
    return { bars: out, ts: Date.now(), source: 'tv-ws:FPMARKETS:US100' };
  } finally {
    try { ws.close(); } catch {}
  }
}

async function us100Price() {
  // Priority: TV WS (FPMARKETS:US100 — matches the chart) → Yahoo NQ=F →
  // TV scanner CME_MINI:NQ1! lp. WS is the only path that returns the
  // exact number the chart displays.
  const tryWS = () => us100PriceWS('FPMARKETS:US100');
  const tryYahoo = async () => {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/NQ=F?interval=1m', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!r.ok) throw new Error('yahoo HTTP ' + r.status);
    const j = await r.json();
    const meta = j?.chart?.result?.[0]?.meta;
    const p = Number(meta?.regularMarketPrice);
    if (!(p > 0)) throw new Error('yahoo no price');
    return { price: p, source: 'yahoo:NQ=F', ts: Date.now() };
  };
  const tryTV = async () => {
    const r = await fetch('https://scanner.tradingview.com/global/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: { tickers: ['CME_MINI:NQ1!'] }, columns: ['lp'] }),
    });
    if (!r.ok) throw new Error('TV scanner HTTP ' + r.status);
    const j = await r.json();
    const p = Number(j?.data?.[0]?.d?.[0]);
    if (!(p > 0)) throw new Error('TV scanner lp null');
    return { price: p, source: 'tv:CME_MINI:NQ1!', ts: Date.now() };
  };
  try { return await tryWS(); }
  catch (e1) {
    try { return await tryYahoo(); }
    catch (e2) { return await tryTV(); }
  }
}

// Telegram relay — keeps the bot token server-side so it isn't exposed in
// public github.io JS. The dashboard POSTs {text} to /notify; we forward
// via the Bot API to the single configured chat. Token + chat are wired
// from the `happy` bot the user already has set up for the Hermes agent
// on this VPS (same bot, both lanes — that was the user's explicit ask).
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID   || '';
async function telegramSend(text) {
  if (!TG_TOKEN || !TG_CHAT) throw new Error('telegram-not-configured');
  const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('telegram-' + (j.description || r.status));
  return { ok: true, message_id: j.result?.message_id, ts: Date.now() };
}

// CORS is open: this server's only public-facing endpoints (/api/us100-price,
// /us100) return non-secret quotes that anyone could scrape from TV directly.
// Worth keeping the dashboard on github.io able to fetch this VPS for users
// who don't run their own Cloudflare Worker.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type',
  'access-control-max-age': '86400',
};

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
    if (url.pathname === '/notify' && req.method === 'POST') {
      // Read body, expect { text }. Cap at 2KB so a stuck client can't flood us.
      let body = '';
      try {
        await new Promise((resolve, reject) => {
          req.on('data', c => { body += c; if (body.length > 2048) { reject(new Error('body-too-large')); req.destroy(); } });
          req.on('end', resolve);
          req.on('error', reject);
        });
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
});
