// Fetches headline/news context for a trade post-mortem. Pluggable fetcher
// so the network call is stubbed in tests and so the provider can be
// swapped without touching the formatter. Returns null on any failure —
// context is a nice-to-have, never a reason to break /learn-trade.

export function symbolToTicker(symbol) {
  if (typeof symbol !== 'string' || !symbol) return '';
  return symbol.split('_')[0].toUpperCase();
}

export async function fetchMarketContext({
  symbol,
  ts = Date.now(),
  fetcher = defaultCryptoPanicFetcher,
  timeoutMs = 2000,
  env = (typeof process !== 'undefined' ? process.env : {}),
} = {}) {
  const ticker = symbolToTicker(symbol);
  if (!ticker) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher({ ticker, env, signal: controller.signal });
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

// Default adapter: CryptoPanic free API. Opt-in via CRYPTOPANIC_AUTH_TOKEN
// env var; without the token we skip silently so the feature is dark by
// default and never surprises with broken markdown.
async function defaultCryptoPanicFetcher({ ticker, env, signal }) {
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
