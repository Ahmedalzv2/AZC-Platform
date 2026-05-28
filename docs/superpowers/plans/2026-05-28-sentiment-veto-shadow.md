# Sentiment veto (shadow-first) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote LunarCrush sentiment from post-mortem-only logging (PR #245) to a pre-fire gate on the MEXC micro-capital lane, gated by a `SENTIMENT_GATE_MODE` env (`shadow` default, `live`, `off`). Disagreement between sentiment label and FVG direction causes a hard veto (in `live`) or a logged would-veto (in `shadow`).

**Architecture:** New module `trader-sentiment.mjs` owns LC lookup, TTL cache, and label resolution. Pure `decideFireAction` in `trader-fire-decision.mjs` gains one new gate after `session-blocked` and two new inputs (`sentimentSnapshot`, `sentimentGateMode`). `azc-trader.mjs` resolves the snapshot once per scan tick (for the top candidate) before calling the decision. State/events/post-mortems/INSIGHTS get sentiment-aware additions so the shadow window produces the evidence for a later live-flip PR.

**Tech Stack:** Node.js (≥18 native `fetch`/`AbortController`), `node:test`, `node:assert/strict`, JSONL state files, existing LunarCrush api4 endpoint family.

---

## Spec reference

`docs/superpowers/specs/2026-05-28-sentiment-veto-shadow-design.md` (commit `b578477` + harmonisation commit).

## File map

| File | Action |
|---|---|
| `trader-sentiment.mjs` | CREATE — getSentiment + cache + topic/news fetchers |
| `trader-fire-decision.mjs` | EDIT — add sentiment gate after session-blocked |
| `azc-trader.mjs` | EDIT — resolve snapshot per tick, pass into decision, log shadow |
| `server.mjs` | EDIT — `/trader-state` returns `sentimentGate` block |
| `trade-learnings.mjs` | EDIT — `## Sentiment (at fire)` section in post-mortems |
| `trade-insights.mjs` | EDIT — shadow-cohort aggregation block in INSIGHTS.md |
| `relay.env` (sample) | EDIT — document `SENTIMENT_GATE_MODE` |
| `tests/trader-sentiment.test.mjs` | CREATE |
| `tests/trader-fire-decision.test.mjs` | EDIT — add sentiment-gate cases |
| `tests/fixtures/lc-topic-sol.json` | CREATE |
| `tests/fixtures/lc-news-sol.json` | CREATE |

## Conventions

- Tests use `node:test` (`describe` / `it`) + `node:assert/strict` (existing repo style — see `tests/trader-fire-decision.test.mjs:1-3`).
- `npm test` (TZ=UTC, ~2s) runs all `tests/*.test.mjs`.
- Commits: short imperative subject (≤ 70 chars), 4-bullet body max, Co-Authored-By line per repo template.
- Branch already created in the preceding session: `sentiment-veto-shadow-spec`. All implementation work commits onto this branch.

---

### Task 1: `trader-sentiment.mjs` skeleton + `_resolveLabel` pure helper

**Files:**
- Create: `trader-sentiment.mjs`
- Create: `tests/trader-sentiment.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/trader-sentiment.test.mjs`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _resolveLabel } from '../trader-sentiment.mjs';

