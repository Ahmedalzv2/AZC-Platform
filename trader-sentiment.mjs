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

const CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 2000;
const _cache = new Map();   // ticker → { snapshot, expiresAtMs }

export function _clearCache() { _cache.clear(); }

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
    .filter((p) => {
      const s = Number(p?.post_sentiment);
      return Number.isFinite(s) && s >= 1 && Number(p?.post_created) >= cutoff;
    })
    .sort((a, b) => Number(b.post_created) - Number(a.post_created))
    .slice(0, NEWS_MAX_HEADLINES);
  if (!valid.length) return null;
  const mean = valid.reduce((s, p) => s + Number(p.post_sentiment), 0) / valid.length;
  const label = _resolveLabel(mean);
  if (!label) return null;
  return { label, source: 'news', mean, sampled: valid.length };
}

const LC_TOPIC_URL = (t) =>
  `https://lunarcrush.com/api4/public/topic/${encodeURIComponent(t.toLowerCase())}/v1`;

export async function _topicFetcher({ ticker, env, signal, fetchFn } = {}) {
  const key = env?.LUNARCRUSH_API_KEY;
  if (!key) return null;
  const fn = fetchFn || globalThis.fetch;
  let res;
  try {
    res = await fn(LC_TOPIC_URL(ticker), { signal, headers: { Authorization: `Bearer ${key}` } });
  } catch { return null; }
  if (!res || !res.ok) return null;
  let json;
  try { json = await res.json(); } catch { return null; }
  const buckets = json?.data?.types_sentiment;
  if (!buckets || typeof buckets !== 'object') return null;
  const nums = Object.values(buckets).map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  const mean = nums.reduce((s, n) => s + n, 0) / nums.length;
  const label = _resolveLabel(mean);
  if (!label) return null;
  return { label, source: 'topic', mean, sampled: nums.length };
}

export async function getSentiment({
  ticker, env = process.env, now = Date.now(), fetchFn, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!ticker || typeof ticker !== 'string') return null;
  if (!env?.LUNARCRUSH_API_KEY) return null;
  const key = ticker.toUpperCase();
  const hit = _cache.get(key);
  if (hit && hit.expiresAtMs > now) return hit.snapshot;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let snapshot = null;
  try {
    const topic = await _topicFetcher({ ticker: key, env, signal: controller.signal, fetchFn });
    if (topic) {
      snapshot = { label: topic.label, source: 'topic', fetchedAtMs: now };
    } else if (!controller.signal.aborted) {
      const news = await _newsFetcher({ ticker: key, env, signal: controller.signal, fetchFn, now });
      if (news) snapshot = { label: news.label, source: 'news', fetchedAtMs: now };
    }
  } catch {
    snapshot = null;
  } finally {
    clearTimeout(timer);
  }
  if (snapshot) _cache.set(key, { snapshot, expiresAtMs: now + CACHE_TTL_MS });
  return snapshot;
}
