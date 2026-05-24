// Shared-token auth helper for write endpoints. Constant-time compare so a
// scrape attacker can't time-side-channel the token byte-by-byte. When the
// configured token is empty, the helper returns `true` for any request —
// legacy mode (server logs a warning at startup so this isn't silent).

export function eqConstTime(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export function authedWriteWith(token, req) {
  if (!token) return true;
  const got = req && req.headers
    ? (req.headers['x-ict-token'] || req.headers['X-ICT-Token'])
    : null;
  return eqConstTime(got, token);
}
