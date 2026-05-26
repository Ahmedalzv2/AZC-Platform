// Run the backtest, diff its summary against tests/baselines/current.json,
// exit non-zero if a regression breaches the per-metric guardrails below.
//
// Usage:
//   npm run eval            (diff against checked-in baseline)
//   npm run eval -- --bless (overwrite the baseline with the current run)
//
// Argue with the data, not from memory. Every methodology tweak should
// flow through this — if the diff column is red, justify it or roll back.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(__dirname, 'baselines', 'current.json');
const TMP_PATH      = path.join(__dirname, 'baselines', '.last-run.json');

const bless = process.argv.includes('--bless');

const r = spawnSync(process.execPath, [
  path.join(__dirname, 'backtest-azc-trader.mjs'),
  `--json=${TMP_PATH}`,
], { stdio: ['ignore', 'inherit', 'inherit'] });
if (r.status !== 0) {
  console.error('backtest failed; aborting eval-diff');
  process.exit(r.status || 1);
}

const current = JSON.parse(readFileSync(TMP_PATH, 'utf8'));

if (bless) {
  writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2));
  console.log(`\nbaseline blessed → ${BASELINE_PATH}`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error(`no baseline at ${BASELINE_PATH} — run with --bless to create one`);
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

const PASS = '\x1b[32m';   // green
const FAIL = '\x1b[31m';   // red
const WARN = '\x1b[33m';   // yellow
const DIM  = '\x1b[2m';
const NORM = '\x1b[0m';

// Tolerance bands. A tweak passes if every aggregate metric is within the
// "warn" band; a tweak fails CI if any metric breaks the "fail" band.
// FP roundoff alone never moves these metrics — anything outside the
// warn band is a real behavioural shift that should be inspected.
const BANDS = {
  trades:      { warn: 0.005, fail: 0.05 }, // ±0.5% warn, ±5% fail
  winRate:     { warn: 0.005, fail: 0.02 }, // ±0.5pp warn, ±2pp fail (abs, not %)
  expectancyR: { warn: 0.01,  fail: 0.05 }, // ±1% warn, ±5% fail
  totalR:      { warn: 0.01,  fail: 0.05 },
  netUsd:      { warn: 0.01,  fail: 0.05 },
};

const cb = baseline.aggregate;
const cc = current.aggregate;

function fmt(n, digits = 2) {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function band(metric, baseVal, currVal) {
  const { warn, fail } = BANDS[metric];
  const delta = currVal - baseVal;
  if (metric === 'winRate') {
    if (Math.abs(delta) >= fail) return delta < 0 ? 'FAIL' : 'WARN';
    if (Math.abs(delta) >= warn) return 'WARN';
    return 'PASS';
  }
  if (baseVal === 0) return Math.abs(currVal) < 1e-9 ? 'PASS' : 'WARN';
  const rel = delta / Math.abs(baseVal);
  if (Math.abs(rel) >= fail) return rel < 0 ? 'FAIL' : 'WARN';
  if (Math.abs(rel) >= warn) return 'WARN';
  return 'PASS';
}

function color(verdict) {
  if (verdict === 'PASS') return PASS;
  if (verdict === 'WARN') return WARN;
  return FAIL;
}

console.log('');
console.log('Eval diff vs ' + path.relative(process.cwd(), BASELINE_PATH));
console.log('');
console.log('metric         baseline     current      delta        verdict');
console.log('-------------  -----------  -----------  -----------  -------');

const metrics = [
  ['trades',       'trades',      0],
  ['winRate',      'win rate',    4],
  ['expectancyR',  'R/trade',     4],
  ['totalR',       'total R',     2],
  ['netUsd',       'net USD',     2],
];

let worstVerdict = 'PASS';
for (const [key, label, digits] of metrics) {
  const bv = cb[key], cv = cc[key];
  const delta = cv - bv;
  const verdict = band(key, bv, cv);
  if (verdict === 'FAIL') worstVerdict = 'FAIL';
  else if (verdict === 'WARN' && worstVerdict !== 'FAIL') worstVerdict = 'WARN';
  const deltaStr = (delta >= 0 ? '+' : '') + fmt(delta, digits);
  console.log(
    `${label.padEnd(13)}  ${fmt(bv, digits).padStart(11)}  ${fmt(cv, digits).padStart(11)}  ${deltaStr.padStart(11)}  ${color(verdict)}${verdict}${NORM}`
  );
}

// Per-symbol drill-down — surfaces which asset shifted, even if the
// aggregate held inside the band. Use FAIL band only (the warn band on a
// single symbol is noise).
console.log('');
console.log(DIM + 'per-symbol expectancyR (PASS if within ±5% of baseline):' + NORM);
const symbols = Object.keys(baseline.bySymbol || {});
for (const s of symbols) {
  const b = baseline.bySymbol[s], c = (current.bySymbol && current.bySymbol[s]) || { expectancyR: 0, trades: 0 };
  const delta = c.expectancyR - b.expectancyR;
  const rel = Math.abs(b.expectancyR) > 1e-6 ? delta / Math.abs(b.expectancyR) : 0;
  const verdict = Math.abs(rel) >= 0.05 ? (rel < 0 ? 'FAIL' : 'WARN') : 'PASS';
  if (verdict === 'FAIL') worstVerdict = 'FAIL';
  if (verdict !== 'PASS') {
    const sign = delta >= 0 ? '+' : '';
    console.log(`  ${s.padEnd(5)} base=${fmt(b.expectancyR, 4).padStart(7)}R curr=${fmt(c.expectancyR, 4).padStart(7)}R Δ=${sign}${fmt(delta, 4).padStart(7)}R  ${color(verdict)}${verdict}${NORM}`);
  }
}

console.log('');
console.log(`Verdict: ${color(worstVerdict)}${worstVerdict}${NORM}`);
console.log('');
if (worstVerdict === 'FAIL') {
  console.log('A regression broke the fail band. Either fix the cause or run with --bless after you justify the new baseline.');
  process.exit(1);
}
process.exit(0);
