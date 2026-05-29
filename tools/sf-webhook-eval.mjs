// Read-only evaluation runner for the StrategyFactory webhook service.
// Calls ONLY instant non-trading modes via buildEvalPayload (which refuses
// anything that could trade or mutate account state). Credentials come from
// env vars — never args, never stdin, never chat. Output is always redacted.
//
// Usage:
//   SF_EXCHANGE=bybit SF_API_KEY=... SF_API_SECRET=... [SF_PASSPHRASE=...] \
//     node tools/sf-webhook-eval.mjs [mode ...]
//   add --dry-print to show the (redacted) payloads WITHOUT any network call.
//
// Keys should be trade-only + IP-allowlisted on an isolated sub-account; even
// these read calls hand them to a third party that can decrypt them.
import { buildEvalPayload, redactCreds, READ_ONLY_MODES } from '../sf-eval.mjs';

const BASE = process.env.SF_BASE_URL || 'https://fastcloud.daviddtech.com';
const argv = process.argv.slice(2);
const dryPrint = argv.includes('--dry-print');
const modes = argv.filter(a => !a.startsWith('--'));
const runModes = modes.length ? modes : ['check_api_active', 'accountinfo', 'accountbalance'];

const exchange = process.env.SF_EXCHANGE;
const creds = {
  api_key: process.env.SF_API_KEY,
  api_secret: process.env.SF_API_SECRET,
  passphrase: process.env.SF_PASSPHRASE || '',
  encryptor: process.env.SF_ENCRYPTOR || '2',
};

function fail(msg) { console.error(`✗ ${msg}`); process.exit(2); }

if (!exchange) fail('SF_EXCHANGE not set (bybit|blofin|toobit|weex)');
if (!dryPrint && (!creds.api_key || !creds.api_secret)) fail('SF_API_KEY / SF_API_SECRET not set in env');

async function callMode(mode) {
  const payload = buildEvalPayload({ exchange, mode, ...creds });
  if (dryPrint) {
    console.log(`\n[dry] ${mode} → POST ${BASE}/webhooks/`);
    console.log(JSON.stringify(redactCreds(payload), null, 2));
    return { dry: true };
  }
  const res = await fetch(`${BASE}/webhooks/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { http: res.status, json };
}

(async () => {
  console.log(`StrategyFactory read-only eval · ${exchange} · ${BASE}${dryPrint ? ' · DRY-PRINT (no network)' : ''}`);
  console.log(`allowed modes: ${READ_ONLY_MODES.length} read-only (no trading path exists in this client)`);
  for (const mode of runModes) {
    try {
      const r = await callMode(mode);
      if (r.dry) continue;
      const j = r.json || {};
      const ok = j.success === true;
      console.log(`\n${ok ? '✓' : '✗'} ${mode} · http=${r.http} · success=${j.success} · event_id=${j.event_id || '—'}`);
      // Surface a redacted view; account_data can echo inputs, so redact the whole thing.
      console.log(JSON.stringify(redactCreds(j), null, 2).slice(0, 1800));
      if (!ok) { console.error(`\n✗ ${mode} failed (reason=${j.reason || j.error || 'unknown'}). Stopping per fail-fast contract.`); process.exit(1); }
    } catch (e) {
      fail(`${mode} request error: ${e.message}`);
    }
  }
  console.log('\n✓ eval complete — read-only, no orders placed.');
})();
