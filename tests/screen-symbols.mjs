// One-shot screener — runs the live azc-trader backtest harness against
// every -90d-Min5 fixture in tests/fixtures/ and emits a single ranked
// table. Use this when adding new candidate symbols to find which ones
// clear the live-set quality bar.
//
// Usage:
//   node tests/screen-symbols.mjs
//   node tests/screen-symbols.mjs --min-win=44 --min-r=0.20  (custom bar)
//
// Default quality bar: win rate ≥ 40% (4pp above BE at RR=1.8) AND
// per-trade R ≥ +0.20R. Anything below is variance bait, not edge.

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { RR } from '../trader-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, 'fixtures');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.replace(/^--/, '').split('=');
  return [m[0], m[1] ?? true];
}));
// BE at RR=1.8 is 35.7%; add ~4pp margin for variance bait → 40%.
const MIN_WIN_PCT = Number(args['min-win'] || 40);
const MIN_R       = Number(args['min-r']   || 0.20);

const files = readdirSync(FIX_DIR).filter(f => f.endsWith('-90d-Min5.json')).sort();
const rows = [];
for (const f of files) {
  const symbol = f.split('-')[0];
  const r = spawnSync('node', [path.join(__dirname, 'backtest-azc-trader.mjs'), `--asset=${symbol}`], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  const line = (r.stdout || '').split('\n').find(l => l.trim().startsWith(symbol + ' '));
  if (!line) continue;
  // Backtest line shape:
  //   SYM trades wins loss BE win%  $ netUSD  $ $/trade  totalR  R/trade  fees%gross
  // After tokenizing on whitespace, the `$` characters appear as their
  // own tokens — filter them out so column indexes line up.
  const tokens = line.trim().split(/\s+/).filter(t => t !== '$');
  const [sym, n, wins, losses, bes, winPctStr, _netUsdStr, _expUsdStr, totalRStr, expRStr] = tokens;
  rows.push({
    symbol: sym,
    n: +n,
    wins: +wins,
    losses: +losses,
    bes: +bes,
    winPct: parseFloat(winPctStr),
    totalR: parseFloat(totalRStr),  // strips trailing 'R'
    expR: parseFloat(expRStr),
  });
}

// Fail loud on NaN — silent NaNs were what made the screener untrustworthy
// in the first place. If any field is NaN, the parser regressed.
const bad = rows.filter(r => !Number.isFinite(r.winPct) || !Number.isFinite(r.totalR) || !Number.isFinite(r.expR));
if (bad.length) {
  console.error('Screener parse error — NaN in extracted fields:');
  for (const r of bad) console.error(`  ${r.symbol}: winPct=${r.winPct} totalR=${r.totalR} expR=${r.expR}`);
  console.error('Backtest output shape probably changed; re-align tokens in screen-symbols.mjs.');
  process.exit(2);
}

rows.sort((a, b) => b.expR - a.expR);

console.log('Symbol screener — 90d 5m fixtures, live azc-trader rules (RR=' + RR + ')');
console.log(`Quality bar: win% ≥ ${MIN_WIN_PCT}% AND exp/trade ≥ +${MIN_R}R`);
console.log('');
console.log('symbol    trades   wins  losses   BE    win%    totalR     exp/trade  verdict   note');
console.log('-------   ------   ----  ------   --   -----   --------    ---------  -------   -----------------------');
for (const r of rows) {
  const passes = r.winPct >= MIN_WIN_PCT && r.expR >= MIN_R;
  const marginal = !passes && r.winPct >= MIN_WIN_PCT - 5 && r.expR >= 0;
  const tag = passes ? 'PASS' : marginal ? 'marginal' : 'FAIL';
  const why = passes ? ''
            : marginal ? `wr ${r.winPct.toFixed(1)}% / ${r.expR.toFixed(2)}R — below bar but positive`
            : `wr ${r.winPct.toFixed(1)}% / ${r.expR.toFixed(2)}R — bleeds`;
  console.log(
    `${r.symbol.padEnd(7)}   ${String(r.n).padStart(6)}   ${String(r.wins).padStart(4)}  ${String(r.losses).padStart(6)}   ${String(r.bes).padStart(2)}   ${r.winPct.toFixed(1).padStart(4)}%  ${r.totalR.toFixed(2).padStart(8)}R  ${r.expR.toFixed(3).padStart(8)}R   ${tag.padEnd(8)}  ${why}`
  );
}
console.log('');
const pass = rows.filter(r => r.winPct >= MIN_WIN_PCT && r.expR >= MIN_R);
console.log(`PASS (${pass.length}): ${pass.map(r => r.symbol).join(', ')}`);
