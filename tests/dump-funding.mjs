// Funding-rate history dumper for the FVG-vs-funding regime study.
//
// MEXC's funding-rate history endpoint is public and paginated. Each row
// is one 8h settlement: { fundingRate, settleTime, collectCycle }.
//
// We pull back to ~400 days for SOL_USDT and XRP_USDT (the live whitelist),
// save flat JSON arrays at tests/fixtures/<SYMBOL>-365d-funding.json.
//
// Run once, commit. Re-run only when refreshing the screen.

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, 'fixtures');
if (!existsSync(FIX_DIR)) mkdirSync(FIX_DIR, { recursive: true });

const SYMBOLS = ['SOL_USDT', 'XRP_USDT'];
const PAGE_SIZE = 100;
const TARGET_DAYS = 400;
const NOW = Date.now();
const CUTOFF = NOW - TARGET_DAYS * 24 * 60 * 60 * 1000;

async function fetchPage(symbol, page) {
  const url = `https://contract.mexc.com/api/v1/contract/funding_rate/history?symbol=${symbol}&page_num=${page}&page_size=${PAGE_SIZE}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${symbol} page ${page}`);
  const j = await r.json();
  if (!j.success) throw new Error(`MEXC error: ${j.message || 'unknown'}`);
  return j.data?.resultList || [];
}

for (const symbol of SYMBOLS) {
  const key = symbol.replace('_USDT', '');
  const out = path.join(FIX_DIR, `${key}-365d-funding.json`);
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const rows = await fetchPage(symbol, page);
    if (!rows.length) break;
    let stop = false;
    for (const r of rows) {
      if (r.settleTime < CUTOFF) { stop = true; break; }
      all.push({
        ts: r.settleTime,
        rate: +r.fundingRate,
        cycleHours: +r.collectCycle,
      });
    }
    if (stop) break;
    if (rows.length < PAGE_SIZE) break;
  }
  // Sort oldest-first to match how the 5m fixtures are stored.
  all.sort((a, b) => a.ts - b.ts);
  writeFileSync(out, JSON.stringify(all));
  const oldest = new Date(all[0]?.ts).toISOString().slice(0, 10);
  const newest = new Date(all[all.length - 1]?.ts).toISOString().slice(0, 10);
  console.log(`${symbol}: ${all.length} settlements, ${oldest} → ${newest} → ${out}`);
}