describe('_resolveLabel', () => {
  it('maps numeric ≤ 2.5 to bear', () => {
    assert.equal(_resolveLabel(1.0), 'bear');
    assert.equal(_resolveLabel(2.5), 'bear');
  });
  it('maps numeric ≥ 3.5 to bull', () => {
    assert.equal(_resolveLabel(3.5), 'bull');
    assert.equal(_resolveLabel(5.0), 'bull');
  });
  it('maps numeric strictly between 2.5 and 3.5 to neutral', () => {
    assert.equal(_resolveLabel(3.0), 'neutral');
    assert.equal(_resolveLabel(2.51), 'neutral');
    assert.equal(_resolveLabel(3.49), 'neutral');
  });
  it('returns null on non-finite / out-of-range input', () => {
    assert.equal(_resolveLabel(null), null);
    assert.equal(_resolveLabel(NaN), null);
    assert.equal(_resolveLabel('bull'), null);     // strings not allowed here — caller must pass numbers
    assert.equal(_resolveLabel(0.5), null);        // below LC's 1-5 floor
    assert.equal(_resolveLabel(5.5), null);        // above LC's 1-5 ceiling
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern='_resolveLabel'`
Expected: FAIL with "Cannot find module '../trader-sentiment.mjs'".

- [ ] **Step 3: Write minimal implementation**

Create `trader-sentiment.mjs`:

```js
// Pure label collapse: LC sentiment lives on a 1-5 scale across both
// topic and news endpoints. Anything outside [1, 5] or non-finite is
// "no signal" (null) — distinct from explicit neutral. Caller decides
// fail-open semantics.

export function _resolveLabel(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || typeof value !== 'number' || n < 1 || n > 5) return null;
  if (n <= 2.5) return 'bear';
  if (n >= 3.5) return 'bull';
  return 'neutral';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern='_resolveLabel'`
Expected: PASS, all 4 it() cases green.

- [ ] **Step 5: Commit**

```bash
git add trader-sentiment.mjs tests/trader-sentiment.test.mjs
git commit -m "$(cat <<'EOF'
sentiment: pure label resolver on LC 1-5 scale

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: LunarCrush news fetcher + `getSentiment` with no-key path

**Files:**
- Modify: `trader-sentiment.mjs`
- Modify: `tests/trader-sentiment.test.mjs`

Reuse the existing `parseLunarCrushNews` from `trade-context.mjs` (it already returns `headlines[].sentiment` labels via `sentimentLabel()`). Build an averager that takes the most-recent 10 headlines (by `publishedAt`) and reduces their numeric `post_sentiment` values back through `_resolveLabel`. Because `parseLunarCrushNews` discards the raw numeric and stringifies, we read the raw API response directly here.

- [ ] **Step 1: Write the failing tests**

Append to `tests/trader-sentiment.test.mjs`:

```js
import { _newsFetcher, getSentiment } from '../trader-sentiment.mjs';

describe('_newsFetcher', () => {
  const stubLcResponse = (items) => ({ data: items });
  const fakeFetch = (response, status = 200) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
  });

  it('averages last 10 headlines and resolves to a label', async () => {
    const env = { LUNARCRUSH_API_KEY: 'k' };
    // 10 headlines averaging 4.0 → bull
    const items = Array.from({ length: 10 }, (_, i) => ({
      post_title: `h${i}`, post_created: 1779950000 - i * 60, post_sentiment: 4.0,
    }));
    const fetchFn = fakeFetch(stubLcResponse(items));
    const r = await _newsFetcher({ ticker: 'SOL', env, signal: new AbortController().signal, fetchFn });
    assert.equal(r.label, 'bull');
    assert.equal(r.source, 'news');
  });

  it('returns null when no headlines have numeric sentiment', async () => {
    const env = { LUNARCRUSH_API_KEY: 'k' };
    const items = [{ post_title: 'x', post_sentiment: null }];
    const r = await _newsFetcher({ ticker: 'SOL', env, signal: new AbortController().signal, fetchFn: fakeFetch(stubLcResponse(items)) });
    assert.equal(r, null);
  });

  it('returns null on non-2xx', async () => {
    const env = { LUNARCRUSH_API_KEY: 'k' };
    const r = await _newsFetcher({ ticker: 'SOL', env, signal: new AbortController().signal, fetchFn: fakeFetch({}, 500) });
    assert.equal(r, null);
  });
});

describe('getSentiment — no key', () => {
  it('returns null when LUNARCRUSH_API_KEY is missing', async () => {
    const r = await getSentiment({ ticker: 'SOL', env: {}, now: 1779950000000 });
    assert.equal(r, null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern='_newsFetcher|getSentiment — no key'`
Expected: FAIL — `_newsFetcher` and `getSentiment` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `trader-sentiment.mjs`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern='_newsFetcher|getSentiment — no key'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add trader-sentiment.mjs tests/trader-sentiment.test.mjs
git commit -m "$(cat <<'EOF'
sentiment: LC news fetcher + getSentiment scaffold

- _newsFetcher averages last 10 headlines from past 24h
- getSentiment returns null when API key absent
- News-only path; topic + cache + timeout follow

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: LunarCrush topic fetcher + fixture

**Files:**
- Modify: `trader-sentiment.mjs`
- Modify: `tests/trader-sentiment.test.mjs`
- Create: `tests/fixtures/lc-topic-sol.json`
- Create: `tests/fixtures/lc-news-sol.json`

- [ ] **Step 1: Write the fixture files**

Create `tests/fixtures/lc-topic-sol.json`:

```json
{
  "data": {
    "topic": "solana",
    "title": "Solana",
    "topic_rank": 7,
    "types_sentiment": { "tweet": 4.1, "news": 3.8, "reddit": 3.9, "youtube_video": 4.0 },
    "interactions_24h": 100000,
    "num_posts": 1234
  },
  "config": {}
}
```

Create `tests/fixtures/lc-news-sol.json`:

```json
{
  "data": [
    { "post_title": "SOL ETF inflows hit fresh high", "post_link": "https://x/1", "post_created": 1779950000, "post_sentiment": 4.2 },
    { "post_title": "Solana validator outage resolved",  "post_link": "https://x/2", "post_created": 1779949000, "post_sentiment": 3.6 },
    { "post_title": "Whale moves 1M SOL to exchange",    "post_link": "https://x/3", "post_created": 1779948000, "post_sentiment": 2.0 }
  ],
  "config": {}
}
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/trader-sentiment.test.mjs`:

```js
import { _topicFetcher } from '../trader-sentiment.mjs';
import { readFile } from 'node:fs/promises';

const loadFixture = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

describe('_topicFetcher', () => {
  const fakeFetch = (response, status = 200) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
  });

  it('averages types_sentiment buckets and resolves to a label', async () => {
    const fixture = await loadFixture('lc-topic-sol.json');
    const r = await _topicFetcher({
      ticker: 'SOL', env: { LUNARCRUSH_API_KEY: 'k' },
      signal: new AbortController().signal, fetchFn: fakeFetch(fixture),
    });
    assert.equal(r.label, 'bull');     // mean ≈ 3.95
    assert.equal(r.source, 'topic');
  });

  it('returns null when types_sentiment is missing/empty', async () => {
    const r1 = await _topicFetcher({
      ticker: 'SOL', env: { LUNARCRUSH_API_KEY: 'k' },
      signal: new AbortController().signal, fetchFn: fakeFetch({ data: {} }),
    });
    const r2 = await _topicFetcher({
      ticker: 'SOL', env: { LUNARCRUSH_API_KEY: 'k' },
      signal: new AbortController().signal, fetchFn: fakeFetch({ data: { types_sentiment: {} } }),
    });
    assert.equal(r1, null);
    assert.equal(r2, null);
  });

  it('ignores non-numeric bucket values', async () => {
    const r = await _topicFetcher({
      ticker: 'SOL', env: { LUNARCRUSH_API_KEY: 'k' },
      signal: new AbortController().signal,
      fetchFn: fakeFetch({ data: { types_sentiment: { tweet: 'n/a', news: 4.0 } } }),
    });
    assert.equal(r.label, 'bull');
    assert.equal(r.source, 'topic');
  });

  it('returns null on non-2xx', async () => {
    const r = await _topicFetcher({
      ticker: 'SOL', env: { LUNARCRUSH_API_KEY: 'k' },
      signal: new AbortController().signal, fetchFn: fakeFetch({}, 500),
    });
    assert.equal(r, null);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern='_topicFetcher'`
Expected: FAIL — `_topicFetcher` not exported yet.

- [ ] **Step 4: Write minimal implementation**

Add to `trader-sentiment.mjs`:

```js
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
```

Then update `getSentiment` to prefer topic, fall back to news:

```js
export async function getSentiment({ ticker, env = process.env, now = Date.now(), fetchFn } = {}) {
  if (!ticker || typeof ticker !== 'string') return null;
  if (!env?.LUNARCRUSH_API_KEY) return null;
  const signal = new AbortController().signal;
  const topic = await _topicFetcher({ ticker, env, signal, fetchFn });
  if (topic) return { label: topic.label, source: 'topic', fetchedAtMs: now };
  const news = await _newsFetcher({ ticker, env, signal, fetchFn, now });
  if (news)  return { label: news.label,  source: 'news',  fetchedAtMs: now };
  return null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern='_topicFetcher'`
Expected: PASS, all 4 cases.

- [ ] **Step 6: Commit**

```bash
git add trader-sentiment.mjs tests/trader-sentiment.test.mjs tests/fixtures/lc-topic-sol.json tests/fixtures/lc-news-sol.json
git commit -m "$(cat <<'EOF'
sentiment: LC topic fetcher, topic-preferred over news

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 15-min TTL cache, null not cached

**Files:**
- Modify: `trader-sentiment.mjs`
- Modify: `tests/trader-sentiment.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/trader-sentiment.test.mjs`:

```js
import { _clearCache } from '../trader-sentiment.mjs';

describe('getSentiment — cache', () => {
  it('serves a second call within TTL from cache', async () => {
    _clearCache();
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ data: { types_sentiment: { tweet: 4.0 } } }) };
    };
    const env = { LUNARCRUSH_API_KEY: 'k' };
    const t0 = 1779950000000;
    const a = await getSentiment({ ticker: 'SOL', env, now: t0, fetchFn });
    const b = await getSentiment({ ticker: 'SOL', env, now: t0 + 10_000, fetchFn });
    assert.equal(a.label, 'bull');
    assert.deepEqual(b, a);
    assert.equal(calls, 1);
  });

  it('re-fetches after TTL expiry', async () => {
    _clearCache();
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ data: { types_sentiment: { tweet: 4.0 } } }) };
    };
    const env = { LUNARCRUSH_API_KEY: 'k' };
    const t0 = 1779950000000;
    await getSentiment({ ticker: 'SOL', env, now: t0, fetchFn });
    await getSentiment({ ticker: 'SOL', env, now: t0 + 15 * 60 * 1000 + 1, fetchFn });
    assert.equal(calls, 2);
  });

  it('does NOT cache a null result', async () => {
    _clearCache();
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const env = { LUNARCRUSH_API_KEY: 'k' };
    const t0 = 1779950000000;
    const a = await getSentiment({ ticker: 'SOL', env, now: t0, fetchFn });
    const b = await getSentiment({ ticker: 'SOL', env, now: t0 + 100, fetchFn });
    assert.equal(a, null);
    assert.equal(b, null);
    assert.equal(calls, 2);    // not 1 — null was not cached
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern='getSentiment — cache'`
Expected: FAIL — `_clearCache` not exported; no cache exists; `calls` will be 2 instead of 1 in the first test.

- [ ] **Step 3: Write minimal implementation**

In `trader-sentiment.mjs`, add cache:

```js
const CACHE_TTL_MS = 15 * 60 * 1000;
const _cache = new Map();   // ticker → { snapshot, expiresAtMs }

export function _clearCache() { _cache.clear(); }
```

Rewrite `getSentiment` to check + populate the cache:

```js
export async function getSentiment({ ticker, env = process.env, now = Date.now(), fetchFn } = {}) {
  if (!ticker || typeof ticker !== 'string') return null;
  if (!env?.LUNARCRUSH_API_KEY) return null;
  const key = ticker.toUpperCase();
  const hit = _cache.get(key);
  if (hit && hit.expiresAtMs > now) return hit.snapshot;
  const signal = new AbortController().signal;
  const topic = await _topicFetcher({ ticker: key, env, signal, fetchFn });
  let snapshot = null;
  if (topic) {
    snapshot = { label: topic.label, source: 'topic', fetchedAtMs: now };
  } else {
    const news = await _newsFetcher({ ticker: key, env, signal, fetchFn, now });
    if (news) snapshot = { label: news.label, source: 'news', fetchedAtMs: now };
  }
  if (snapshot) _cache.set(key, { snapshot, expiresAtMs: now + CACHE_TTL_MS });
  return snapshot;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern='getSentiment'`
Expected: PASS — all cache tests + the earlier no-key test.

- [ ] **Step 5: Commit**

```bash
git add trader-sentiment.mjs tests/trader-sentiment.test.mjs
git commit -m "$(cat <<'EOF'
sentiment: 15-min TTL cache, nulls not cached

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 2-second timeout via AbortController

**Files:**
- Modify: `trader-sentiment.mjs`
- Modify: `tests/trader-sentiment.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `tests/trader-sentiment.test.mjs`:

```js
describe('getSentiment — timeout', () => {
  it('returns null within ~2s when fetch hangs', async () => {
    _clearCache();
    const fetchFn = async (_url, opts) =>
      new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        setTimeout(() => reject(new Error('never reached')), 10_000);
      });
    const env = { LUNARCRUSH_API_KEY: 'k' };
    const start = Date.now();
    const r = await getSentiment({ ticker: 'SOL', env, fetchFn, timeoutMs: 50 });
    assert.equal(r, null);
    assert.ok(Date.now() - start < 500, 'must short-circuit on timeout');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='getSentiment — timeout'`
Expected: FAIL — `getSentiment` doesn't honour `timeoutMs`; hangs ~10s or rejects late.

- [ ] **Step 3: Write minimal implementation**

Edit `getSentiment` in `trader-sentiment.mjs` to thread a per-call AbortController:

```js
const DEFAULT_TIMEOUT_MS = 2000;

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
    } else {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --` (whole sentiment file).
Expected: PASS for every previous test plus the new timeout test, in under ~3s total.

- [ ] **Step 5: Commit**

```bash
git add trader-sentiment.mjs tests/trader-sentiment.test.mjs
git commit -m "$(cat <<'EOF'
sentiment: 2s timeout via shared AbortController

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `decideFireAction` — accept new inputs in `off` mode (no behaviour change)

**Files:**
- Modify: `trader-fire-decision.mjs`
- Modify: `tests/trader-fire-decision.test.mjs`

This task lands the new arguments without changing behaviour. It establishes the regression baseline so subsequent shadow + live tasks have something to diff against.

- [ ] **Step 1: Write the failing test**

Append to `tests/trader-fire-decision.test.mjs`:

```js
describe('decideFireAction — sentiment gate, off mode', () => {
  it('matches baseline output when mode=off and no snapshot', () => {
    const baseline = decideFireAction(baseInput());
    const withOff = decideFireAction(baseInput({
      sentimentGateMode: 'off',
      sentimentSnapshot: null,
    }));
    assert.deepEqual(withOff, baseline);
  });

  it('matches baseline when mode=off even with a disagree snapshot', () => {
    const baseline = decideFireAction(baseInput());
    const withOff = decideFireAction(baseInput({
      sentimentGateMode: 'off',
      sentimentSnapshot: { label: 'bear', source: 'topic', fetchedAtMs: 1 },
    }));
    assert.deepEqual(withOff, baseline);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (or that they pass trivially because the inputs are ignored)**

Run: `npm test -- --test-name-pattern='sentiment gate, off mode'`
Expected: PASS — `decideFireAction` currently ignores unknown inputs. That's fine — this test pins the no-op contract.

- [ ] **Step 3: Confirm no-op signature change is intentional**

No implementation change in this step; this test acts as a *change-detector* for Task 7 and Task 8 to make sure they don't break `off` mode. Run the full suite to confirm green:

Run: `npm test`
Expected: PASS — full suite green.

- [ ] **Step 4: Commit**

```bash
git add tests/trader-fire-decision.test.mjs
git commit -m "$(cat <<'EOF'
test(fire-decision): pin sentiment-gate off-mode no-op baseline

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `decideFireAction` — shadow mode (logs would-veto, still fires)

**Files:**
- Modify: `trader-fire-decision.mjs`
- Modify: `tests/trader-fire-decision.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/trader-fire-decision.test.mjs`:

```js
describe('decideFireAction — sentiment gate, shadow mode', () => {
  it('attaches shadow.wouldSkip when sentiment disagrees with bull setup', () => {
    const r = decideFireAction(baseInput({
      sentimentGateMode: 'shadow',
      sentimentSnapshot: { label: 'bear', source: 'topic', fetchedAtMs: 1 },
    }));
    assert.equal(r.action, 'fire');
    assert.deepEqual(r.shadow, { gate: 'sentiment', wouldSkip: true, label: 'bear', source: 'topic' });
    // risk + tier must be unchanged
    const baseline = decideFireAction(baseInput());
    assert.equal(r.tier, baseline.tier);
    assert.equal(r.riskPct, baseline.riskPct);
  });

  it('no shadow field when sentiment agrees', () => {
    const r = decideFireAction(baseInput({
      sentimentGateMode: 'shadow',
      sentimentSnapshot: { label: 'bull', source: 'topic', fetchedAtMs: 1 },
    }));
    assert.equal(r.action, 'fire');
    assert.equal(r.shadow, undefined);
  });

  it('no shadow field on neutral sentiment (fail-open)', () => {
    const r = decideFireAction(baseInput({
      sentimentGateMode: 'shadow',
      sentimentSnapshot: { label: 'neutral', source: 'news', fetchedAtMs: 1 },
    }));
    assert.equal(r.action, 'fire');
    assert.equal(r.shadow, undefined);
  });

  it('no shadow field on null snapshot (fail-open)', () => {
    const r = decideFireAction(baseInput({
      sentimentGateMode: 'shadow',
      sentimentSnapshot: null,
    }));
    assert.equal(r.action, 'fire');
    assert.equal(r.shadow, undefined);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern='sentiment gate, shadow mode'`
Expected: FAIL — `shadow` field does not exist.

- [ ] **Step 3: Write minimal implementation**

In `trader-fire-decision.mjs`, after the existing `session-blocked` check (line 54) but BEFORE tier selection, insert:

```js
  // Sentiment gate: optional, opt-in via sentimentGateMode. Disagreement
  // only triggers when both the FVG direction and sentiment label are
  // non-neutral; neutral and null fail-open (other gates still apply).
  const gateMode = sentimentGateMode || 'off';
  const sLabel = sentimentSnapshot?.label || null;
  const dir = pick.fvg.dir;
  const disagree =
    (dir === 'bull' && sLabel === 'bear') ||
    (dir === 'bear' && sLabel === 'bull');
  const shadowAttach = (gateMode === 'shadow' && disagree)
    ? { gate: 'sentiment', wouldSkip: true, label: sLabel, source: sentimentSnapshot.source }
    : null;
```

Add `sentimentGateMode` and `sentimentSnapshot` to the destructured parameter list at the top of the function:

```js
export function decideFireAction({
  candidates,
  pendingOrder,
  openPositions,
  maxOpenPositions,
  sideStatus,
  sessionStatus,
  currentSession,
  riskTiers,
  sentimentSnapshot = null,
  sentimentGateMode = 'off',
}) {
```

At the bottom, where the `action: 'fire'` object is returned, attach `shadow` when present:

```js
  return {
    action: 'fire',
    pick, tier, baseRiskPct, riskPct,
    sideKey, sessionKey: currentSession,
    candidateCount: sorted.length,
    downshifts,
    ...(shadowAttach ? { shadow: shadowAttach } : {}),
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — every prior `decideFireAction` test still green; new shadow-mode cases green; the Task 6 off-mode baseline test still green.

- [ ] **Step 5: Commit**

```bash
git add trader-fire-decision.mjs tests/trader-fire-decision.test.mjs
git commit -m "$(cat <<'EOF'
fire-decision: shadow-mode sentiment gate (no behaviour change)

Disagreement attaches shadow:{wouldSkip,label,source} on the fire
action. Tier + risk unchanged. Off-mode baseline preserved.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `decideFireAction` — live mode (hard veto)

**Files:**
- Modify: `trader-fire-decision.mjs`
- Modify: `tests/trader-fire-decision.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/trader-fire-decision.test.mjs`:

```js
describe('decideFireAction — sentiment gate, live mode', () => {
  it('skips with sentiment-disagree when bear sentiment vs bull setup', () => {
    const r = decideFireAction(baseInput({
      sentimentGateMode: 'live',
      sentimentSnapshot: { label: 'bear', source: 'topic', fetchedAtMs: 1 },
    }));
    assert.equal(r.action, 'skip');
    assert.equal(r.skip, 'sentiment-disagree');
    assert.match(r.detail, /bear sentiment vs bull setup/);
    assert.equal(r.source, 'topic');
  });

  it('skips with sentiment-disagree when bull sentiment vs bear setup', () => {
    const r = decideFireAction(baseInput({
      candidates: [cand('SOL_USDT', 'bear', 0.0001)],
      sentimentGateMode: 'live',
      sentimentSnapshot: { label: 'bull', source: 'news', fetchedAtMs: 1 },
    }));
    assert.equal(r.action, 'skip');
    assert.equal(r.skip, 'sentiment-disagree');
    assert.match(r.detail, /bull sentiment vs bear setup/);
  });

  it('fires normally when sentiment agrees', () => {
    const r = decideFireAction(baseInput({
      sentimentGateMode: 'live',
      sentimentSnapshot: { label: 'bull', source: 'topic', fetchedAtMs: 1 },
    }));
    assert.equal(r.action, 'fire');
  });

  it('fail-open on null snapshot in live mode', () => {
    const r = decideFireAction(baseInput({
      sentimentGateMode: 'live',
      sentimentSnapshot: null,
    }));
    assert.equal(r.action, 'fire');
  });

  it('side-blocked beats sentiment-disagree (gate ordering)', () => {
    const r = decideFireAction(baseInput({
      sideStatus: { long: { status: 'blocked', reason: 'side gone' }, short: enabled('SHORT') },
      sentimentGateMode: 'live',
      sentimentSnapshot: { label: 'bear', source: 'topic', fetchedAtMs: 1 },
    }));
    assert.equal(r.skip, 'side-blocked');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern='sentiment gate, live mode'`
Expected: FAIL — live mode does not skip yet; setups still fire.

- [ ] **Step 3: Write minimal implementation**

Replace the `shadowAttach` block from Task 7 in `trader-fire-decision.mjs` with the live-vs-shadow branch:

```js
  const gateMode = sentimentGateMode || 'off';
  const sLabel = sentimentSnapshot?.label || null;
  const dir = pick.fvg.dir;
  const disagree =
    (dir === 'bull' && sLabel === 'bear') ||
    (dir === 'bear' && sLabel === 'bull');

  if (disagree && gateMode === 'live') {
    return {
      action: 'skip',
      skip: 'sentiment-disagree',
      detail: `${sLabel} sentiment vs ${dir} setup`,
      source: sentimentSnapshot.source,
    };
  }
  const shadowAttach = (gateMode === 'shadow' && disagree)
    ? { gate: 'sentiment', wouldSkip: true, label: sLabel, source: sentimentSnapshot.source }
    : null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — full suite, including the Task 7 shadow tests and the Task 6 off-mode baseline.

- [ ] **Step 5: Commit**

```bash
git add trader-fire-decision.mjs tests/trader-fire-decision.test.mjs
git commit -m "$(cat <<'EOF'
fire-decision: live-mode sentiment veto skip

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Wire `azc-trader.mjs` — resolve snapshot + log shadow

**Files:**
- Modify: `azc-trader.mjs`

This is an I/O task — no new unit tests. The 4-second boot smoke check in Task 12 validates the wiring end-to-end.

- [ ] **Step 1: Add imports and env read**

In `azc-trader.mjs`, near the existing imports (around line 23-30):

```js
import { getSentiment } from './trader-sentiment.mjs';
```

Near the top-level config constants (search for `RISK_PCT_DEFAULT` and `MAX_OPEN_POSITIONS` to find the block), add:

```js
const VALID_SENTIMENT_MODES = new Set(['shadow', 'live', 'off']);
const SENTIMENT_GATE_MODE = (() => {
  const v = String(process.env.SENTIMENT_GATE_MODE || 'shadow').toLowerCase();
  if (VALID_SENTIMENT_MODES.has(v)) return v;
  console.warn(`[sentiment-config] unknown SENTIMENT_GATE_MODE='${v}', falling back to 'off'`);
  return 'off';
})();
```

Add per-process counters near `lastScanSummary`:

```js
let sentimentShadowSkips24h = 0;
let sentimentLiveSkips24h = 0;
let lastSentimentSnapshot = null;
let lastSentimentAt = null;
```

In `maybeRollDay()` (the function that resets `tradesToday` etc.), reset both counters to zero on day roll.

- [ ] **Step 2: Resolve snapshot in `tryFire`**

In `tryFire()`, after `const valid = results.filter(r => !r.skip);` (around line 492) and before the call to `decideFireAction`, add:

```js
  let sentimentSnapshot = null;
  if (SENTIMENT_GATE_MODE !== 'off' && valid.length) {
    // Locally pick the top candidate using the same comparator
    // decideFireAction uses, so we only fetch sentiment for the one
    // symbol we're about to vote on. Duplication is two lines.
    const top = [...valid].sort((a, b) => a.distPct - b.distPct)[0];
    const ticker = String(top.symbol || '').split('_')[0];
    if (ticker) {
      try {
        sentimentSnapshot = await getSentiment({ ticker });
        if (sentimentSnapshot) {
          lastSentimentSnapshot = sentimentSnapshot;
          lastSentimentAt = sentimentSnapshot.fetchedAtMs;
        }
      } catch (e) {
        log(`[sentiment-err] ${e.message}`);
      }
    }
  }
```

- [ ] **Step 3: Pass snapshot into `decideFireAction`**

Edit the existing call site (around line 494):

```js
  const decision = decideFireAction({
    candidates: valid,
    pendingOrder: false,
    openPositions: openPositions.length,
    maxOpenPositions: MAX_OPEN_POSITIONS,
    sideStatus,
    sessionStatus,
    currentSession: currentKillzoneName() || 'off',
    riskTiers: { default: RISK_PCT_DEFAULT, top2: RISK_PCT_TOP_2, best: RISK_PCT_BEST },
    sentimentSnapshot,
    sentimentGateMode: SENTIMENT_GATE_MODE,
  });
```

- [ ] **Step 4: Count + log shadow/live decisions**

Immediately after the `decision = decideFireAction({...})` call, before `if (decision.action === 'skip')`:

```js
  if (decision.skip === 'sentiment-disagree') {
    sentimentLiveSkips24h += 1;
    log(`[sentiment-veto] ${decision.detail} (source=${decision.source})`);
  } else if (decision.shadow?.wouldSkip) {
    sentimentShadowSkips24h += 1;
    log(`[sentiment-shadow] would skip: ${decision.shadow.label} vs ${decision.pick.fvg.dir} (source=${decision.shadow.source})`);
  }
```

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: PASS — no unit test added here, but ensure nothing broke.

- [ ] **Step 6: Commit**

```bash
git add azc-trader.mjs
git commit -m "$(cat <<'EOF'
trader: wire sentiment gate (shadow default) into tryFire

- Read SENTIMENT_GATE_MODE env; default shadow, unknown→off
- Fetch sentiment for the locally-picked top candidate per scan
- Pass snapshot + mode into decideFireAction
- Track 24h shadow/live skip counters; log both decision types

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Surface `sentimentGate` block in `/trader-state`

**Files:**
- Modify: `azc-trader.mjs`
- Modify: (nothing in server.mjs — it just reads the state JSON the trader writes)

The trader writes the state JSON; the relay forwards it. No relay change required.

- [ ] **Step 1: Add `sentimentGate` to `writeState()`**

In `azc-trader.mjs`, inside `writeState()` (around line 272-294), add inside the state object:

```js
    sentimentGate: {
      mode: SENTIMENT_GATE_MODE,
      lastSnapshotAt: lastSentimentAt,
      lastLabel: lastSentimentSnapshot?.label || null,
      lastSource: lastSentimentSnapshot?.source || null,
      shadowWouldSkipCount24h: sentimentShadowSkips24h,
      liveSkipCount24h: sentimentLiveSkips24h,
    },
```

- [ ] **Step 2: Manual verification command (to run after deploy, not part of CI)**

Add a code comment near the new block:

```js
    // Inspect from prod: curl https://tv-relay.srv1688368.hstgr.cloud/trader-state | jq .sentimentGate
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: PASS — no test regressed.

- [ ] **Step 4: Commit**

```bash
git add azc-trader.mjs
git commit -m "$(cat <<'EOF'
trader-state: expose sentimentGate block for dashboard + ops

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Post-mortem `## Sentiment (at fire)` section

**Files:**
- Modify: `trade-learnings.mjs`
- Modify: `tests/learn-trade.test.mjs`
- Modify: `azc-trader.mjs` (forward sentiment into the fire context the dashboard posts back at close)

The dashboard's existing close-time POST to `/learn-trade` carries an arbitrary payload that the relay turns into a markdown file. We need the trader to publish its sentiment snapshot somewhere the dashboard can read it at close time so the snapshot gets POSTed back. The simplest route: stash the latest fire's sentiment on the trader's state under `positionContext.sentiment` (already-known state block the dashboard reads).

- [ ] **Step 1: Write the failing tests**

Append to `tests/learn-trade.test.mjs`:

```js
import { formatLearningMarkdown } from '../trade-learnings.mjs';

describe('formatLearningMarkdown — ## Sentiment section', () => {
  const base = {
    symbol: 'SOL_USDT', side: 'long', outcome: 'win',
    entry: 100, sl: 99, tp: 102, priceAtCall: 100,
    realizedUsd: 1, rMultiple: 1, timestamp: 1779950000000,
    analysis: 'x',
  };

  it('emits section when sentiment present', () => {
    const md = formatLearningMarkdown({
      ...base,
      sentiment: { label: 'bull', source: 'topic', agree: true, shadowWouldSkip: false },
    });
    assert.match(md, /## Sentiment \(at fire\)/);
    assert.match(md, /source: topic/);
    assert.match(md, /label: +bull/);
    assert.match(md, /agree: +yes/);
    assert.doesNotMatch(md, /shadow gate would have vetoed/);
  });

  it('flags shadow would-veto when shadowWouldSkip true', () => {
    const md = formatLearningMarkdown({
      ...base,
      sentiment: { label: 'bear', source: 'news', agree: false, shadowWouldSkip: true },
    });
    assert.match(md, /agree: +no/);
    assert.match(md, /shadow gate would have vetoed/);
  });

  it('omits section entirely when sentiment absent', () => {
    const md = formatLearningMarkdown({ ...base, sentiment: null });
    assert.doesNotMatch(md, /## Sentiment \(at fire\)/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern='## Sentiment section'`
Expected: FAIL — section not rendered yet.

- [ ] **Step 3: Add the formatter**

In `trade-learnings.mjs`, add a helper near `formatContextSection`:

```js
export function formatSentimentSection(s) {
  if (!s || typeof s !== 'object') return [];
  const label = String(s.label || '').toLowerCase();
  if (!label) return [];
  const lines = ['## Sentiment (at fire)'];
  lines.push(`- source: ${s.source || '—'}`);
  lines.push(`- label:  ${label}`);
  lines.push(`- agree:  ${s.agree ? 'yes' : 'no'}`);
  if (s.shadowWouldSkip) lines.push('- shadow gate would have vetoed');
  return lines;
}
```

In `formatLearningMarkdown`, after the `formatContextSection` block (around line 152-156), add:

```js
  const sentLines = formatSentimentSection(p?.sentiment);
  if (sentLines.length) {
    lines.push(...sentLines);
    lines.push('');
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern='## Sentiment section'`
Expected: PASS.

- [ ] **Step 5: Forward sentiment from trader to position context**

In `azc-trader.mjs`, when a fire succeeds (search for the place `positionContext = { ... }` gets set inside `tryFire` — it's roughly 80 lines after the `decideFireAction` call, where the order placement completes), attach the snapshot:

```js
  positionContext = {
    // …existing fields…
    sentiment: sentimentSnapshot
      ? {
          label: sentimentSnapshot.label,
          source: sentimentSnapshot.source,
          agree: !(decision.shadow?.wouldSkip),
          shadowWouldSkip: !!decision.shadow?.wouldSkip,
        }
      : null,
  };
```

Confirm the dashboard's close-time POST already passes `positionContext.sentiment` straight through under `payload.sentiment`. If it doesn't, edit the close-handler in the dashboard (the file in `index.html` or `worker.js` that builds the `/learn-trade` body) to include it. Use `grep -n "_postLearnTrade\|learn-trade" index.html worker.js` to find the call site and add `sentiment: positionContext?.sentiment || null` to the body.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add trade-learnings.mjs tests/learn-trade.test.mjs azc-trader.mjs index.html worker.js
git commit -m "$(cat <<'EOF'
learn-trade: snapshot sentiment into post-mortems

- formatSentimentSection renders source/label/agree + shadow-veto note
- Trader stashes sentiment on positionContext at fire time
- Dashboard close-POST forwards it to /learn-trade payload

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: INSIGHTS shadow-cohort aggregation

**Files:**
- Modify: `trade-insights.mjs`
- Modify: `tests/insights.test.mjs` (look at existing tests for INSIGHTS; if none, create `tests/trade-insights.test.mjs`)

This block is the evidence the PR-2 live flip is built on.

- [ ] **Step 1: Inspect existing INSIGHTS test scaffolding**

Run: `ls tests/ | grep -i insight` and `grep -n "writeInsightsFile\|computeInsights" trade-insights.mjs | head -20`. Use the existing aggregator entry point — most likely `computeInsights` — for the new cohort.

- [ ] **Step 2: Write the failing test**

In the relevant insights test file (existing or new `tests/trade-insights.test.mjs`):

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatShadowCohortBlock } from '../trade-insights.mjs';

describe('formatShadowCohortBlock', () => {
  it('shows expR for would-vetoed vs the rest on the same cohort', () => {
    const trades = [
      { rMultiple:  1.8, sentiment: { agree: false, shadowWouldSkip: true } },   // would-skip win
      { rMultiple: -1.0, sentiment: { agree: false, shadowWouldSkip: true } },   // would-skip loss
      { rMultiple: -1.0, sentiment: { agree: false, shadowWouldSkip: true } },   // would-skip loss
      { rMultiple:  1.8, sentiment: { agree: true,  shadowWouldSkip: false } },  // kept win
      { rMultiple:  1.8, sentiment: { agree: true,  shadowWouldSkip: false } },  // kept win
      { rMultiple: -1.0, sentiment: { agree: true,  shadowWouldSkip: false } },  // kept loss
    ];
    const block = formatShadowCohortBlock(trades);
    assert.match(block, /Shadow gate — would-veto outcomes/);
    assert.match(block, /would-veto.*n= *3/);
    assert.match(block, /rest.*n= *3/);
    // mean of {1.8,-1,-1} = -0.0667; mean of {1.8,1.8,-1} = 0.867
    assert.match(block, /would-veto.*expR/);
    assert.match(block, /rest.*expR/);
  });

  it('returns empty string when no trades carry sentiment', () => {
    const block = formatShadowCohortBlock([{ rMultiple: 1, sentiment: null }]);
    assert.equal(block, '');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern='formatShadowCohortBlock'`
Expected: FAIL — function not exported.

- [ ] **Step 4: Write minimal implementation**

In `trade-insights.mjs`, add:

```js
export function formatShadowCohortBlock(trades) {
  const withSent = (trades || []).filter((t) => t?.sentiment && typeof t.sentiment === 'object');
  if (!withSent.length) return '';
  const wouldVeto = withSent.filter((t) => t.sentiment.shadowWouldSkip);
  const rest      = withSent.filter((t) => !t.sentiment.shadowWouldSkip);
  const fmtCohort = (label, arr) => {
    if (!arr.length) return `${label.padEnd(12)} n=  0`;
    const sum = arr.reduce((s, t) => s + (Number(t.rMultiple) || 0), 0);
    const exp = (sum / arr.length).toFixed(3);
    return `${label.padEnd(12)} n=${String(arr.length).padStart(3)}  expR= ${exp}R  netR=  ${sum.toFixed(2)}R`;
  };
  return [
    '### Shadow gate — would-veto outcomes',
    '```',
    fmtCohort('would-veto', wouldVeto),
    fmtCohort('rest',       rest),
    '```',
  ].join('\n');
}
```

Then hook it into the main `computeInsights` / `writeInsightsFile` writer so the block appears in `INSIGHTS.md`. Look for the place the existing performance/edges/leaks sections are joined — append the shadow-cohort block at the end (it's the newest/least-mature signal so it goes last).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern='formatShadowCohortBlock'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add trade-insights.mjs tests/*.test.mjs
git commit -m "$(cat <<'EOF'
insights: shadow-cohort would-veto vs rest expR block

Renders in INSIGHTS.md once any trade carries sentiment metadata.
Evidence basis for the future SENTIMENT_GATE_MODE=live flip PR.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: `relay.env` sample + 4s boot smoke check

**Files:**
- Modify: `relay.env` (sample/example — confirm whether the repo tracks a `relay.env.example` or `relay.env`; do **not** commit secrets)

- [ ] **Step 1: Add documented sample line**

Run: `ls relay.env*` and identify the tracked file (likely `relay.env.example` or similar; if only `relay.env` exists and contains real secrets, do not modify it — instead update `TRADER-DEPLOY.md` to document the new env var).

In the appropriate sample file, add:

```
# Sentiment gate (LunarCrush). Default 'shadow' — logs would-veto
# events without changing fire behaviour. 'live' enables the veto;
# 'off' disables sentiment lookup entirely.
SENTIMENT_GATE_MODE=shadow
```

- [ ] **Step 2: Boot smoke check (the user's documented "4-second boot verify")**

Run this exact sequence from the repo root with the real `relay.env` already containing `LUNARCRUSH_API_KEY` (the smoke check is the user's existing standard from memory `feedback_trader_boot_verify`):

```bash
set -a; . relay.env; set +a
SENTIMENT_GATE_MODE=shadow timeout 4 node azc-trader.mjs 2>&1 | tail -20
```

Expected: no `[cycle-err]` lines; the process should complete at least one cycle and exit on timeout. Look for `[sentiment-shadow]` or absence of `[sentiment-err]` to confirm the import wired up.

If the trader crashes on boot, the implementation has a bug — fix before continuing.

- [ ] **Step 3: Commit**

```bash
git add relay.env.example TRADER-DEPLOY.md   # whichever was changed
git commit -m "$(cat <<'EOF'
docs: SENTIMENT_GATE_MODE env (shadow default)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Full sweep + PR

**Files:** none

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS, every file, no skipped/failed.

- [ ] **Step 2: Verify the design contract end-to-end**

Manually walk the changed files against the spec's "Files touched" table in section 9 of `docs/superpowers/specs/2026-05-28-sentiment-veto-shadow-design.md`. Every row should be checked off in the implementation. If any row was deferred or descoped, note it in the PR description.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin sentiment-veto-shadow-spec
gh pr create --title "feat(sentiment): LunarCrush veto gate, shadow-first" --body "$(cat <<'EOF'
## Summary
- New `trader-sentiment.mjs`: topic-preferred LC lookup with 15-min cache + 2s timeout.
- `decideFireAction` gains a sentiment gate after session-blocked. Hard veto on disagree, fail-open on null/neutral.
- `SENTIMENT_GATE_MODE` env: `shadow` default (logs would-veto, no behaviour change), `live`, `off`.
- `/trader-state` surfaces `sentimentGate` block. Post-mortems get `## Sentiment (at fire)`. INSIGHTS.md grows a shadow-cohort would-veto vs rest block — this is the evidence the live-flip PR will be built on.
- Spec: `docs/superpowers/specs/2026-05-28-sentiment-veto-shadow-design.md`.

## Test plan
- [ ] `npm test` green locally
- [ ] 4s boot smoke check passes under real `relay.env`
- [ ] After deploy: `curl tv-relay.../trader-state | jq .sentimentGate` returns the new block
- [ ] After 24h: `tail /var/log/azc-trader.log | grep sentiment` shows shadow events; no `[sentiment-err]` lines
- [ ] After ~20 fires: `trade-learnings/INSIGHTS.md` shows the shadow-cohort block populated

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Wait for CI green and auto-merge per repo workflow**

Run: `gh pr view --json statusCheckRollup,mergeable,url`
Expected: `mergeable: MERGEABLE`, all checks green. Enable auto-merge if not already:

```bash
gh pr merge --auto --squash
```

---

## Self-review

**Spec coverage**

| Spec section | Task(s) |
|---|---|
| 3 Architecture (`getSentiment` + new pure-fn inputs) | 1, 2, 3, 4, 5, 6, 7, 8, 9 |
| 4 `trader-sentiment.mjs` | 1, 2, 3, 4, 5 |
| 4 `trader-fire-decision.mjs` | 6, 7, 8 |
| 4 `azc-trader.mjs` | 9, 10, 11 |
| 4 `/trader-state` block | 10 |
| 4 trader-events JSONL sentiment field | 9 (via `[sentiment-shadow]` / `[sentiment-veto]` logger; the existing `appendScanEvent` already serialises the whole cycle payload) |
| 4 `trade-learnings.mjs` `## Sentiment` | 11 |
| 4 `trade-insights.mjs` shadow-cohort | 12 |
| 4 `relay.env` | 13 |
| 5 Error handling | 2 (no-key), 4 (null-not-cached), 5 (timeout). The 4xx/5xx + rate-limited log paths fold into 2 and 5; if you want explicit per-60s log throttling, add a tiny `_lastErrAt` map in Task 5. |
| 6 Tests | 1, 2, 3, 4, 5, 6, 7, 8, 11, 12 |
| 7 Rollout PR 1 | 14 |

**Placeholder scan:** No `TBD`/`TODO`/"implement later"/"appropriate error handling" left. The one explicit guess is the dashboard/worker close-POST integration in Task 11 Step 5 (depends on file layout I haven't fully mapped) — flagged with a concrete grep command for the implementer.

**Type consistency:**
- Snapshot shape `{ label, source, fetchedAtMs }` is consistent across Tasks 1-11.
- `decideFireAction` parameter names `sentimentSnapshot` + `sentimentGateMode` are consistent across Tasks 6, 7, 8, 9.
- Skip reason `sentiment-disagree` is the same string in Task 8, Task 9 (trader log), Task 10 (state counter `liveSkipCount24h`), and PR description.
- Sentiment label values (`'bull' | 'bear' | 'neutral'`) and source values (`'topic' | 'news'`) are consistent everywhere.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-28-sentiment-veto-shadow.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?
