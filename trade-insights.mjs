// Consolidator over trade-learnings/{wins,losses,be}/*.md — extracts the
// recurring "Post-mortem" sentences and the trade-stats summary into a
// single INSIGHTS.md that the dashboard (and the operator) can actually
// skim. The individual files are still authoritative; this layer just
// surfaces what they say in aggregate.
//
// Pure formatter + a writer. Tests drive the formatter with synthesised
// inputs; the writer only matters at the integration boundary.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { collectTrades, summarise } from './trade-stats.mjs';

const BUCKETS = ['wins', 'losses', 'be'];

// Split a Post-mortem block into discrete sentences. The auto-generated
// text in trade-learnings.mjs is " "-joined sentences ending in ".", so
// splitting on ". " gets us the natural unit. Trims and de-dupes
// punctuation-only fragments.
export function splitPostMortemSentences(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    // Drop the markdown italic placeholder ("_To fill in: ..._") and
    // anything shorter than a real sentence. We need at least one letter
    // and meaningful length so punctuation-only or numeric fragments
    // don't get ranked.
    .filter(s =>
      s.length > 8 &&
      /[a-zA-Z]/.test(s) &&
      !/^_?to fill in/i.test(s)
    );
}

// Extract the "## Post-mortem" section body from a learning file.
export function extractPostMortemBlock(body) {
  if (!body || typeof body !== 'string') return '';
  const m = body.match(/## Post-mortem\s*\n([\s\S]*?)(?:\n## |\n*$)/);
  return m ? m[1].trim() : '';
}

// Normalise a sentence into a key for counting. We keep the prose but
// strip numerals so "FVG body 0.12% is below 0.20%" and "FVG body 0.21%
// is below 0.20%" count as the same lesson. The original prose is kept
// for display.
export function normaliseLessonKey(sentence) {
  return sentence
    .replace(/[+\-]?\d+(?:\.\d+)?\s?%?/g, '#')   // numerics → #
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function rankLessons(parsedTrades, files, opts = {}) {
  const minN = Number.isFinite(opts.minN) ? opts.minN : 2;
  const buckets = { wins: new Map(), losses: new Map(), be: new Map() };
  for (const { trade, body } of files) {
    const block = extractPostMortemBlock(body);
    if (!block) continue;
    const sentences = splitPostMortemSentences(block);
    const bucket = trade.outcome === 'win'  ? buckets.wins
                 : trade.outcome === 'loss' ? buckets.losses
                 : buckets.be;
    for (const s of sentences) {
      const k = normaliseLessonKey(s);
      if (!k) continue;
      if (!bucket.has(k)) bucket.set(k, { example: s, count: 0, sample: [] });
      const entry = bucket.get(k);
      entry.count += 1;
      if (entry.sample.length < 3) entry.sample.push({ symbol: trade.symbol, side: trade.side, ts: trade.ts });
    }
  }
  const top = (bag, limit) => Array.from(bag.values())
    .filter(e => e.count >= minN)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
  return {
    edges: top(buckets.wins,   5),
    leaks: top(buckets.losses, 5),
  };
}

export function buildInsights({ trades, files, now = Date.now() }) {
  const all     = summarise(trades);
  const last24h = summarise(trades.filter(t => now - t.ts <= 24 * 3600 * 1000));
  const last7d  = summarise(trades.filter(t => now - t.ts <=  7 * 86400 * 1000));
  const { edges, leaks } = rankLessons(trades, files);
  return {
    generatedAt: new Date(now).toISOString(),
    all, last24h, last7d,
    edges, leaks,
  };
}

function fmtR(n) {
  return Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(2) + 'R' : '—';
}
function fmtPct(n) {
  return Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : '—';
}
function fmtUsd(n) {
  return Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(2) + ' USD' : '—';
}

function statsLine(label, s) {
  if (!s || !s.total) return `- ${label}: no resolved trades`;
  return `- ${label}: ${s.total} trades · WR ${fmtPct(s.winRate)} · expectancy ${fmtR(s.expectancyR)} · net ${fmtUsd(s.netUsd)}`;
}

function topGroup(bag, label) {
  if (!bag || !Object.keys(bag).length) return null;
  const rows = Object.entries(bag)
    .filter(([_, v]) => v.n >= 2)
    .map(([k, v]) => ({ key: k, n: v.n, w: v.w, l: v.l, expR: v.n ? v.netR / v.n : 0, netR: v.netR }))
    .sort((a, b) => b.netR - a.netR);
  if (!rows.length) return null;
  const fmt = (r) => `${r.key.padEnd(14)} n=${String(r.n).padStart(3)} W=${String(r.w).padStart(2)} L=${String(r.l).padStart(2)} expR=${fmtR(r.expR).padStart(7)} netR=${fmtR(r.netR).padStart(8)}`;
  const lines = [`### ${label}`, '```', ...rows.map(fmt), '```'];
  return lines.join('\n');
}

export function formatInsightsMarkdown(insights) {
  const { generatedAt, all, last24h, last7d, edges, leaks } = insights;
  const lines = [];
  lines.push('# Trade Insights');
  lines.push('');
  lines.push(`_Auto-generated ${generatedAt}. Source: trade-learnings/{wins,losses,be}/*.md._`);
  lines.push('');
  lines.push('## Performance');
  lines.push(statsLine('All-time', all));
  lines.push(statsLine('Last 7d ', last7d));
  lines.push(statsLine('Last 24h', last24h));
  lines.push('');

  const symBlock = topGroup(all.bySymbol, 'By symbol');
  if (symBlock) { lines.push(symBlock); lines.push(''); }
  const sessBlock = topGroup(all.bySession, 'By session');
  if (sessBlock) { lines.push(sessBlock); lines.push(''); }
  const gradeBlock = topGroup(all.byGrade, 'By grade');
  if (gradeBlock) { lines.push(gradeBlock); lines.push(''); }

  lines.push('## Edges (recurring win-side lessons)');
  if (!edges.length) {
    lines.push('_None yet — need more wins with overlapping post-mortem sentences._');
  } else {
    for (const e of edges) {
      lines.push(`- **×${e.count}** — ${e.example}`);
    }
  }
  lines.push('');

  lines.push('## Leaks (recurring loss-side lessons)');
  if (!leaks.length) {
    lines.push('_None yet — need more losses with overlapping post-mortem sentences._');
  } else {
    for (const l of leaks) {
      lines.push(`- **×${l.count}** — ${l.example}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

// Read every post-mortem file under learnRoot, build the insights, and
// write them to learnRoot/INSIGHTS.md. Safe to call from concurrent
// /learn-trade requests — file writes are atomic at the OS level for
// small payloads, and the worst-case race is one stale render.
export async function writeInsightsFile(learnRoot, now = Date.now()) {
  const trades = await collectTrades(learnRoot);
  const files = [];
  for (const bucket of BUCKETS) {
    const dir = path.join(learnRoot, bucket);
    let entries = [];
    try { entries = await readdir(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.md')) continue;
      let body;
      try { body = await readFile(path.join(dir, f), 'utf8'); } catch { continue; }
      const trade = trades.find(t => t.filename === f);
      if (!trade) continue;
      files.push({ trade, body });
    }
  }
  const insights = buildInsights({ trades, files, now });
  const md = formatInsightsMarkdown(insights);
  await mkdir(learnRoot, { recursive: true });
  const out = path.join(learnRoot, 'INSIGHTS.md');
  await writeFile(out, md, 'utf8');
  return { ok: true, file: out, trades: trades.length, edges: insights.edges.length, leaks: insights.leaks.length };
}
