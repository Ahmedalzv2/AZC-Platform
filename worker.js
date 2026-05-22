// ─────────────────────────────────────────────────────────────────────────────
// MEXC futures CORS-bypass Worker
// ─────────────────────────────────────────────────────────────────────────────
//
// Why this exists:
//   contract.mexc.com does not return CORS headers, so a static HTML page
//   (the ICT Autopilot dashboard) cannot call the signed MEXC futures API
//   directly from the browser.
//
// What this Worker does:
//   It is a stateless relay. The dashboard signs every request locally in
//   the browser (HMAC-SHA256 with your API secret via crypto.subtle), then
//   POSTs the *already-signed* request to this Worker. The Worker just
//   forwards it to contract.mexc.com and returns the response.
//
// What this Worker does NOT do:
//   - It never sees your API secret. Only the API key and the pre-computed
//     signature travel through it (the same bytes that would be on the wire
//     to MEXC anyway).
//   - It does not log, store, or modify request bodies.
//   - It only proxies paths under /api/v1/, so it can't be abused as a
//     general open relay.
//
// Deploy steps (Cloudflare):
//   1. Cloudflare dashboard → Workers & Pages → Create → Worker.
//   2. Replace the default code with this entire file. Save and Deploy.
//   3. Copy the *.workers.dev URL Cloudflare gives you.
//   4. In the ICT Autopilot dashboard, tap 🔌 → paste the URL into
//      "Worker URL" → Save. Then "Test connection" to verify.
//
// Optional hardening:
//   - Set ALLOWED_ORIGIN below to the URL where you host the dashboard
//     (e.g. 'https://yourname.github.io'). Default '*' is fine because
//     every request must still carry your API key + a valid signature.
//
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGIN = '*';            // tighten to e.g. 'https://yourname.github.io' if you want
const MEXC_BASE = 'https://contract.mexc.com';
const ALLOWED_PATH_PREFIX = '/api/v1/'; // refuse to proxy anything else

const FORWARD_HEADERS = new Set([
  'apikey', 'request-time', 'signature', 'recv-window', 'content-type',
]);

// Public price-relay paths (no MEXC signing, no auth needed). Cloudflare
// Workers don't have CORS headaches calling upstream, so the dashboard hits
// us instead of trying to call scanner.tradingview.com directly — that one
// rejects browser-origin POSTs from github.io with a CORS failure.
async function us100Price(cors) {
  try {
    const r = await fetch('https://scanner.tradingview.com/global/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: { tickers: ['CME_MINI:NQ1!'] }, columns: ['lp', 'close'] }),
      cf: { cacheTtl: 1, cacheEverything: false },
    });
    if (!r.ok) {
      return new Response(JSON.stringify({ error: 'scanner-http', status: r.status }),
        { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    const j = await r.json();
    const row = j?.data?.[0];
    const price = (row?.d?.[0] || row?.d?.[1]) || 0;
    if (!(price > 0)) {
      return new Response(JSON.stringify({ error: 'no-price', raw: j }),
        { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ price, source: 'CME_MINI:NQ1!', ts: Date.now() }),
      { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'upstream-failed', message: String((e && e.message) || e) }),
      { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
}

function corsHeaders(reqOrigin) {
  const origin = ALLOWED_ORIGIN === '*'
    ? (reqOrigin || '*')
    : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, ApiKey, Request-Time, Signature, Recv-Window',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request) {
    const reqOrigin = request.headers.get('Origin') || '';
    const cors = corsHeaders(reqOrigin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    let mexcPath = url.pathname;
    if (mexcPath.startsWith('/proxy')) mexcPath = mexcPath.slice('/proxy'.length);

    // Public US100 quote (TV scanner CME_MINI:NQ1! relay) — no auth.
    if (mexcPath === '/us100') return us100Price(cors);

    if (!mexcPath.startsWith(ALLOWED_PATH_PREFIX)) {
      return new Response(
        JSON.stringify({ error: 'path not allowed', allowed: ALLOWED_PATH_PREFIX }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }
    const upstream = MEXC_BASE + mexcPath + url.search;

    const fwdHeaders = new Headers();
    for (const [k, v] of request.headers) {
      if (FORWARD_HEADERS.has(k.toLowerCase())) fwdHeaders.set(k, v);
    }

    const init = {
      method: request.method,
      headers: fwdHeaders,
      redirect: 'manual',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.text();
    }

    let upstreamResp;
    try {
      upstreamResp = await fetch(upstream, init);
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'upstream-failed', message: String((e && e.message) || e) }),
        { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    const body = await upstreamResp.text();
    const ct = upstreamResp.headers.get('Content-Type') || 'application/json';
    return new Response(body, {
      status: upstreamResp.status,
      headers: { ...cors, 'Content-Type': ct },
    });
  },
};
