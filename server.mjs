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

async function us100Price() {
  // CME E-mini Nasdaq-100 Futures — same instrument FPMARKETS:US100 tracks.
  // Don't fall back to Yahoo ^NDX (cash index, ~3k off the futures scale).
  const res = await fetch('https://scanner.tradingview.com/global/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols: { tickers: ['CME_MINI:NQ1!'] }, columns: ['lp', 'close'] }),
  });
  if (!res.ok) throw new Error(`TV scanner HTTP ${res.status}`);
  const j = await res.json();
  const row = j?.data?.[0];
  const price = (row?.d?.[0] || row?.d?.[1]) || 0;
  if (!(price > 0)) throw new Error('TV scanner returned no price');
  return { price, source: 'CME_MINI:NQ1!', ts: Date.now() };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/us100-price') {
      try { return sendJson(res, 200, await us100Price()); }
      catch (error) { return sendJson(res, 502, { error: error.message }); }
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
