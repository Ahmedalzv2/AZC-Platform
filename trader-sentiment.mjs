// Pure label collapse: LC sentiment lives on a 1-5 scale across both
// topic and news endpoints. Anything outside [1, 5] or non-finite is
// "no signal" (null) — distinct from explicit neutral. Caller decides
// fail-open semantics.

export function _resolveLabel(value) {
  if (!Number.isFinite(value) || value < 1 || value > 5) return null;
  if (value <= 2.5) return 'bear';
  if (value >= 3.5) return 'bull';
  return 'neutral';
}

const LC_NEWS_URL = (t) =>
  `https://lunarcrush.com/api4/public/coins/${encodeURIComponent(t)}/news/v1`;
const NEWS_WINDOW_MS = 24 * 60 * 60 * 1000;
const NEWS_MAX_HEADLINES = 10;

export async function _newsFetcher({ ticker, env, signal, fetchFn, now = Date.now() } = {}) {
  const key = env?.LUNARCRUSH_API_KEY;
  if (!key) return null;
  const fn = fetchFn || globalThis.fetch;
  let res;
  try {
    res = await fn(LC_NEWS_URL(ticker), { signal, headers: { Authorization: `Bearer ${key}` } });
  } catch { return null; }
  if (!res || !res.ok) return null;
  let json;
  try { json = await res.json(); } catch { return null; }
  const items = Array.isArray(json?.data) ? json.data : [];
  const cutoff = (now - NEWS_WINDOW_MS) / 1000;     // LC uses seconds-since-epoch
  const valid = items
    .filter((p) => Number.isFinite(Number(p?.post_sentiment)) && Number(p?.post_created) >= cutoff)
    .sort((a, b) => Number(b.post_created) - Number(a.post_created))
    .slice(0, NEWS_MAX_HEADLINES);
  if (!valid.length) return null;
  const mean = valid.reduce((s, p) => s + Number(p.post_sentiment), 0) / valid.length;
  const label = _resolveLabel(mean);
  if (!label) return null;
  return { label, source: 'news', mean, sampled: valid.length };
}

export async function getSentiment({ ticker, env = process.env, now = Date.now(), fetchFn } = {}) {
  if (!ticker || typeof ticker !== 'string') return null;
  if (!env?.LUNARCRUSH_API_KEY) return null;
  // News-only path lands first; topic fetcher + cache + timeout come in
  // later tasks. Always-fresh fetch for now.
  const news = await _newsFetcher({ ticker, env, signal: new AbortController().signal, fetchFn, now });
  if (news) return { label: news.label, source: news.source, fetchedAtMs: now };
  return null;
}
