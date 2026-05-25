// One-shot dumper for MEXC perp klines used by backtests + forward-bias.
//
// Run this ONCE on a machine that can reach MEXC, commit the JSON files
// it writes under tests/fixtures/, and every subsequent backtest run can
// replay them offline (the backtester auto-discovers files in fixtures/).
//
// Usage:
//   node tests/dump-fixtures.mjs                                  (all assets, 90d, Min5)
//   node tests/dump-fixtures.mjs --days=30 --interval=Min1        (1m for shorter window)
//   node tests/dump-fixtures.mjs --assets=SILVER,GOLD             (subset)
//   node tests/dump-fixtures.mjs --force                          (overwrite existing)
//
// Notes:
// - MEXC retains Min1 ~30d, Min5/15/60 much further back. Default Min5+90d
//   gives a coherent OOS window for SILVER/GOLD ICT-signal research.
// - US100 is CFD-only, no MEXC contract — skipped.
// - Files land at tests/fixtures/{ASSET}-{days}d-{interval}.json as a flat
//   [{t,o,h,l,c,v}, ...] array (no fetchedAt wrapper — keeps diffs clean).

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
if (!existsSync(FIXTURES_DIR)) mkdirSync(FIXTURES_DIR, { recursive: true });

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.replace(/^--/, '').split('=');
  return [m[0], m[1] ?? true];
}));

const DAYS = Number(args.days || 90);
const INTERVAL = String(args.interval || 'Min5');
const INTERVAL_MIN = { Min1: 1, Min5: 5, Min15: 15, Min60: 60 }[INTERVAL];
if (!INTERVAL_MIN) {
  console.error(`Unknown --interval "${INTERVAL}". Use Min1, Min5, Min15, or Min60.`);
  process.exit(1);
}
const FORCE = Boolean(args.force);

const ALL_ASSETS = {
  SILVER: 'SILVER_USDT',
  GOLD:   'XAUT_USDT',
  SOL:    'SOL_USDT',
  BTC:    'BTC_USDT',
  ETH:    'ETH_USDT',
  BNB:    'BNB_USDT',
  XRP:    'XRP_USDT',
  DOGE:   'DOGE_USDT',
  AVAX:   'AVAX_USDT',
  LINK:   'LINK_USDT',
};
const requested = args.assets
  ? String(args.assets).split(',').map((s) => s.trim().toUpperCase())
  : Object.keys(ALL_ASSETS);
for (const a of requested) {
  if (!ALL_ASSETS[a]) {
    console.error(`Unknown asset "${a}". Available: ${Object.keys(ALL_ASSETS).join(', ')}`);
    process.exit(1);
  }
}

async function fetchKlineChunk(symbol, startSec, endSec) {
  const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${INTERVAL}&start=${startSec}&end=${endSec}`;
  const proxies = [
    (u) => u,
    (u) => 'https://corsproxy.io/?' + encodeURIComponent(u),
  ];
  for (const wrap of proxies) {
    try {
      const r = await fetch(wrap(url), { cache: 'no-store' });
      if (!r.ok) continue;
      const j = await r.json();
      const d = j?.data;
      if (d && Array.isArray(d.time) && d.time.length) {
        return d.time.map((t, i) => ({
          t: t * 1000,
          o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i],
          v: +(d.vol?.[i] || 0),
        }));
      }
      if (Array.isArray(d) && d.length) {
        return d.map((k) => ({
          t: +(k.t || k.time || 0) * 1000,
          o: +(k.o ?? k.open), h: +(k.h ?? k.high),
          l: +(k.l ?? k.low),  c: +(k.c ?? k.close),
          v: +(k.v ?? k.vol ?? 0),
        }));
      }
    } catch (e) { /* try next proxy */ }
  }
  return [];
}

async function dumpAsset(asset, contract) {
  const outPath = path.join(FIXTURES_DIR, `${asset}-${DAYS}d-${INTERVAL}.json`);
  if (existsSync(outPath) && !FORCE) {
    console.log(`SKIP ${asset} — ${outPath} already exists (--force to overwrite)`);
    return { asset, skipped: true };
  }
  console.log(`Fetching ${DAYS}d of ${INTERVAL} ${contract}...`);
  const endSec = Math.floor(Date.now() / 1000);
  const startSec = endSec - DAYS * 86400;
  const chunkSec = INTERVAL_MIN >= 5 ? 7 * 86400 : 86400;
  const chunks = [];
  for (let s = startSec; s < endSec; s += chunkSec) {
    const e = Math.min(s + chunkSec, endSec);
    const c = await fetchKlineChunk(contract, s, e);
    chunks.push(c);
    process.stdout.write(`  ${new Date(s*1000).toISOString().slice(0,10)} → ${c.length} candles\n`);
  }
  const byTs = new Map();
  for (const c of chunks) for (const k of c) byTs.set(k.t, k);
  const klines = Array.from(byTs.values()).sort((a, b) => a.t - b.t);
  if (!klines.length) {
    console.error(`✗ ${asset}: 0 candles returned — MEXC may have blocked the request.`);
    return { asset, failed: true };
  }
  writeFileSync(outPath, JSON.stringify(klines));
  const first = new Date(klines[0].t).toISOString().slice(0,10);
  const last  = new Date(klines[klines.length-1].t).toISOString().slice(0,10);
  const kb = Math.round(JSON.stringify(klines).length / 1024);
  console.log(`✓ ${asset}: ${klines.length} candles · ${first} → ${last} · ${kb} KB → ${outPath}`);
  return { asset, count: klines.length };
}

const results = [];
for (const asset of requested) {
  try {
    results.push(await dumpAsset(asset, ALL_ASSETS[asset]));
  } catch (e) {
    console.error(`✗ ${asset} crashed: ${e.message}`);
    results.push({ asset, failed: true, error: e.message });
  }
}

console.log('\n─── Summary ───');
for (const r of results) {
  if (r.skipped) console.log(`  ${r.asset.padEnd(8)} skipped`);
  else if (r.failed) console.log(`  ${r.asset.padEnd(8)} FAILED`);
  else console.log(`  ${r.asset.padEnd(8)} ${r.count} candles`);
}
const failed = results.filter((r) => r.failed).length;
if (failed) {
  console.error(`\n${failed} asset(s) failed. Check network access to contract.mexc.com.`);
  process.exit(1);
}
console.log(`\nCommit + push tests/fixtures/ so any session can replay these:`);
console.log(`  git add tests/fixtures/`);
console.log(`  git commit -m "Snapshot ${DAYS}d ${INTERVAL} klines for offline backtest"`);
console.log(`  git push`);
