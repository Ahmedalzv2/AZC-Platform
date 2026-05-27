import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRefreshWallet } from '../trader-wallet.mjs';

describe('shouldRefreshWallet', () => {
  const INTERVAL = 30_000;

  test('refreshes when never fetched (lastAt = 0)', () => {
    assert.equal(shouldRefreshWallet(0, 100_000, INTERVAL), true);
  });

  test('skips when called within the refresh interval', () => {
    assert.equal(shouldRefreshWallet(100_000, 105_000, INTERVAL), false);
    assert.equal(shouldRefreshWallet(100_000, 129_999, INTERVAL), false);
  });

  test('refreshes at the exact interval boundary', () => {
    // The original inline gate used `< intervalMs` to skip; at equality
    // it falls through and refreshes. Preserve that.
    assert.equal(shouldRefreshWallet(100_000, 130_000, INTERVAL), true);
  });

  test('refreshes after the interval has elapsed', () => {
    assert.equal(shouldRefreshWallet(100_000, 200_000, INTERVAL), true);
  });

  test('treats a falsy lastAt as never-fetched even when now is 0', () => {
    // Defensive — module-load timing could in theory leave now < lastAt
    // if the system clock jumps. Don't crash, just refresh.
    assert.equal(shouldRefreshWallet(0, 0, INTERVAL), true);
  });
});
