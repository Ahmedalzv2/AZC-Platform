// Pure helper: read trade-learnings/{wins,losses,be}/*.md and return a
// summary of how the autonomous trader is performing. Surfaces win rate,
// expectancy in R, by-symbol/by-session/by-grade breakdowns, and recent
// windows (24h / 7d). Pure file-system read + parse, no exchange calls.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const BUCKETS = ['wins', 'losses', 'be'];
// Filename shape: 2026-05-26-0153-LTC_USDT-SHORT.md
const FNAME_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-([A-Z0-9_]+)-([A-Z]+)\.md$/;

export function parseLearningFile(filename, body) {
  const m = FNAME_RE.exec(filename);
  if (!m) return null;
  const [, y, mo, d, hh, mm, symbol, side] = m;
  const ts = Date.UTC(+y, +mo - 1, +d, +hh, +mm);

  const outcomeM = body.match(/^- Outcome:\s+([A-Z]+)/m);
  const rM       = body.match(/^- Realised:\s+([+-]?\d+\.\d+)\s+USD\s+([+-]?\d+\.\d+)R/m);
  const sessionM = body.match(/^- Session:\s+(\S+)/m);
  const gradeM   = body.match(/^- Grade:\s+(\S+)/m);
  const biasM    = body.match(/^- Bias:\s+(\S+)/m);

  const outcome = outcomeM ? outcomeM[1].toLowerCase() : null;
  const realizedUsd = rM ? Number(rM[1]) : null;
  const rMultiple   = rM ? Number(rM[2]) : null;
  const session     = sessionM && sessionM[1] !== '—' ? sessionM[1] : null;
  const grade       = gradeM && gradeM[1] !== '—' ? gradeM[1] : null;
  const bias        = biasM && biasM[1] !== '—' ? biasM[1] : null;

  return { filename, ts, symbol, side, outcome, realizedUsd, rMultiple, session, grade, bias };
}

export function summarise(trades) {
  const out = {
    total: trades.length, wins: 0, losses: 0, be: 0,
    winRate: null, expectancyR: null, netUsd: 0, netR: 0,
    bySymbol: {}, bySession: {}, byGrade: {}, bySide: {},
  };
  if (!trades.length) return out;
  let rTotal = 0, rCount = 0;
  for (const t of trades) {
    if (t.outcome === 'win')  out.wins += 1;
    if (t.outcome === 'loss') out.losses += 1;
    if (t.outcome === 'be')   out.be += 1;
    if (Number.isFinite(t.realizedUsd)) out.netUsd += t.realizedUsd;
    if (Number.isFinite(t.rMultiple))   { out.netR += t.rMultiple; rTotal += t.rMultiple; rCount += 1; }
    bump(out.bySymbol,  t.symbol,  t);
    bump(out.bySession, t.session || 'no-killzone', t);
    bump(out.byGrade,   t.grade   || 'unknown',     t);
    bump(out.bySide,    t.side    || 'unknown',     t);
  }
  const resolved = out.wins + out.losses;
  out.winRate     = resolved ? out.wins / resolved : null;
  out.expectancyR = rCount   ? rTotal / rCount     : null;
  return out;
}

function bump(bag, key, t) {
  const k = String(key);
  const b = bag[k] ||= { n: 0, w: 0, l: 0, be: 0, netR: 0 };
  b.n += 1;
  if (t.outcome === 'win')  b.w  += 1;
  if (t.outcome === 'loss') b.l  += 1;
  if (t.outcome === 'be')   b.be += 1;
  if (Number.isFinite(t.rMultiple)) b.netR += t.rMultiple;
}

export async function collectTrades(learnRoot) {
  const trades = [];
  for (const bucket of BUCKETS) {
    const dir = path.join(learnRoot, bucket);
    let entries = [];
    try { entries = await readdir(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.md')) continue;
      let body;
      try { body = await readFile(path.join(dir, f), 'utf8'); } catch { continue; }
      const t = parseLearningFile(f, body);
      if (t) trades.push(t);
    }
  }
  trades.sort((a, b) => a.ts - b.ts);
  return trades;
}

export async function buildStats(learnRoot, now = Date.now()) {
  const trades = await collectTrades(learnRoot);
  const last24h = trades.filter(t => now - t.ts <= 24 * 3600 * 1000);
  const last7d  = trades.filter(t => now - t.ts <= 7 * 86400 * 1000);
  return {
    generatedAt: new Date(now).toISOString(),
    all: summarise(trades),
    last24h: summarise(last24h),
    last7d: summarise(last7d),
    recent: trades.slice(-10).map(t => ({
      ts: t.ts, symbol: t.symbol, side: t.side,
      outcome: t.outcome, rMultiple: t.rMultiple, realizedUsd: t.realizedUsd,
      session: t.session, grade: t.grade,
    })),
  };
}
