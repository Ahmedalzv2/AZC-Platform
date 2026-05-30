// Keyless crypto news aggregator. The dashboard's old browser-side sources
// (CryptoCompare anon, cryptocurrency.cv, CoinGecko, LunarCrush) all went
// paywalled/dead, so the relay now fetches public RSS server-side (no CORS,
// no API key) and serves a normalized feed the github.io page can read.

export const DEFAULT_FEEDS = [
  { source: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { source: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { source: 'Decrypt', url: 'https://decrypt.co/feed' },
  { source: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/feed' },
  { source: 'CryptoSlate', url: 'https://cryptoslate.com/feed/' },
  { source: 'The Block', url: 'https://www.theblock.co/rss.xml' },
];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", nbsp: ' ' };

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e in ENTITIES) return ENTITIES[e];
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

function unwrap(raw) {
  if (raw == null) return '';
  const cdata = String(raw).match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return cdata ? cdata[1] : String(raw);
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

function toUnixSec(dateStr) {
  const t = Date.parse(String(dateStr || '').trim());
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

// Parse an RSS or Atom document into normalized items. Never throws.
export function parseFeed(xml, source) {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const block of blocks) {
    const isAtom = /^<entry/i.test(block);
    const title = stripTags(unwrap(tag(block, 'title')));
    let url = '';
    if (isAtom) {
      // Prefer rel="alternate"; fall back to first <link href>.
      const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
        || block.match(/<link[^>]*href=["']([^"']+)["']/i);
      url = alt ? alt[1] : '';
    } else {
      url = unwrap(tag(block, 'link')).trim();
      if (!url) { const g = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i); if (g && /^https?:/i.test(g[1].trim())) url = g[1].trim(); }
    }
    url = decodeEntities(url).trim();
    const dateRaw = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date');
    const bodyRaw = tag(block, 'description') || tag(block, 'summary') || tag(block, 'content:encoded') || tag(block, 'content');
    if (!title || !url) continue;
    out.push({
      title,
      url,
      source,
      published: toUnixSec(dateRaw),
      body: stripTags(unwrap(bodyRaw)).slice(0, 280),
    });
  }
  return out;
}

// Fetch all feeds (parallel, fault-tolerant), dedupe by url, sort newest-first.
// Caches the merged result on the passed-in `cache` object for `ttlMs`.
// `fetchImpl`/`now` are injectable for tests.
export async function aggregateNews({
  feeds = DEFAULT_FEEDS,
  fetchImpl = globalThis.fetch,
  ttlMs = 5 * 60_000,
  cache = aggregateNews._cache,
  now = Date.now(),
  timeoutMs = 8000,
} = {}) {
  if (cache.data && now - cache.ts < ttlMs) return cache.data;

  const errors = [];
  const settled = await Promise.allSettled(feeds.map(async (f) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      // Some feeds (e.g. The Block) 403 non-browser UAs. Public RSS, so send a
      // normal browser UA + Accept to maximize successful fetches.
      const r = await fetchImpl(f.url, {
        signal: ac.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return parseFeed(await r.text(), f.source);
    } finally { clearTimeout(timer); }
  }));

  const byUrl = new Map();
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      for (const item of s.value) if (item.url && !byUrl.has(item.url)) byUrl.set(item.url, item);
    } else {
      errors.push({ source: feeds[i].source, error: String(s.reason?.message || s.reason) });
    }
  });

  const articles = Array.from(byUrl.values()).sort((a, b) => (b.published || 0) - (a.published || 0));
  const data = { articles, fetchedAt: now, sources: feeds.map(f => f.source), errors };
  cache.data = data;
  cache.ts = now;
  return data;
}
aggregateNews._cache = {};
