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
      consecutiveLosses: 4, haltedAt: null, cooldownUntil: {},
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
      consecutiveLosses: 3,
      haltedAt: null,
      cooldownUntil: { SOL_USDT: 1_500_000, DOGE_USDT: 999_000 },
    });
    const out = await loadTraderStateFromDisk(file, now);
    assert.deepEqual(out, {
      tradesToday: 6,
      dailyPnlUsd: -1.0331,
      consecutiveLosses: 3,
      haltedAt: null,
      dailyResetAt: 9_999_999,
      cooldownUntil: { SOL_USDT: 1_500_000 },
    });
  });

  test('preserves an active halt across restart', async () => {
    const file = await makeStateFile({
      dailyResetAt: 9_999_999,
      tradesToday: 5,
      dailyPnlUsd: -1.5,
      consecutiveLosses: 5,
      haltedAt: '2026-05-25T20:30:00.000Z',
      cooldownUntil: {},
    });
    const out = await loadTraderStateFromDisk(file, 1_000_000);
    assert.equal(out.consecutiveLosses, 5);
    assert.equal(out.haltedAt, '2026-05-25T20:30:00.000Z');
  });

  test('drops expired per-symbol cooldowns, keeps future ones', async () => {
    const now = 1_500_000;
    const file = await makeStateFile({
      dailyResetAt: 9_999_999,
      tradesToday: 0,
      dailyPnlUsd: 0,
      consecutiveLosses: 0,
      haltedAt: null,
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
      consecutiveLosses: 0,
      haltedAt: null,
      dailyResetAt: 9_999_999,
      cooldownUntil: {},
    });
  });
});
