// Fetches headline/news context for a trade post-mortem. Pluggable
// providers so the network call is stubbed in tests and so the provider
// can be swapped via env without touching the formatter. Returns null on
// any failure — context is a nice-to-have, never a reason to break
// /learn-trade.

export function symbolToTicker(symbol) {
  if (typeof symbol !== 'string' || !symbol) return '';
  return symbol.split('_')[0].toUpperCase();
}

// Map a numeric LunarCrush sentiment (1=bearish .. 5=bullish) or an
// already-string label to a normalised bearish/neutral/bullish tag. The
// passthrough on string inputs lets adapters that already classify their
// own sentiment (e.g. future Finnhub adapter) reuse the same renderer.
export function sentimentLabel(value) {
  if (typeof value === 'string' && value) return value;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  if (n <= 2.5) return 'bearish';
  if (n >= 3.5) return 'bullish';
  return 'neutral';
}

// Pick a provider deterministically from env. Explicit CONTEXT_PROVIDER
// wins so the user can force one even when both keys happen to be set;
// otherwise we prefer lunarcrush (richer signal) and fall back to
// cryptopanic. 'none' means feature is dark — fetchMarketContext returns
// null silently.
export function pickProvider(env = {}) {
  const explicit = String(env?.CONTEXT_PROVIDER || '').toLowerCase();
  if (explicit === 'lunarcrush' || explicit === 'cryptopanic') return explicit;
  if (explicit) return 'none';
  if (env?.LUNARCRUSH_API_KEY) return 'lunarcrush';
  if (env?.CRYPTOPANIC_AUTH_TOKEN) return 'cryptopanic';
  return 'none';
}

export async function fetchMarketContext({
  symbol,
  ts = Date.now(),
  fetcher,
  timeoutMs = 2000,
  env = (typeof process !== 'undefined' ? process.env : {}),
} = {}) {
  const ticker = symbolToTicker(symbol);
  if (!ticker) return null;

  const fn = fetcher || defaultFetcherFor(pickProvider(env));
  if (!fn) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fn({ ticker, env, signal: controller.signal });
    if (!res || !Array.isArray(res.headlines)) return null;
    return {
      source: res.source || 'unknown',
      fetchedAtMs: Number.isFinite(Number(ts)) ? Number(ts) : Date.now(),
      headlines: res.headlines.slice(0, 5),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function defaultFetcherFor(provider) {
  if (provider === 'lunarcrush') return lunarCrushFetcher;
  if (provider === 'cryptopanic') return cryptoPanicFetcher;
  return null;
}

export async function cryptoPanicFetcher({ ticker, env, signal }) {
  const token = env?.CRYPTOPANIC_AUTH_TOKEN;
  if (!token) return null;
  const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${encodeURIComponent(token)}&currencies=${encodeURIComponent(ticker)}&public=true`;
  const r = await fetch(url, { signal });
  if (!r.ok) return null;
  const json = await r.json();
  const items = Array.isArray(json?.results) ? json.results : [];
  return {
    source: 'cryptopanic',
    headlines: items
      .map((p) => ({
        title: String(p.title || '').trim(),
        url: String(p.url || ''),
        publishedAt: String(p.published_at || ''),
        sentiment: p.kind || null,
      }))
      .filter((h) => h.title),
  };
}

export async function lunarCrushFetcher({ ticker, env, signal }) {
  const key = env?.LUNARCRUSH_API_KEY;
  if (!key) return null;
  const url = `https://lunarcrush.com/api4/public/coins/${encodeURIComponent(ticker)}/news/v1`;
  const r = await fetch(url, { signal, headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) return null;
  const json = await r.json();
  return parseLunarCrushNews(json);
}

export function parseLunarCrushNews(json) {
  const items = Array.isArray(json?.data) ? json.data : [];
  return {
    source: 'lunarcrush',
    headlines: items
      .map((p) => ({
        title: String(p.post_title || '').trim(),
        url: String(p.post_link || ''),
        publishedAt: epochToIso(p.post_created),
        sentiment: sentimentLabel(p.post_sentiment),
      }))
      .filter((h) => h.title),
  };
}

function epochToIso(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n * 1000).toISOString();
}
