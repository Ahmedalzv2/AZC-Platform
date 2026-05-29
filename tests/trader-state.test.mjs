import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadTraderStateFromDisk } from '../trader-state.mjs';

async function makeStateFile(contents) {
  const dir = await mkdtemp(path.join(tmpdir(), 'trader-state-'));
  const file = path.join(dir, 'state.json');
  await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return file;
}

describe('loadTraderStateFromDisk', () => {
  test('returns null when file does not exist', async () => {
    const out = await loadTraderStateFromDisk('/no/such/file.json', 1_000_000);
    assert.equal(out, null);
  });

  test('returns null on malformed JSON', async () => {
    const file = await makeStateFile('{not json');
    const out = await loadTraderStateFromDisk(file, 1_000_000);
    assert.equal(out, null);
  });

  test('returns null when dailyResetAt has already passed (let day-roll reset)', async () => {
    const now = 2_000_000;
    const file = await makeStateFile({
      dailyResetAt: 1_000_000, tradesToday: 9, dailyPnlUsd: -5,
      cooldownUntil: {},
    });
    const out = await loadTraderStateFromDisk(file, now);
    assert.equal(out, null);
  });

  test('restores counters when file is within current day window', async () => {
    const now = 1_000_000;
    const file = await makeStateFile({
      dailyResetAt: 9_999_999,
      tradesToday: 6,
      dailyPnlUsd: -1.0331,
      cooldownUntil: { SOL_USDT: 1_500_000, DOGE_USDT: 999_000 },
    });
    const out = await loadTraderStateFromDisk(file, now);
    assert.deepEqual(out, {
      tradesToday: 6,
      dailyPnlUsd: -1.0331,
      dailyResetAt: 9_999_999,
      cooldownUntil: { SOL_USDT: 1_500_000 },
      closedPosIds: {},
      positionContext: null,
      sentimentShadowSkips24h: 0,
      sentimentLiveSkips24h: 0,
    });
  });

  test('restores recently-closed posIds, drops ones past the TTL', async () => {
    const now = 5_000_000_000;
    const file = await makeStateFile({
      dailyResetAt: now + 1, tradesToday: 0, dailyPnlUsd: 0, cooldownUntil: {},
      closedPosIds: {
        '1396470897': now - 6_000,      // fresh — keep
        '1396000000': now - 3_700_000,  // > 1h old — drop
      },
    });
    const out = await loadTraderStateFromDisk(file, now);
    assert.deepEqual(out.closedPosIds, { '1396470897': now - 6_000 });
  });

  test('restores sentiment 24h skip counters from sentimentGate', async () => {
    const file = await makeStateFile({
      dailyResetAt: 9_999_999, tradesToday: 0, dailyPnlUsd: 0, cooldownUntil: {},
      sentimentGate: {
        mode: 'shadow',
        shadowWouldSkipCount24h: 3,
        liveSkipCount24h: 1,
      },
    });
    const out = await loadTraderStateFromDisk(file, 1_000_000);
    assert.equal(out.sentimentShadowSkips24h, 3);
    assert.equal(out.sentimentLiveSkips24h, 1);
  });

  test('sentiment counters default to 0 when missing or invalid', async () => {
    const file = await makeStateFile({
      dailyResetAt: 9_999_999, tradesToday: 0, dailyPnlUsd: 0, cooldownUntil: {},
      sentimentGate: { mode: 'shadow', shadowWouldSkipCount24h: 'oops', liveSkipCount24h: -2 },
    });
    const out = await loadTraderStateFromDisk(file, 1_000_000);
    assert.equal(out.sentimentShadowSkips24h, 0);
    assert.equal(out.sentimentLiveSkips24h, 0);
  });

  test('ignores legacy consecutiveLosses/haltedAt fields on disk', async () => {
    // State files written before the 2026-05-26 cascade removal still
    // carry these fields. The loader silently drops them; no crash, no
    // resurrection of halt state.
    const file = await makeStateFile({
      dailyResetAt: 9_999_999,
      tradesToday: 5,
      dailyPnlUsd: -1.5,
      consecutiveLosses: 5,
      haltedAt: '2026-05-25T20:30:00.000Z',
      cooldownUntil: {},
    });
    const out = await loadTraderStateFromDisk(file, 1_000_000);
    assert.equal(out.consecutiveLosses, undefined);
    assert.equal(out.haltedAt, undefined);
  });

  test('drops expired per-symbol cooldowns, keeps future ones', async () => {
    const now = 1_500_000;
    const file = await makeStateFile({
      dailyResetAt: 9_999_999,
      tradesToday: 0,
      dailyPnlUsd: 0,
      cooldownUntil: {
        ALREADY_EXPIRED: 1_000_000,
        STILL_ACTIVE:    2_000_000,
        EQUAL_TO_NOW:    1_500_000,
        NOT_A_NUMBER:    'oops',
      },
    });
    const out = await loadTraderStateFromDisk(file, now);
    assert.deepEqual(out.cooldownUntil, { STILL_ACTIVE: 2_000_000 });
  });

  test('coerces missing numeric fields to safe defaults', async () => {
    const file = await makeStateFile({ dailyResetAt: 9_999_999 });
    const out = await loadTraderStateFromDisk(file, 1_000_000);
    assert.deepEqual(out, {
      tradesToday: 0,
      dailyPnlUsd: 0,
      dailyResetAt: 9_999_999,
      cooldownUntil: {},
      closedPosIds: {},
      positionContext: null,
      sentimentShadowSkips24h: 0,
      sentimentLiveSkips24h: 0,
    });
  });

  test('positionContext is null when absent on disk', async () => {
    const file = await makeStateFile({
      dailyResetAt: 9_999_999, tradesToday: 0, dailyPnlUsd: 0, cooldownUntil: {},
    });
    const out = await loadTraderStateFromDisk(file, 1_000_000);
    assert.equal(out.positionContext, null);
  });

  test('positionContext is null when posId is missing (pre-fill, cannot rehydrate)', async () => {
    const file = await makeStateFile({
      dailyResetAt: 9_999_999, tradesToday: 0, dailyPnlUsd: 0, cooldownUntil: {},
      positionContext: { symbol: 'XRP_USDT', dir: 'bear', orderId: 'abc', entry: 1.3 },
    });
    const out = await loadTraderStateFromDisk(file, 1_000_000);
    assert.equal(out.positionContext, null);
  });

  test('positionContext is returned as-is when posId is present', async () => {
    const ctx = {
      symbol: 'SOL_USDT', dir: 'bear', side: 3, entry: 80.4, sl: 80.56, tp: 80.11,
      qty: 134, lev: 10, posId: '1395669620', orderId: '9991', openedAt: 1_000_000,
      filledAt: 1_000_500, tier: 'top2', riskPct: 0.03, htfDir: 'bear',
      session: 'asia', meta: { contractSize: 0.1, priceUnit: 0.01, minVol: 1 },
      sentiment: { label: 'bear', source: 'topic', agree: true, shadowWouldSkip: false },
    };
    const file = await makeStateFile({
      dailyResetAt: 9_999_999, tradesToday: 1, dailyPnlUsd: 2.5, cooldownUntil: {},
      positionContext: ctx,
    });
    const out = await loadTraderStateFromDisk(file, 1_000_000);
    assert.deepEqual(out.positionContext, ctx);
  });
});
