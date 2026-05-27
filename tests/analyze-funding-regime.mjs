// Funding-rate regime analyser.
//
// Joins the per-trade list from the backtest harness with MEXC funding
// history and reports win rate / expectancy by (symbol, regime, side).
// The question this answers: does the funding rate at fire time predict
// FVG-retest outcomes?
//
// Run order:
//   1. node tests/dump-funding.mjs                          (refresh fixtures)
//   2. node tests/backtest-azc-trader.mjs --days=365 \
//        --assets=SOL,XRP --trades-json=/tmp/trades-365.json
//   3. node tests/analyze-funding-regime.mjs \
//        --trades=/tmp/trades-365.json
//
// Output: regime breakdown per symbol + side, with delta-vs-baseline.
// If any regime/side combo shifts expectancy >=10pp from baseline AND
// has n>=30, that's a candidate for wiring into the live drift gate.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, 'fixtures');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.replace(/^--/, '').split('=');
  return [m[0], m[1] ?? true];
}));

const TRADES_PATH = args.trades || '/tmp/trades-365.json';
const trades = JSON.parse(readFileSync(TRADES_PATH, 'utf8'));

// Regime cutoffs are set from the empirical fire-time distribution
// (tests/dump-funding.mjs run 2026-05-27): MEXC caps SOL/XRP funding at
// ±0.0001 per 8h cycle, and the p25/p75 of rates at our fire times are
// roughly -0.000038 / +0.000069. Conventional ±0.0001 "extreme" cutoffs
// from broader crypto perps produce empty buckets here. Use the actual
// quartiles to get cells with n big enough to draw a conclusion.
const POS_CUTOFF = 0.00007;
const NEG_CUTOFF = -0.00004;

// Load funding histories per symbol. Files are oldest-first.
const funding = {};
for (const sym of ['SOL', 'XRP']) {
  const p = path.join(FIX_DIR, `${sym}-365d-funding.json`);
  funding[sym] = JSON.parse(readFileSync(p, 'utf8'));
}

function regimeFor(sym, fireTs) {
  // Binary-search the most recent funding settlement strictly before
  // fireTs. If none exists, return null (trade is older than our
  // funding history and we can't classify).
  const hist = funding[sym];
  if (!hist || !hist.length) return null;
  let lo = 0, hi = hist.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hist[mid].ts <= fireTs) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx < 0) return null;
  const rate = hist[idx].rate;
  if (rate > POS_CUTOFF) return { label: 'EXTREME_POS', rate };
  if (rate < NEG_CUTOFF) return { label: 'EXTREME_NEG', rate };
  return { label: 'NEUTRAL', rate };
}

// Tag every trade with its regime.
const tagged = [];
let unclassified = 0;
for (const t of trades) {
  const sym = t.symbol;
  const r = regimeFor(sym, t.ts);
  if (!r) { unclassified += 1; continue; }
  tagged.push({ ...t, regime: r.label, fundingRate: r.rate });
}

console.log(`Total trades: ${trades.length} · classified: ${tagged.length} · unclassified: ${unclassified}`);
console.log('');

// Cell summary helper.
function summarise(list) {
  const n = list.length;
  if (!n) return { n: 0, wins: 0, losses: 0, winRate: 0, expR: 0, netUsd: 0 };
  const wins = list.filter(t => t.outcome === 'win').length;
  const losses = list.filter(t => t.outcome === 'loss').length;
  const totalR = list.reduce((a, t) => a + (t.rMultiple || 0), 0);
  const netUsd = list.reduce((a, t) => a + (t.netUsd || 0), 0);
  return {
    n,
    wins,
    losses,
    winRate: (wins + losses) ? wins / (wins + losses) : 0,
    expR: totalR / n,
    netUsd,
  };
}

// Table: symbol × regime × side
const SYMBOLS = ['SOL', 'XRP'];
const REGIMES = ['EXTREME_NEG', 'NEUTRAL', 'EXTREME_POS'];
const SIDES = ['bull', 'bear'];

console.log('Regime breakdown · win rate · R/trade · netUsd');
console.log('═'.repeat(82));
console.log('symbol  regime         side    n     wins  losses  win%      R/trade   netUsd');
console.log('─'.repeat(82));

// Baseline per (symbol, side) for delta calculation
const baseline = {};
for (const sym of SYMBOLS) {
  for (const side of SIDES) {
    baseline[`${sym}/${side}`] = summarise(tagged.filter(t => t.symbol === sym && t.dir === side));
  }
}

const findings = [];
for (const sym of SYMBOLS) {
  for (const regime of REGIMES) {
    for (const side of SIDES) {
      const cell = tagged.filter(t => t.symbol === sym && t.regime === regime && t.dir === side);
      const s = summarise(cell);
      const b = baseline[`${sym}/${side}`];
      const deltaWr = (s.winRate - b.winRate) * 100;
      const deltaR = s.expR - b.expR;
      console.log(
        `${sym.padEnd(7)} ${regime.padEnd(13)} ${side.padEnd(6)} ${String(s.n).padStart(4)}  ` +
        `${String(s.wins).padStart(4)}  ${String(s.losses).padStart(6)}  ` +
        `${(s.winRate * 100).toFixed(1).padStart(5)}%   ${s.expR.toFixed(3).padStart(7)}R   $${s.netUsd.toFixed(2).padStart(7)}`
      );
      if (s.n >= 15 && Math.abs(deltaR) >= 0.10) {
        findings.push({ sym, regime, side, n: s.n, expR: s.expR, baselineR: b.expR, deltaR, deltaWr });
      }
    }
  }
}

console.log('─'.repeat(82));

// Per-symbol baselines for reference
console.log('');
console.log('Per-symbol baselines (all regimes pooled):');
for (const sym of SYMBOLS) {
  for (const side of SIDES) {
    const b = baseline[`${sym}/${side}`];
    console.log(
      `  ${sym}/${side.padEnd(5)}  n=${String(b.n).padStart(4)}  wr=${(b.winRate * 100).toFixed(1)}%  R/trade=${b.expR.toFixed(3)}R  net=$${b.netUsd.toFixed(2)}`
    );
  }
}
console.log('');

// Findings — cells with n>=30 AND delta R/trade >= 0.10 vs baseline.
// This is the bar for "worth wiring into the drift gate." Smaller deltas
// are likely noise at this sample size.
if (!findings.length) {
  console.log('No regime/side cell exceeds the n>=15, |ΔR/trade| >= 0.10 bar.');
  console.log('Conclusion: funding rate does not give the FVG strategy a material edge.');
} else {
  console.log('CANDIDATE CELLS (n>=15 and |ΔR/trade| >= 0.10 vs same-side baseline):');
  for (const f of findings) {
    const sign = f.deltaR >= 0 ? '+' : '';
    console.log(
      `  ${f.sym}/${f.side}/${f.regime}: n=${f.n}, R/trade=${f.expR.toFixed(3)} ` +
      `(baseline ${f.baselineR.toFixed(3)}, Δ=${sign}${f.deltaR.toFixed(3)}R, Δwr=${sign}${f.deltaWr.toFixed(1)}pp)`
    );
  }
  console.log('');
  console.log('Sample-size caveat: cells with n<30 are suggestive, not conclusive.');
  console.log('A forward-only paper-test (tag live trades with regime, do not change');
  console.log('behaviour) for 3-6 months would lift the n high enough to act on.');
}
