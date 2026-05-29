// Collapse a shadow lane's signal JSONL (entry/exit/skip records from
// trend-shadow.mjs or meanrev-shadow.mjs) into one card-sized summary: how
// many decisions, the win/loss tally and modeled net-R from exits, and the
// most recent signal. The relay serves this so the dashboard shows lane
// behaviour without shipping the whole stream to the browser.
//
// Lane-agnostic: mean-rev shadows log only entry/skip (no exits in dry-run),
// trend logs exits with netR too — both fold into the same shape.

const LAST_FIELDS = ['ts', 'decision', 'symbol', 'dir', 'reason'];

export function summarizeShadowSignals(records) {
  const s = { count: records.length, entries: 0, exits: 0, skips: 0, wins: 0, losses: 0, netRSum: 0, lastTs: null, last: null };
  let netR = 0, latest = null;
  for (const r of records) {
    if (r.decision === 'entry') s.entries += 1;
    else if (r.decision === 'skip') s.skips += 1;
    else if (r.decision === 'exit') {
      s.exits += 1;
      if (r.win === true) s.wins += 1; else if (r.win === false) s.losses += 1;
      if (typeof r.netR === 'number') netR += r.netR;
    }
    if (latest === null || (typeof r.ts === 'number' && r.ts > latest.ts)) latest = r;
  }
  s.netRSum = Math.round(netR * 1000) / 1000;
  if (latest) {
    s.lastTs = latest.ts ?? null;
    s.last = {};
    for (const f of LAST_FIELDS) if (latest[f] !== undefined) s.last[f] = latest[f];
  }
  return s;
}
