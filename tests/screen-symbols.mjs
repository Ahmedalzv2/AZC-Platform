// One-shot screener — runs the live azc-trader backtest harness against
// every -90d-Min5 fixture in tests/fixtures/ and emits a single ranked
// table. Use this when adding new candidate symbols to find which ones
// clear the live-set quality bar.
//
// Usage:
//   node tests/screen-symbols.mjs
//   node tests/screen-symbols.mjs --min-win=44 --min-r=0.20  (custom bar)
//
// Default quality bar: win rate ≥ 44% (4pp above BE at RR=1.5) AND
// per-trade R ≥ +0.20R. Anything below is variance bait, not edge.

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, 'fixtures');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.replace(/^--/, '').split('=');
  return [m[0], m[1] ?? true];
}));
const MIN_WIN_PCT = Number(args['min-win'] || 44);
const MIN_R       = Number(args['min-r']   || 0.20);

const files = readdirSync(FIX_DIR).filter(f => f.endsWith('-90d-Min5.json')).sort();
const rows = [];
for (const f of files) {
  const symbol = f.split('-')[0];
  const r = spawnSync('node', [path.join(__dirname, 'backtest-azc-trader.mjs'), `--asset=${symbol}`], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  const line = (r.stdout || '').split('\n').find(l => l.trim().startsWith(symbol + ' '));
  if (!line) continue;
  const m = line.trim().split(/\s+/);
  // Layout: SYM trades wins losses BE win% totalR exp/trade
  const [sym, n, wins, losses, bes, winPctStr, totalRStr, expRStr] = m;
  rows.push({
    symbol: sym,
    n: +n,
    wins: +wins,
    losses: +losses,
    bes: +bes,
    winPct: parseFloat(winPctStr),
    totalR: parseFloat(totalRStr),
    expR: parseFloat(expRStr),
  });
}

rows.sort((a, b) => b.expR - a.expR);

console.log('Symbol screener — 90d 5m fixtures, live azc-trader rules');
console.log(`Quality bar: win% ≥ ${MIN_WIN_PCT}% AND exp/trade ≥ +${MIN_R}R`);
console.log('');
console.log('symbol    trades   wins  losses   BE    win%    totalR   exp/trade  verdict');
console.log('-------   ------   ----  ------   --   -----   --------  ---------  -------');
for (const r of rows) {
  const passes = r.winPct >= MIN_WIN_PCT && r.expR >= MIN_R;
  const tag = passes ? 'PASS' : (r.winPct >= 40 ? 'marginal' : 'FAIL');
  console.log(
    `${r.symbol.padEnd(7)}   ${String(r.n).padStart(6)}   ${String(r.wins).padStart(4)}  ${String(r.losses).padStart(6)}   ${String(r.bes).padStart(2)}   ${r.winPct.toFixed(1).padStart(4)}%  ${r.totalR.toFixed(2).padStart(7)}R  ${r.expR.toFixed(3).padStart(7)}R   ${tag}`
  );
}
console.log('');
const pass = rows.filter(r => r.winPct >= MIN_WIN_PCT && r.expR >= MIN_R);
console.log(`PASS (${pass.length}): ${pass.map(r => r.symbol).join(', ')}`);
