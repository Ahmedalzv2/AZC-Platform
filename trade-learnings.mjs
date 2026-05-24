// Pure formatter + path helpers for /learn-trade. Kept in its own module so
// the tests can exercise them without importing server.mjs (which starts the
// HTTP listener and Telegram poller on import).

import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants as fsConst } from 'node:fs';
import path from 'node:path';

export const LEARN_BUCKETS = new Set(['wins', 'losses', 'be']);

export function learnBucket(outcome) {
  const o = String(outcome || '').toLowerCase();
  if (o === 'win')  return 'wins';
  if (o === 'loss') return 'losses';
  if (o === 'be')   return 'be';
  return null;
}

export function learnFileSlug(payload) {
  const ts = Number(payload?.timestamp) || Date.now();
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  const sym  = String(payload?.symbol || 'UNKNOWN').replace(/[^A-Za-z0-9_]/g, '');
  const side = String(payload?.side || '?').toUpperCase().replace(/[^A-Z]/g, '');
  return `${date}-${time}-${sym}-${side}.md`;
}

export function formatLearningMarkdown(p) {
  const lines = [];
  const f = (n, d = 4) => (Number.isFinite(Number(n)) ? Number(n).toFixed(d) : '—');
  const fr = (n) => (Number.isFinite(Number(n)) ? `${Number(n).toFixed(2)}R` : '—');
  const fu = (n) => (Number.isFinite(Number(n)) ? `${Number(n) >= 0 ? '+' : ''}${Number(n).toFixed(4)} USD` : '—');
  const tsHuman = new Date(Number(p?.timestamp) || Date.now()).toISOString();
  const sl = Number(p?.sl), entry = Number(p?.entry), tp = Number(p?.tp);
  const rDist = Number.isFinite(sl) && Number.isFinite(entry) ? Math.abs(entry - sl) : null;
  const rrTo  = (target) => (rDist && Number.isFinite(target) ? (Math.abs(target - entry) / rDist).toFixed(2) + ':1' : '—');

  lines.push(`# ${p?.symbol || '?'} ${String(p?.side || '?').toUpperCase()} — ${String(p?.outcome || '?').toUpperCase()}`);
  lines.push('');
  lines.push(`- Fired:    ${tsHuman}`);
  lines.push(`- Grade:    ${p?.grade || '—'}`);
  lines.push(`- Bias:     ${p?.bias || '—'}`);
  lines.push(`- Session:  ${p?.session || '—'}`);
  lines.push(`- Lane:     ${p?.lane || 'mexc-micro-capital'}`);
  if (p?.orderId) lines.push(`- Order ID: ${p.orderId}`);
  lines.push('');
  lines.push('## Setup');
  lines.push(`- Entry:    ${f(entry)}`);
  lines.push(`- SL:       ${f(sl)}  (risk dist ${f(rDist)})`);
  lines.push(`- TP:       ${f(tp)}  (R:R ${rrTo(tp)})`);
  if (Array.isArray(p?.confluences) && p.confluences.length) {
    lines.push(`- Confluences: ${p.confluences.join(', ')}`);
  }
  lines.push('');
  lines.push('## Execution');
  lines.push(`- Fill price: ${f(p?.priceAtCall)}`);
  if (Number.isFinite(Number(p?.exitPrice))) lines.push(`- Exit price: ${f(p.exitPrice)}`);
  lines.push(`- Outcome:    ${String(p?.outcome || '?').toUpperCase()}`);
  lines.push(`- Realised:   ${fu(p?.realizedUsd)}  ${fr(p?.rMultiple)}  (after fees + funding)`);
  if (p?.accounting) {
    const a = p.accounting;
    const holdH = a.holdMs > 0 ? (a.holdMs / 3600000).toFixed(1) + 'h' : '—';
    lines.push(`- Gross:      ${fu(a.grossUsd)}  (directional P/L only)`);
    lines.push(`- Fee open:   ${fu(a.feeUsdOpen)}`);
    lines.push(`- Fee close:  ${fu(a.feeUsdClose)}`);
    lines.push(`- Funding:    ${fu(a.fundingUsd)}  (${a.windowsCrossed} × 8h windows · held ${holdH})`);
  }
  if (p?.outcomeChecks && Object.keys(p.outcomeChecks).length) {
    lines.push(`- Path:       ${Object.entries(p.outcomeChecks).map(([m,px]) => `${m}m=${f(px)}`).join(' · ')}`);
  }
  lines.push('');
  lines.push('## Analysis');
  lines.push((p?.analysis || '_(no analysis text recorded)_').trim());
  lines.push('');
  lines.push('## Post-mortem');
  lines.push('_To fill in: what went right, what went wrong, what rule to apply next time._');
  if (p?.postMortem) {
    lines.push('');
    lines.push(p.postMortem.trim());
  }
  lines.push('');
  return lines.join('\n');
}

// Writes the markdown file. Dedupe by filename — re-POSTing the same id is a
// no-op, so the dashboard can safely retry without spawning duplicate files.
export async function writeLearningFile(payload, learnRoot) {
  const bucket = learnBucket(payload?.outcome);
  if (!bucket || !LEARN_BUCKETS.has(bucket)) {
    return { ok: false, reason: 'bad-outcome' };
  }
  const dir = path.join(learnRoot, bucket);
  await mkdir(dir, { recursive: true });
  const slug = learnFileSlug(payload);
  const file = path.join(dir, slug);
  try {
    await access(file, fsConst.F_OK);
    return { ok: true, file, deduped: true };
  } catch {}
  const body = formatLearningMarkdown(payload);
  await writeFile(file, body, 'utf8');
  return { ok: true, file, deduped: false };
}
