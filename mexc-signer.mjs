// Server-side MEXC HMAC signer + signed-proxy. Browsers currently hold the
// API secret in localStorage and sign locally — that means the secret is
// reachable via any XSS, malicious browser extension, or a screen the user
// forgot was logged in. This module moves signing to the relay: the user
// drops their key/secret into the relay's env file, the dashboard sends
// unsigned requests to /mexc/signed, the relay signs and forwards.
//
// Sign rule mirrors the browser code in index.html (_signMexcRequest):
//   signedString = apiKey + reqTime + paramString
//   signature    = HMAC-SHA256(secret, signedString) → hex
//   headers      = ApiKey, Request-Time, Signature, Content-Type, Recv-Window
//
// paramString is the JSON body for POSTs, or the URL-encoded query string for
// GETs (alphabetical key order is the MEXC convention).

import { createHmac } from 'node:crypto';

export const MEXC_BASE = 'https://contract.mexc.com';
export const ALLOWED_PATH_PREFIX = '/api/v1/';

export function buildSignedString(apiKey, reqTime, paramString) {
  return String(apiKey) + String(reqTime) + String(paramString || '');
}

export function sign(secret, signedString) {
  return createHmac('sha256', String(secret)).update(signedString).digest('hex');
}

// Sort GET params alphabetically (MEXC convention) and produce key=value&...
export function buildGetQuery(params) {
  if (!params || typeof params !== 'object') return '';
  const keys = Object.keys(params).sort();
  return keys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`).join('&');
}

// Pure: build the wire form (URL + headers + body) the relay will send to
// MEXC. Caller passes in the API key/secret + the request shape.
export function buildSignedRequest({ apiKey, apiSecret, path, method, body, params }) {
  if (!apiKey || !apiSecret) throw new Error('mexc-no-keys');
  const m = String(method || 'GET').toUpperCase();
  if (!path || !path.startsWith(ALLOWED_PATH_PREFIX)) throw new Error('mexc-bad-path');
  const reqTime = String(Date.now());
  let url, paramString, init;
  if (m === 'GET') {
    paramString = buildGetQuery(params);
    url = MEXC_BASE + path + (paramString ? ('?' + paramString) : '');
    init = { method: 'GET' };
  } else {
    paramString = (body == null) ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    url = MEXC_BASE + path;
    init = { method: m, body: paramString };
  }
  const signature = sign(apiSecret, buildSignedString(apiKey, reqTime, paramString));
  init.headers = {
    'Content-Type': 'application/json',
    'ApiKey': apiKey,
    'Request-Time': reqTime,
    'Signature': signature,
    'Recv-Window': '5000',
  };
  return { url, init, reqTime };
}

// Perform the signed call. Returns { ok, status, body } — body is text;
// caller JSON.parses if it wants. Network errors throw.
export async function callMexcSigned({ apiKey, apiSecret, path, method, body, params }) {
  const { url, init } = buildSignedRequest({ apiKey, apiSecret, path, method, body, params });
  const r = await fetch(url, init);
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text };
}
