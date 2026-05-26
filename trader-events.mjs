// Append-only ring buffer for scan-cycle decisions. Each scan produces
// one JSONL line summarising what the trader saw and why it didn't
// (or did) fire on each symbol. The dashboard reads the tail so the
// operator gets decision provenance instead of just the latest snapshot.
//
// The file is trimmed in place every TRIM_EVERY appends to the last
// MAX_LINES entries — keeps disk usage bounded without rotating files.

import { appendFile, readFile, writeFile, stat } from 'node:fs/promises';

const MAX_LINES   = 2000;
const TRIM_EVERY  = 200;

let appendsSinceTrim = 0;

export async function appendScanEvent(eventsPath, cyclePayload) {
  const line = JSON.stringify(cyclePayload) + '\n';
  await appendFile(eventsPath, line, 'utf8');
  appendsSinceTrim += 1;
  if (appendsSinceTrim >= TRIM_EVERY) {
    appendsSinceTrim = 0;
    await trimEventsFile(eventsPath, MAX_LINES);
  }
}

// Trim the JSONL file in place to the last `keep` lines. Cheaper than
// rotating files for the volumes we expect (~5760 scans/day at 15s
// cycle * ~300 bytes/line ≈ 1.7 MB/day).
export async function trimEventsFile(eventsPath, keep = MAX_LINES) {
  try {
    const raw = await readFile(eventsPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length <= keep) return { trimmed: 0 };
    const tail = lines.slice(-keep);
    await writeFile(eventsPath, tail.join('\n') + '\n', 'utf8');
    return { trimmed: lines.length - keep };
  } catch (e) {
    if (e.code === 'ENOENT') return { trimmed: 0 };
    throw e;
  }
}

// Read the last `limit` JSONL events from disk. Returns oldest-first
// for consistent dashboard rendering.
export async function readTailEvents(eventsPath, limit = 200) {
  let raw;
  try { raw = await readFile(eventsPath, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const lines = raw.split('\n').filter(Boolean);
  const tail = limit > 0 ? lines.slice(-limit) : lines;
  const out = [];
  for (const ln of tail) {
    try { out.push(JSON.parse(ln)); } catch {}
  }
  return out;
}

// Inspect the file without parsing — used by tests + ops to size disk.
export async function eventsFileStat(eventsPath) {
  try {
    const s = await stat(eventsPath);
    const raw = await readFile(eventsPath, 'utf8');
    return { bytes: s.size, lines: raw.split('\n').filter(Boolean).length };
  } catch (e) {
    if (e.code === 'ENOENT') return { bytes: 0, lines: 0 };
    throw e;
  }
}
