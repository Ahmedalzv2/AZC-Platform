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

// Does an explicit sentiment label oppose a trade direction? Only a non-neutral
// label pointing the other way counts; neutral/null/unknown fail open (no
// opinion → never a veto). dir accepts long/short or bull/bear.
export function sentimentDisagrees(dir, label) {
  if (!label || label === 'neutral') return false;
  const bullish = dir === 'long' || dir === 'bull';
  const bearish = dir === 'short' || dir === 'bear';
  return (bullish && label === 'bear') || (bearish && label === 'bull');
}

// Shadow annotation for a signal: fetch sentiment and return a loggable
// sub-record. Always resolves an object (never throws), so the audit line is
// uniform. {available:false} when there's no key or no data — that keeps "key
// missing" distinguishable from "had data and agreed" in the shadow stream.
export async function sentimentShadow({ ticker, dir, env, fetchFn, now } = {}) {
  let snap = null;
  try { snap = await getSentiment({ ticker, env, fetchFn, ...(now != null ? { now } : {}) }); }
  catch { snap = null; }
  if (!snap) return { available: false };
  return {
    available: true,
    label: snap.label,
    source: snap.source,
    wouldSkip: sentimentDisagrees(dir, snap.label),
  };
}

const CP_URL = (t, token) =>
  `https://cryptopanic.com/api/v1/posts/?auth_token=${encodeURIComponent(token)}&currencies=${encodeURIComponent(t)}&public=true`;
const CP_WINDOW_MS = 24 * 60 * 60 * 1000;

// CryptoPanic free Developer API: aggregate community up/down votes across the
// last 24h of posts for a currency into a bull/bear/neutral lean. positive vs
// negative vote SHARE is the signal; too few votes => null (no opinion), so a
// quiet currency fails open like LunarCrush's neutral.
export async function _cryptoPanicFetcher({ ticker, env, signal, fetchFn, now = Date.now() } = {}) {
  const token = env?.CRYPTOPANIC_AUTH_TOKEN;
  if (!token) return null;
  const fn = fetchFn || globalThis.fetch;
  let res;
  try { res = await fn(CP_URL(ticker, token), { signal }); } catch { return null; }
  if (!res || !res.ok) return null;
  let json;
  try { json = await res.json(); } catch { return null; }
  const posts = Array.isArray(json?.results) ? json.results : [];
  const cutoff = now - CP_WINDOW_MS;
  let pos = 0, neg = 0, sampled = 0;
  for (const p of posts) {
    const ts = Date.parse(p?.published_at || p?.created_at || '');
    if (Number.isFinite(ts) && ts < cutoff) continue;          // undated posts count (API already recency-orders)
    const v = p?.votes || {};
    const up = Number(v.positive) || 0;
    const dn = Number(v.negative) || 0;
    if (up || dn) { pos += up; neg += dn; sampled += 1; }
  }
  const total = pos + neg;
  if (total < 1 || sampled < 1) return null;
  const share = pos / total;
  const label = share >= 0.6 ? 'bull' : share <= 0.4 ? 'bear' : 'neutral';
  return { label, source: 'cryptopanic', pos, neg, sampled };
}

// CoinGecko coin id per MEXC base ticker (trend + meanrev baskets). Unmapped
// tickers fail open — no id, no fetch.
const CG_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binancecoin', SOL: 'solana', XRP: 'ripple',
  DOGE: 'dogecoin', ADA: 'cardano', AVAX: 'avalanche-2', LINK: 'chainlink', DOT: 'polkadot',
  TRX: 'tron', ATOM: 'cosmos', NEAR: 'near', APT: 'aptos', ARB: 'arbitrum', OP: 'optimism',
  SUI: 'sui', INJ: 'injective-protocol', AAVE: 'aave', UNI: 'uniswap', ETC: 'ethereum-classic',
  BCH: 'bitcoin-cash', SEI: 'sei-network', TIA: 'celestia', RUNE: 'thorchain', LTC: 'litecoin',
};
const CG_URL = (id, key) =>
  `https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false${key ? `&x_cg_demo_api_key=${encodeURIComponent(key)}` : ''}`;

