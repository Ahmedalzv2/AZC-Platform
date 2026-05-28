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

// Pulls the "## Sentiment (at fire)" block written by trade-learnings.mjs
// and parses it back into { label, source, agree, shadowWouldSkip } or
// null if the section is absent / malformed. Markdown is the canonical
// store: the post-mortem file on disk is what writeInsightsFile reads.
export function extractSentimentMeta(body) {
  if (!body || typeof body !== 'string') return null;
  const m = body.match(/## Sentiment \(at fire\)\s*\n([\s\S]*?)(?:\n## |\n*$)/);
  if (!m) return null;
  const block = m[1];
  const pickLine = (re) => {
    const mm = block.match(re);
    return mm ? mm[1].trim().toLowerCase() : null;
  };
  const label  = pickLine(/^- label:\s*([^\n]+)/m);
  const source = pickLine(/^- source:\s*([^\n]+)/m);
  const agreeS = pickLine(/^- agree:\s*([^\n]+)/m);
  const shadowFlag = /- shadow gate would have vetoed/i.test(block);
  if (!label) return null;
  return {
    label,
    source: source && source !== '—' ? source : null,
    agree: agreeS === 'yes',
    shadowWouldSkip: shadowFlag,
  };
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

// Bucket trades by a numeric field (e.g. fvgBodyPct) into fixed bins so
// the operator can see actual expR per range instead of guessing from
// loss-sentence counts. Edges in percent. Returns an array of
// { label, n, wins, losses, expR, netR } in label order.
export function binByPct(trades, field, edges) {
  const bins = edges.slice(0, -1).map((_, i) => ({
    label: `${(edges[i] * 100).toFixed(2)}-${(edges[i+1] * 100).toFixed(2)}%`,
    lo: edges[i], hi: edges[i+1],
    n: 0, wins: 0, losses: 0, netR: 0,
  }));
  for (const t of trades) {
    const v = t[field];
    if (!Number.isFinite(v)) continue;
    for (const b of bins) {
      if (v >= b.lo && (v < b.hi || (b === bins[bins.length - 1] && v <= b.hi))) {
        b.n += 1;
        if (t.outcome === 'win')  b.wins += 1;
        if (t.outcome === 'loss') b.losses += 1;
        if (Number.isFinite(t.rMultiple)) b.netR += t.rMultiple;
        break;
      }
    }
  }
  return bins.map(b => ({
    label: b.label,
    n: b.n,
    wins: b.wins,
    losses: b.losses,
    netR: b.netR,
    expR: b.n ? b.netR / b.n : 0,
  }));
}

// `sinceTs`: when set, drops any trade (and its post-mortem file) with
// ts < sinceTs from every aggregation. Used to exclude the pre-#221
// stop-verify-FAIL panic-close era from INSIGHTS so the dashboard
// reflects the methodology that's actually running today. Mirrors the
// side-gate filter in azc-trader.mjs.
export function buildInsights({ trades, files, now = Date.now(), sinceTs }) {
  const sample = Number.isFinite(sinceTs) && sinceTs > 0
    ? trades.filter(t => Number(t.ts) >= sinceTs)
    : trades;
  const sampleFiles = Number.isFinite(sinceTs) && sinceTs > 0
    ? files.filter(f => Number(f.trade?.ts) >= sinceTs)
    : files;
  const all     = summarise(sample);
  const last24h = summarise(sample.filter(t => now - t.ts <= 24 * 3600 * 1000));
  const last7d  = summarise(sample.filter(t => now - t.ts <=  7 * 86400 * 1000));
  const { edges, leaks } = rankLessons(sample, sampleFiles);
  const fvgBodyBins = binByPct(sample, 'fvgBodyPct', [0.0010, 0.0015, 0.0020, 0.0030, 0.0050, 0.0100]);
  return {
    generatedAt: new Date(now).toISOString(),
    all, last24h, last7d,
    edges, leaks,
    fvgBodyBins,
    trades: sample,
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

export function formatShadowCohortBlock(trades) {
  const withSent = (trades || []).filter((t) => t?.sentiment && typeof t.sentiment === 'object');
  if (!withSent.length) return '';
  const wouldVeto = withSent.filter((t) => t.sentiment.shadowWouldSkip);
  const rest      = withSent.filter((t) => !t.sentiment.shadowWouldSkip);
  const fmtCohort = (label, arr) => {
    if (!arr.length) return `${label.padEnd(12)} n=  0`;
    const sum = arr.reduce((s, t) => s + (Number(t.rMultiple) || 0), 0);
    const exp = (sum / arr.length).toFixed(3);
    return `${label.padEnd(12)} n=${String(arr.length).padStart(3)}  expR= ${exp}R  netR=  ${sum.toFixed(2)}R`;
  };
  return [
    '### Shadow gate — would-veto outcomes',
    '```',
    fmtCohort('would-veto', wouldVeto),
    fmtCohort('rest',       rest),
    '```',
  ].join('\n');
}

export function formatInsightsMarkdown(insights) {
  const { generatedAt, all, last24h, last7d, edges, leaks, fvgBodyBins } = insights;
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

  if (fvgBodyBins && fvgBodyBins.some(b => b.n > 0)) {
    lines.push('### By FVG body size');
    lines.push('_Real expectancy per bin. Trust this over loss-sentence counts when judging a knob change._');
    lines.push('```');
    for (const b of fvgBodyBins) {
      if (b.n === 0) continue;
      const expStr = (b.expR >= 0 ? '+' : '') + b.expR.toFixed(3) + 'R';
      lines.push(`${b.label.padEnd(14)} n=${String(b.n).padStart(3)} W=${String(b.wins).padStart(2)} L=${String(b.losses).padStart(2)} expR=${expStr.padStart(8)} netR=${fmtR(b.netR).padStart(8)}`);
    }
    lines.push('```');
    lines.push('');
  }

  lines.push('## Edges (recurring win-side lessons)');
  if (!edges.length) {
    lines.push('_None yet — need more wins with overlapping post-mortem sentences._');
  } else {
    for (const e of edges) {
      lines.push(`- **×${e.count}** — ${e.example}`);
    }
  }
  lines.push('');

  lines.push('## Leaks (recurring loss-side sentences — CORRELATION, not causation)');
  lines.push('_These are post-mortem sentences that show up across multiple losses. A high count means the trader keeps writing that sentence after losses, not that the cited factor caused losses. Always cross-check against the per-bin tables above before acting on one._');
  if (!leaks.length) {
    lines.push('_None yet — need more losses with overlapping post-mortem sentences._');
  } else {
    for (const l of leaks) {
      lines.push(`- **×${l.count}** — ${l.example}`);
    }
  }
  lines.push('');

  const shadowBlock = formatShadowCohortBlock(insights.trades || []);
  if (shadowBlock) {
    lines.push(shadowBlock);
    lines.push('');
  }

  return lines.join('\n');
}

// Read every post-mortem file under learnRoot, build the insights, and
// write them to learnRoot/INSIGHTS.md. Safe to call from concurrent
// /learn-trade requests — file writes are atomic at the OS level for
// small payloads, and the worst-case race is one stale render.
export async function writeInsightsFile(learnRoot, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : (typeof opts === 'number' ? opts : Date.now());
  const sinceTs = Number.isFinite(opts.sinceTs) ? opts.sinceTs : undefined;
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
  // Stitch the parsed sentiment block onto each trade so buildInsights
  // can aggregate the shadow cohort.
  for (const { trade, body } of files) {
    trade.sentiment = extractSentimentMeta(body);
  }
  const insights = buildInsights({ trades, files, now, sinceTs });
  const md = formatInsightsMarkdown(insights);
  await mkdir(learnRoot, { recursive: true });
  const out = path.join(learnRoot, 'INSIGHTS.md');
  await writeFile(out, md, 'utf8');
  return { ok: true, file: out, trades: trades.length, edges: insights.edges.length, leaks: insights.leaks.length };
}
