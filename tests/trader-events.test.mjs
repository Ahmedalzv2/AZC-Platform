import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  appendScanEvent, trimEventsFile, readTailEvents, eventsFileStat,
} from '../trader-events.mjs';

let tmp, eventsPath;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'trader-events-'));
  eventsPath = path.join(tmp, 'events.jsonl');
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('trader-events', () => {
  it('appendScanEvent writes one JSONL line per call', async () => {
    await appendScanEvent(eventsPath, { ts: 1, cycle: 1, scan: [] });
    await appendScanEvent(eventsPath, { ts: 2, cycle: 2, scan: [{ symbol: 'BTC', skip: 'no-fvg' }] });
    const s = await eventsFileStat(eventsPath);
    assert.equal(s.lines, 2);
  });

  it('readTailEvents returns oldest-first up to the limit', async () => {
    const events = await readTailEvents(eventsPath, 10);
    assert.equal(events.length, 2);
    assert.equal(events[0].cycle, 1);
    assert.equal(events[1].cycle, 2);
  });

  it('readTailEvents returns [] for a missing file', async () => {
    const events = await readTailEvents(path.join(tmp, 'missing.jsonl'), 10);
    assert.deepEqual(events, []);
  });

  it('trimEventsFile prunes to the last `keep` lines', async () => {
    const trimPath = path.join(tmp, 'trim.jsonl');
    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ cycle: i }) + '\n').join('');
    await writeFile(trimPath, lines, 'utf8');
    const result = await trimEventsFile(trimPath, 5);
    assert.equal(result.trimmed, 45);
    const tail = await readTailEvents(trimPath, 5);
    assert.equal(tail.length, 5);
    assert.equal(tail[0].cycle, 45);
    assert.equal(tail[4].cycle, 49);
  });

  it('trimEventsFile is a no-op below the cap', async () => {
    const result = await trimEventsFile(eventsPath, 10);
    assert.equal(result.trimmed, 0);
  });

  it('appendScanEvent silently trims after TRIM_EVERY appends', async () => {
    const ringPath = path.join(tmp, 'ring.jsonl');
    // TRIM_EVERY=200, MAX_LINES=2000 — write 2300 entries and confirm
    // the file gets trimmed to MAX_LINES at the boundary.
    for (let i = 0; i < 2300; i++) {
      await appendScanEvent(ringPath, { cycle: i });
    }
    const stat = await eventsFileStat(ringPath);
    assert.ok(stat.lines <= 2200, `expected <=2200 lines after trim cycles, got ${stat.lines}`);
  });
});
