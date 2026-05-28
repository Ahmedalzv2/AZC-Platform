# Sentiment veto (shadow-first) — Design

- **Status:** Approved (spec)
- **Author:** Claude Opus 4.7 + Ahmed
- **Date:** 2026-05-28
- **Scope:** AZC MEXC micro-capital lane only. Does not touch US100/manual lane.

## 1. Motivation

LunarCrush sentiment is already pulled at trade-close time (`server.mjs:997`,
PR #245) and rendered into post-mortems as a passive observation. It is not
read in the live fire path. Last 7d performance (INSIGHTS.md, valid post-#221
cohort): 9 fires · WR 55.6% · expectancy +0.43R · net +$4.67. Recurring loss
sentence: *"HTF agreed but trade still failed — 5m noise inside HTF trend"*
(×4). Cross-asset sentiment is a plausible filter for exactly that failure mode.

We do not believe sentiment is an edge until we measure it. The design
therefore ships shadow-mode first (log only) and gates the live flip on real
data from the bot's own decision feed.

## 2. Decisions taken during brainstorm

| Decision | Value | Rationale |
|---|---|---|
| Gate strength | Hard veto on disagree | User choice; simplest to reason about. |
| Signal source | LunarCrush topic preferred, news fallback | Topic time-series is a faster-moving signal than headline averages; news fallback keeps coverage when topic is empty. |
| No-data behaviour | Fail-open | Matches existing #245 trade-context pattern. An LC outage must not freeze the trader. |
| Rollout | Shadow-first, then a separate live-flip PR | Repo rule (CLAUDE.md): eval before baseline change, narrow PRs by risk. LC sentiment isn't in existing fixtures, so eval happens forward from the shadow data. |

## 3. Architecture

A new module `trader-sentiment.mjs` owns sentiment lookup + caching. The fire
decision in `trader-fire-decision.mjs` gains one new pure input
(`sentimentSnapshot`) plus one mode flag (`sentimentGateMode`). The trader
process (`azc-trader.mjs`) resolves the snapshot per candidate-selection
tick and passes it in.

A new env flag `SENTIMENT_GATE_MODE` (`shadow` default · `live` · `off`)
controls behaviour. The shadow→live flip is one env change + service
restart; no code redeploy needed.

```
azc-trader cycle (per scan tick)
    │
    ├─ build candidates (FVG, HTF, killzone, etc.)
    │
    ├─ if SENTIMENT_GATE_MODE !== 'off' AND candidates.length:
    │     pick top candidate locally (same comparator as decideFireAction);
    │     for that ticker:
    │       snapshot = await getSentiment({ ticker, env, now })
    │           ├─ cache hit (≤15 min old) → return cached snapshot
    │           └─ cache miss:
    │                 ├─ try _topicFetcher (LC /topic)        — 2s timeout
    │                 │     ├─ ok → cache + return
    │                 │     └─ fail/empty ↓
    │                 ├─ try _newsFetcher (LC /news, parser
    │                 │   reused from trade-context.mjs)      — 2s timeout
    │                 │     ├─ ok → cache + return
    │                 │     └─ fail/empty ↓
    │                 └─ return null (NOT cached — retry next tick)
    │
    ├─ decideFireAction({ ..., sentimentSnapshot, sentimentGateMode })
    │     ├─ pending-order / in-position / no-candidates ─ skip
    │     ├─ side-blocked / session-blocked ───────────── skip
    │     ├─ sentiment gate:
    │     │     ├─ snapshot null OR label neutral → pass (fail-open)
    │     │     ├─ label agrees with setup.dir   → pass
    │     │     └─ label disagrees:
    │     │           ├─ mode='live'   → skip 'sentiment-disagree'
    │     │           └─ mode='shadow' → pass, attach shadow:{...}
    │     └─ tier + risk computation as today
    │
    ├─ log decision to trader-events
    │
    └─ place order if action === 'fire'
```

## 4. Components

### `trader-sentiment.mjs` (new, ~120 lines)

Public surface:
- `getSentiment({ ticker, env, fetcher, now })` → `{ label, source, fetchedAtMs }` or `null`.
- `_clearCache()` — test-only helper.

Internals:
- `_resolveLabel({ topicScore, newsHeadlines })` — pure label collapse.
- `_topicFetcher({ ticker, env, signal })` — LunarCrush `/api4/public/topic/{ticker_lowercase}/v1`. Reads `data.types_sentiment` (LC's per-bucket 1–5 sentiment object, e.g. `{tweet: 3.4, news: 4.1, reddit: 2.9}`), averages across present numeric buckets, then maps with the existing `sentimentLabel()` from `trade-context.mjs` (≤2.5 → `bear`, ≥3.5 → `bull`, else `neutral`). Reusing the canonical mapper keeps both providers on one scale.
- `_newsFetcher({ ticker, env, signal })` — delegates to existing `parseLunarCrushNews` from `trade-context.mjs`. Averages `post_sentiment` of the last N=10 headlines from the past 24h, then maps with the same `sentimentLabel()`.
- `_cache: Map<ticker, {snapshot, expiresAtMs}>` with 15-min TTL.
- 2s per-call timeout via AbortController. Mirrors `trade-context.mjs`.
- Outage / malformed JSON / 4xx / 5xx → `null` (never throws). Nulls never cached.

### `trader-fire-decision.mjs` (edited)

New required inputs on `decideFireAction({...})`:
- `sentimentSnapshot: null | { label: 'bull'|'bear'|'neutral', source: 'topic'|'news', fetchedAtMs: number }`
- `sentimentGateMode: 'off' | 'shadow' | 'live'`

New gate position: after `session-blocked`, before tier selection.

Disagreement rule (only triggers when both `pick.fvg.dir` and sentiment label are non-neutral). Uses the same `pick.fvg.dir` field the function already reads at line 39 of `trader-fire-decision.mjs`:
- `pick.fvg.dir === 'bull' && label === 'bear'` → disagree
- `pick.fvg.dir === 'bear' && label === 'bull'` → disagree
- Otherwise (agree / neutral / null) → pass.

Output shape on disagree:
- `mode === 'live'` → `{ action: 'skip', skip: 'sentiment-disagree', detail: '<label> sentiment vs <dir> setup', source }`
- `mode === 'shadow'` → returns the normal `action: 'fire'` result with an extra `shadow: { gate: 'sentiment', wouldSkip: true, label, source }` field attached. Risk + tier unchanged.
- `mode === 'off'` → gate is skipped entirely; `sentimentSnapshot` is effectively unused.

### `azc-trader.mjs` (edited, ~20 lines)

- Import `getSentiment`.
- Read `SENTIMENT_GATE_MODE` once at boot. Unknown value → log warning, treat as `'off'`.
- Inside the existing fire-attempt block, **after candidates are built but before `decideFireAction` is called**: if mode ≠ `'off'` and `candidates.length > 0`, locally compute the top candidate by the same comparator `decideFireAction` uses (smallest `distPct` wins, stable sort), then `await getSentiment(...)` for that ticker. The local sort is intentional duplication — keeps `decideFireAction` pure and keeps the I/O in `azc-trader`. The duplication is two lines.
- Pass `sentimentSnapshot` + `sentimentGateMode` into `decideFireAction`.
- When the returned action has a `shadow` field, attach it to the fire event the existing logger writes.

### `trader-events.mjs` + dashboard (light touch)

- New decision-feed row variants: `sentiment-shadow` (info/yellow) and `sentiment-veto` (red).
- Reuses existing consecutive-same-veto stacking from PR #239.
- `lastScanSummary` entries gain optional `sentiment: { label, source, agree }` so the dashboard can render the badge inline.

### `/trader-state` (server.mjs)

Adds a `sentimentGate` block:
```
sentimentGate: {
  mode: 'shadow' | 'live' | 'off',
  lastSnapshotAt: number | null,
  lastLabel: 'bull' | 'bear' | 'neutral' | null,
  shadowWouldSkipCount24h: number,
  liveSkipCount24h: number
}
```
Read-only diagnostic surface.

### `trader-events` JSONL

Every fire event gains a `sentiment: { label, source, agree, shadowWouldSkip }` field when a snapshot was attached. This is the raw record that PR-2 evidence is built from — replay-grade.

### `trade-learnings.mjs` + `trade-insights.mjs`

- `formatLearningMarkdown` emits a new section when a sentiment snapshot was attached to the fire event:
  ```
  ## Sentiment (at fire)
  - source: topic
  - label:  bear
  - agree:  no
  - shadow gate would have vetoed
  ```
- `writeInsightsFile` adds a "Shadow gate — would-veto outcomes" block aggregating expR for the would-vetoed cohort vs the rest. This block is the evidence basis for the PR-2 flip.

### `relay.env`

- Add documented sample line: `SENTIMENT_GATE_MODE=shadow`
- `LUNARCRUSH_API_KEY` already exists (PR #245).

## 5. Error handling

| Failure | Behaviour |
|---|---|
| `LUNARCRUSH_API_KEY` missing | `getSentiment` returns `null`. Logs `[sentiment-config]` once at boot. Gate fails-open. |
| LC timeout (>2s) | AbortController fires; null. Not cached. Next tick retries. |
| LC 4xx | Null, not cached. 401/403 logs `[sentiment-auth]` once per process. |
| LC 5xx / network error | Null, not cached. `[sentiment-err]` rate-limited to once per 60s per ticker. |
| Malformed JSON | Caught in fetcher, returns null. |
| Topic ok, news fails | Use topic — fallback only triggers when topic is empty/failed. |
| Both empty | `null`. Distinct from neutral. Both fail-open. |
| Clock skew | Cache TTL check uses injected `now`; backward clock jump extends cache life. Acceptable. |
| `SENTIMENT_GATE_MODE` unset | Defaults to `'shadow'`. |
| `SENTIMENT_GATE_MODE` unknown value | Warning + treated as `'off'`. |
| Multiple shadow-veto rows on one tick | Stacked by existing #239 stacker. |

The gate never:
- Affects open-position close or stop-management. Entries only.
- Persists outage state. Each tick is independent.
- Runs on US100/manual lane.

## 6. Testing

### Unit tests (RED first)

**`tests/trader-sentiment.test.mjs` (new)**
- Returns null when no API key.
- Topic fetcher success → `{ label: 'bull', source: 'topic' }`; thresholds at 1.0, 2.5, 3.0, 3.5, 5.0 boundary values (same 1–5 scale as news).
- Topic empty (`data.types_sentiment` missing or all non-numeric) → falls back to news. News headline avg maps correctly at 1.0, 2.5, 3.0, 3.5, 5.0.
- Both empty → null.
- Timeout >2s → null; AbortController called.
- Cache hit within TTL → no fetcher call.
- Cache expiry at TTL boundary → re-fetch.
- Null result NOT cached — second call hits the network.
- 401 logs once, not per-call.

**`tests/trader-fire-decision.test.mjs` (extend)**
- Mode `'off'` → snapshot ignored; decision matches current baseline byte-for-byte.
- Mode `'shadow'`, disagree → `action: 'fire'` with `shadow` field attached; tier + risk unchanged.
- Mode `'live'`, disagree → `action: 'skip', skip: 'sentiment-disagree'`.
- Agree, any mode → fires normally; no `shadow` field.
- Neutral, any mode → fires normally (fail-open).
- Null snapshot, any mode → fires normally (fail-open).
- Side-blocked + sentiment-disagree → side-blocked wins (gate ordering).

**Boot check (extend the existing 4s boot test)**
- Boot with `SENTIMENT_GATE_MODE=shadow` under `relay.env`. Assert no crash, no `[cycle-err]` lines.

### Fixtures

- `tests/fixtures/lc-topic-sol.json` and `tests/fixtures/lc-news-sol.json` — version-pinned LC response shapes so unit tests don't drift if the API moves.

### Live observability after merge

- Decision feed shows `sentiment-shadow` rows; never `sentiment-veto` while in shadow.
- `/trader-state` returns the new `sentimentGate` block.
- Post-mortems for fires after merge include `## Sentiment (at fire)`.
- `INSIGHTS.md` renders the new "Shadow gate — would-veto outcomes" block.

### Eval

- Cannot pre-backtest: sentiment is not in the existing 365d/30d fixtures.
- The forward eval is the shadow window itself — see section 7.

## 7. Rollout

### PR 1 — Shadow mode (this design)

- All sections 3–6 above.
- Deploys with `SENTIMENT_GATE_MODE=shadow` in `relay.env`.
- Trade-action behaviour change on deploy: **none**. Decision feed grows new `sentiment-shadow` rows; post-mortems grow `## Sentiment`.
- Risk: bugs here can only add ≤2s latency (then timeout), spam the log, or write wrong shadow data. None move money.
- Test gate: `npm test` green + 4s boot check passes under `relay.env`.

### Observation window

Wait for ≥ 20 real fires with sentiment snapshots attached. Then read the INSIGHTS shadow-cohort block.

| Would-vetoed cohort vs the rest | Action |
|---|---|
| expR gap ≤ −0.3R against the would-vetoed cohort, on ≥ 10 would-veto trades | PR 2: flip to `live`. Edge confirmed. |
| Disagree-cohort expR equal or better | Hold in shadow or remove the feature. Sentiment is noise on this setup. |
| Disagree cohort < 10 trades after 4 weeks | Extend window. Do not flip on < 10. |
| Gap between −0.1R and −0.3R | Hold; gather another 20 fires. |

### PR 2 — Live flip (separate, narrow PR)

- One-line change: `SENTIMENT_GATE_MODE=live` in `relay.env` + redeploy.
- PR description must paste the INSIGHTS shadow-cohort table as evidence.
- Post-flip: watch `liveSkipCount24h` + trade-learnings for two weeks. If next-20-fires expR drops vs prior-20 baseline, revert to shadow.

### Operational rollback

- Fastest: edit `relay.env` → `SENTIMENT_GATE_MODE=off` → `systemctl restart azc-trader.service`. Per `feedback_no_restart_during_position`, restart only when `/trader-state` reports `positionContext: null`.
- Slower: revert the live-flip PR.

### Success criteria (PR 1)

- ≥ 95% of fires in the 7 days following merge carry a sentiment snapshot.
- Zero `[cycle-err]` lines attributable to sentiment code in `/var/log/azc-trader.log`.
- INSIGHTS shadow block renders and is populated.

## 8. Out of scope

Intentionally deferred. Revisit only if shadow data justifies it.

- Market-wide veto (e.g. BTC sentiment killing alt longs).
- Sentiment-aware risk sizing (boost on strong-agree, downshift on weak-agree).
- US100/manual lane integration.
- Re-using sentiment for exit-management (not just entry).
- Multi-provider blend (LunarCrush + CryptoPanic + funding regime composite).

## 9. Files touched

| File | Change |
|---|---|
| `trader-sentiment.mjs` | NEW |
| `trader-fire-decision.mjs` | EDIT — add gate after session-blocked |
| `azc-trader.mjs` | EDIT — resolve snapshot, pass into decision |
| `trader-events.mjs` | EDIT — new event types + sentiment field |
| `server.mjs` | EDIT — `/trader-state` gains `sentimentGate` block |
| `trade-learnings.mjs` | EDIT — new `## Sentiment (at fire)` section |
| `trade-insights.mjs` | EDIT — shadow-cohort aggregation block |
| `relay.env` (sample) | EDIT — document `SENTIMENT_GATE_MODE` |
| `tests/trader-sentiment.test.mjs` | NEW |
| `tests/trader-fire-decision.test.mjs` | EDIT — gate cases |
| `tests/fixtures/lc-topic-sol.json` | NEW |
| `tests/fixtures/lc-news-sol.json` | NEW |
| `docs/superpowers/specs/2026-05-28-sentiment-veto-shadow-design.md` | NEW (this file) |
