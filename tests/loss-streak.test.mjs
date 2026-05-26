// Loss-streak safety controls. Pure tests for the killzone-boundary helper
// that the 3-loss pause uses; the rest of the streak logic is exercised
// via the live trader's state and post-mortem audit, not in-process.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nextKillzoneBoundary } from '../trader-killzones.mjs';

// Killzone windows (UTC) — mirrors KILLZONES_UTC in azc-trader.mjs.
// Asia 00:00-04:00 · London 07:00-10:00 · NY AM 12:30-16:00 · Late-NY 18:30-22:00
const at = (h, m = 0) => new Date(Date.UTC(2026, 4, 26, h, m, 0));

describe('nextKillzoneBoundary', () => {
  test('inside Asia (02:00) → returns end of Asia (04:00 same day)', () => {
    const ts = nextKillzoneBoundary(at(2, 0));
    assert.equal(new Date(ts).toISOString(), '2026-05-26T04:00:00.000Z');
  });

  test('between Asia and London (05:30) → returns start of London (07:00)', () => {
    const ts = nextKillzoneBoundary(at(5, 30));
    assert.equal(new Date(ts).toISOString(), '2026-05-26T07:00:00.000Z');
  });

  test('inside NY-AM (14:00) → returns end of NY-AM (16:00 same day)', () => {
    const ts = nextKillzoneBoundary(at(14, 0));
    assert.equal(new Date(ts).toISOString(), '2026-05-26T16:00:00.000Z');
  });

  test('between NY-AM and Late-NY (17:00) → returns start of Late-NY (18:30)', () => {
    const ts = nextKillzoneBoundary(at(17, 0));
    assert.equal(new Date(ts).toISOString(), '2026-05-26T18:30:00.000Z');
  });

  test('past all killzones (22:30) → returns tomorrow Asia open (00:00 next day)', () => {
    const ts = nextKillzoneBoundary(at(22, 30));
    assert.equal(new Date(ts).toISOString(), '2026-05-27T00:00:00.000Z');
  });

  test('at exactly Asia open (00:00:00) → inside, returns end of Asia', () => {
    const ts = nextKillzoneBoundary(at(0, 0));
    assert.equal(new Date(ts).toISOString(), '2026-05-26T04:00:00.000Z');
  });

  test('return value is always > now (forward only, never backward)', () => {
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 15, 30, 45]) {
        const now = at(h, m);
        const next = nextKillzoneBoundary(now);
        assert.ok(next > now.getTime(), `boundary at ${h}:${m} went backward: ${new Date(next).toISOString()}`);
      }
    }
  });
});
