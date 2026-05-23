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

// CORS is open: this server's only public-facing endpoints (/api/us100-price,
// /us100) return non-secret quotes that anyone could scrape from TV directly.
// Worth keeping the dashboard on github.io able to fetch this VPS for users
// who don't run their own Cloudflare Worker.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
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
