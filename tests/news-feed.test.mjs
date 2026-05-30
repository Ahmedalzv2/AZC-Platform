import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, aggregateNews } from '../news-feed.mjs';

const RSS_SAMPLE = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>CoinDesk</title>
  <item>
    <title><![CDATA[Bitcoin tops $70k as ETF inflows surge]]></title>
    <link>https://example.com/btc-70k</link>
    <pubDate>Tue, 30 May 2026 09:15:00 GMT</pubDate>
    <description><![CDATA[<p>Spot ETFs pulled in $1.2B &amp; pushed price higher.</p>]]></description>
  </item>
  <item>
    <title>Ether staking yields tick up</title>
    <link>https://example.com/eth-staking</link>
    <pubDate>Tue, 30 May 2026 08:00:00 GMT</pubDate>
    <description>Validators see higher rewards</description>
  </item>
</channel></rss>`;

const ATOM_SAMPLE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Decrypt</title>
  <entry>
    <title>Solana DEX volume hits record</title>
    <link rel="alternate" href="https://example.com/sol-dex"/>
    <updated>2026-05-30T07:30:00Z</updated>
    <summary>On-chain activity climbs.</summary>
  </entry>
</feed>`;

test('parseFeed extracts RSS items with decoded title, url, ts, source', () => {
  const items = parseFeed(RSS_SAMPLE, 'CoinDesk');
  assert.equal(items.length, 2);
  const first = items[0];
  assert.equal(first.title, 'Bitcoin tops $70k as ETF inflows surge');
  assert.equal(first.url, 'https://example.com/btc-70k');
  assert.equal(first.source, 'CoinDesk');
  // RFC-822 pubDate → unix seconds
  assert.equal(first.published, Math.floor(Date.parse('Tue, 30 May 2026 09:15:00 GMT') / 1000));
  // HTML stripped + entities decoded in body
  assert.match(first.body, /Spot ETFs pulled in \$1\.2B & pushed price higher\./);
  assert.doesNotMatch(first.body, /<p>|&amp;/);
});

test('parseFeed handles Atom entries (link href + updated + summary)', () => {
  const items = parseFeed(ATOM_SAMPLE, 'Decrypt');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Solana DEX volume hits record');
  assert.equal(items[0].url, 'https://example.com/sol-dex');
  assert.equal(items[0].published, Math.floor(Date.parse('2026-05-30T07:30:00Z') / 1000));
});

test('parseFeed returns [] on garbage, never throws', () => {
  assert.deepEqual(parseFeed('not xml at all', 'X'), []);
  assert.deepEqual(parseFeed('', 'X'), []);
  assert.deepEqual(parseFeed(null, 'X'), []);
});

test('aggregateNews dedupes by url, sorts newest-first, tolerates a failing feed', async () => {
  const feeds = [
    { source: 'A', url: 'http://a' },
    { source: 'B', url: 'http://b' },
    { source: 'Dead', url: 'http://dead' },
  ];
  const fakeFetch = async (u) => {
    if (u === 'http://dead') throw new Error('ENOTFOUND');
    if (u === 'http://a') return { ok: true, text: async () => RSS_SAMPLE };
    // B repeats one of A's URLs (dupe) plus the atom one
    return { ok: true, text: async () => ATOM_SAMPLE.replace('sol-dex', 'btc-70k') };
  };
  const out = await aggregateNews({ feeds, fetchImpl: fakeFetch, ttlMs: 0, cache: {} });
  // 2 from A + 1 from B, minus the dupe url → 2 unique (btc-70k dupe collapses)
  const urls = out.articles.map(a => a.url);
  assert.equal(new Set(urls).size, urls.length, 'no duplicate urls');
  assert.ok(out.articles.length >= 2);
  // newest first
  for (let i = 1; i < out.articles.length; i++) {
    assert.ok(out.articles[i - 1].published >= out.articles[i].published);
  }
  // dead feed surfaced as an error, not a throw
  assert.ok(out.errors.some(e => e.source === 'Dead'));
});

test('aggregateNews serves cache within ttl without re-fetching', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return { ok: true, text: async () => RSS_SAMPLE }; };
  const cache = {};
  const feeds = [{ source: 'A', url: 'http://a' }];
  await aggregateNews({ feeds, fetchImpl: fakeFetch, ttlMs: 60_000, cache, now: 1000 });
  const callsAfterFirst = calls;
  await aggregateNews({ feeds, fetchImpl: fakeFetch, ttlMs: 60_000, cache, now: 5000 });
  assert.equal(calls, callsAfterFirst, 'second call within ttl used cache');
});
