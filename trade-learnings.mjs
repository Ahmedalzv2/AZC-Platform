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

// Auto-derive a post-mortem from the fire context. The trader has every
// number it needs at close time, so an empty "_To fill in_" placeholder
// is wasted signal. Heuristics here are mechanical (not LLM) so the same
// payload always produces the same text — easy to test and review.
export function generatePostMortem(p) {
  if (!p || typeof p !== 'object') return '';
  const outcome = String(p.outcome || '').toLowerCase();
  if (!['win', 'loss', 'be'].includes(outcome)) return '';
  const r = Number(p.rMultiple);
  const acc = p.accounting || {};
  const gross = Number(acc.grossUsd);
  const fees = Number.isFinite(Number(acc.feeUsdOpen)) && Number.isFinite(Number(acc.feeUsdClose))
    ? Math.abs(Number(acc.feeUsdOpen)) + Math.abs(Number(acc.feeUsdClose)) : null;
  const holdH = Number.isFinite(Number(acc.holdMs)) ? Number(acc.holdMs) / 3600000 : null;
  const fvgBodyPct = Number(p.fvgBodyPct);
  const session = String(p.session || '').toLowerCase();
  const bias = String(p.bias || '').toLowerCase();
  const dir = String(p.side || '').toLowerCase() === 'long' ? 'bull' : 'bear';
  const lines = [];

  if (outcome === 'loss') {
    if (Number.isFinite(r) && Math.abs(r) < 0.85) {
      lines.push(`Early exit at ${r.toFixed(2)}R before stop — not a clean rule-based -1R fill. Likely orphan-cleanup/time-stop path; verify exit code didn't bail prematurely.`);
    } else {
      lines.push(`Clean SL hit at ${Number.isFinite(r) ? r.toFixed(2) : '—'}R. Setup invalidated by adverse move beyond stop buffer.`);
    }
    if (bias && (bias === dir || bias === (dir === 'bull' ? 'bull' : 'bear'))) {
      lines.push(`HTF agreed but trade still failed — 5m noise inside HTF trend; tighten FVG quality threshold.`);
    }
    if (session === 'asia') {
      lines.push(`Asia killzone is lower-volume — edge thinner here than NY/London.`);
    }
    if (Number.isFinite(fvgBodyPct) && fvgBodyPct < 0.0020) {
      lines.push(`FVG body ${(fvgBodyPct*100).toFixed(2)}% is below 0.20% — gap too thin to defend the entry.`);
    }
  } else if (outcome === 'win') {
    lines.push(`Hit TP at ${Number.isFinite(r) ? '+' + r.toFixed(2) : '—'}R. Setup played as designed.`);
    if (Array.isArray(p.confluences) && p.confluences.length) {
      lines.push(`Aligned confluences: ${p.confluences.join(', ')}.`);
    }
    if (holdH != null && holdH < 0.5) {
      lines.push(`Fast resolution (${(holdH*60).toFixed(0)}m hold) — strong intra-session momentum.`);
    }
  } else if (outcome === 'be') {
    lines.push(`Closed flat near entry. Neither rule (stop or target) reached — likely time-stop or breakeven trail; weak learning signal either direction.`);
  }

  if (fees != null && Number.isFinite(gross) && Math.abs(gross) > 0 && fees / Math.abs(gross) > 0.30) {
    lines.push(`Fees were ${((fees / Math.abs(gross)) * 100).toFixed(0)}% of gross — micro-size is fee-sensitive; only top-grade signals justify it.`);
  }

  return lines.join(' ');
}

// Render the "Context" section if and only if there are real headlines to
// show. Source attribution lets future-me eyeball whether the feed was
// reliable. Headlines are bullets; URL/timestamp shown when present.
export function formatContextSection(ctx) {
  if (!ctx || typeof ctx !== 'object') return [];
  const items = Array.isArray(ctx.headlines) ? ctx.headlines : [];
  const valid = items.filter((h) => h && typeof h.title === 'string' && h.title.trim());
  if (!valid.length) return [];
  const lines = ['## Context (at close)'];
  if (ctx.source) lines.push(`- Source: ${ctx.source}`);
  for (const h of valid) {
    const title = h.title.trim();
    const url = typeof h.url === 'string' && h.url ? ` — ${h.url}` : '';
    const ts = typeof h.publishedAt === 'string' && h.publishedAt ? ` (${h.publishedAt})` : '';
    const s = typeof h.sentiment === 'string' && h.sentiment && h.sentiment !== 'neutral'
      ? ` [${h.sentiment}]` : '';
    lines.push(`- ${title}${s}${ts}${url}`);
  }
  return lines;
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
  const ctxLines = formatContextSection(p?.context);
  if (ctxLines.length) {
    lines.push(...ctxLines);
    lines.push('');
  }
  lines.push('## Post-mortem');
  const pm = (p?.postMortem && String(p.postMortem).trim()) || generatePostMortem(p);
  if (pm) {
    lines.push(pm.trim());
  } else {
    lines.push('_To fill in: what went right, what went wrong, what rule to apply next time._');
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