// CoinGecko per-coin community up/down vote %. Keyless (free, no signup); an
// optional COINGECKO_API_KEY raises the rate limit. Crowd mood, not news —
// kept as the always-available fallback under Alpha Vantage's real news scores.
export async function _coinGeckoFetcher({ ticker, env, signal, fetchFn } = {}) {
  const id = CG_IDS[String(ticker).toUpperCase()];
  if (!id) return null;
  const fn = fetchFn || globalThis.fetch;
  let res;
  try { res = await fn(CG_URL(id, env?.COINGECKO_API_KEY), { signal }); } catch { return null; }
  if (!res || !res.ok) return null;
  let json;
  try { json = await res.json(); } catch { return null; }
  const up = Number(json?.sentiment_votes_up_percentage);
  if (!Number.isFinite(up)) return null;
  const label = up >= 60 ? 'bull' : up <= 40 ? 'bear' : 'neutral';
  return { label, source: 'coingecko', up };
}

const AV_URL = (t, key) =>
  `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=CRYPTO:${encodeURIComponent(t)}&sort=LATEST&limit=50&apikey=${encodeURIComponent(key)}`;
const AV_WINDOW_MS = 24 * 60 * 60 * 1000;

// AV stamps publish time as "20260531T120000" (UTC, no separators).
function _avParseTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

// Alpha Vantage NEWS_SENTIMENT: real per-ticker news NLP. Relevance-weighted
// mean of ticker_sentiment_score across the last 24h of articles → bull/bear/
// neutral on AV's own ±0.15 band. Free tier is 25 req/day, so this is the
// primary only when a key exists; the cache (15m) keeps usage well under cap at
// the real entry cadence. A missing `feed` (Information/Note/rate-limit) → null.
export async function _alphaVantageFetcher({ ticker, env, signal, fetchFn, now = Date.now() } = {}) {
  const key = env?.ALPHAVANTAGE_API_KEY;
  if (!key) return null;
  const fn = fetchFn || globalThis.fetch;
  let res;
  try { res = await fn(AV_URL(ticker, key), { signal }); } catch { return null; }
  if (!res || !res.ok) return null;
  let json;
  try { json = await res.json(); } catch { return null; }
  if (!Array.isArray(json?.feed)) return null;
  const want = `CRYPTO:${String(ticker).toUpperCase()}`;
  const cutoff = now - AV_WINDOW_MS;
  let wsum = 0, wtot = 0, n = 0;
  for (const item of json.feed) {
    const ts = _avParseTime(item?.time_published);
    if (Number.isFinite(ts) && ts < cutoff) continue;
    const arr = Array.isArray(item?.ticker_sentiment) ? item.ticker_sentiment : [];
    const hit = arr.find((x) => String(x?.ticker).toUpperCase() === want);
    if (!hit) continue;
    const score = Number(hit.ticker_sentiment_score);
    if (!Number.isFinite(score)) continue;
    const rel = Number(hit.relevance_score);
    const w = Number.isFinite(rel) && rel > 0 ? rel : 1;
    wsum += score * w; wtot += w; n += 1;
  }
  if (n < 1 || wtot <= 0) return null;
  const mean = wsum / wtot;
  const label = mean >= 0.15 ? 'bull' : mean <= -0.15 ? 'bear' : 'neutral';
  return { label, source: 'alphavantage', mean, sampled: n };
}

export async function getSentiment({
  ticker, env = process.env, now = Date.now(), fetchFn, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!ticker || typeof ticker !== 'string') return null;
  const key = ticker.toUpperCase();
  const hit = _cache.get(key);
  if (hit && hit.expiresAtMs > now) return hit.snapshot;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let snapshot = null;
  const take = (r) => { if (r && !snapshot) snapshot = { label: r.label, source: r.source, fetchedAtMs: now }; };
  try {
    // Priority: real news (Alpha Vantage) → keyless crowd votes (CoinGecko) →
    // paid-tier fallbacks (CryptoPanic, LunarCrush topic/news). Each fetcher
    // self-gates on its own key and fails open to null.
    take(await _alphaVantageFetcher({ ticker: key, env, signal: controller.signal, fetchFn, now }));
    if (!snapshot && !controller.signal.aborted) take(await _coinGeckoFetcher({ ticker: key, env, signal: controller.signal, fetchFn }));
    if (!snapshot && !controller.signal.aborted) take(await _cryptoPanicFetcher({ ticker: key, env, signal: controller.signal, fetchFn, now }));
    if (!snapshot && !controller.signal.aborted) take(await _topicFetcher({ ticker: key, env, signal: controller.signal, fetchFn }));
    if (!snapshot && !controller.signal.aborted) take(await _newsFetcher({ ticker: key, env, signal: controller.signal, fetchFn, now }));
  } catch {
    snapshot = null;
  } finally {
    clearTimeout(timer);
  }
  if (snapshot) _cache.set(key, { snapshot, expiresAtMs: now + CACHE_TTL_MS });
  return snapshot;
}
