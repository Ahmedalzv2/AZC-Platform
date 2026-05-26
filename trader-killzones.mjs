// Pure killzone helpers. Kept in their own module so tests can exercise
// them without importing azc-trader.mjs (which exits at load when MEXC
// creds are missing).
//
// Asia    00:00-04:00 UTC
// London  07:00-10:00 UTC
// NY AM   12:30-16:00 UTC
// Late-NY 18:30-22:00 UTC

export const KILLZONES_UTC = [
  { name: 'asia',    startH: 0,  startM: 0,  endH: 4,  endM: 0 },
  { name: 'london',  startH: 7,  startM: 0,  endH: 10, endM: 0 },
  { name: 'ny-am',   startH: 12, startM: 30, endH: 16, endM: 0 },
  { name: 'late-ny', startH: 18, startM: 30, endH: 22, endM: 0 },
];

export function inKillzone(now = new Date()) {
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return KILLZONES_UTC.some(z => {
    const s = z.startH * 60 + z.startM;
    const e = z.endH * 60 + z.endM;
    return m >= s && m < e;
  });
}

export function currentKillzoneName(now = new Date()) {
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const z of KILLZONES_UTC) {
    const s = z.startH * 60 + z.startM;
    const e = z.endH * 60 + z.endM;
    if (m >= s && m < e) return z.name;
  }
  return null;
}

// Returns the unix-ms timestamp of the next session boundary. If inside a
// killzone, returns its end. If outside, returns the start of the next one
// (wrapping to tomorrow's Asia open after the final Late-NY window).
export function nextKillzoneBoundary(now = new Date()) {
  const minsNow = now.getUTCHours() * 60 + now.getUTCMinutes();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const candidates = [];
  for (const z of KILLZONES_UTC) {
    const s = z.startH * 60 + z.startM;
    const e = z.endH * 60 + z.endM;
    if (minsNow >= s && minsNow < e) candidates.push(dayStart + e * 60 * 1000);
    else if (minsNow < s)            candidates.push(dayStart + s * 60 * 1000);
  }
  if (candidates.length) return Math.min(...candidates);
  return dayStart + 24 * 3600 * 1000 + KILLZONES_UTC[0].startH * 60 * 60 * 1000;
}
