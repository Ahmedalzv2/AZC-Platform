// Restore daily safety counters from a previous run's state.json.
//
// The trader writes state.json every cycle but only reads it back at
// startup through this helper. The point is to survive systemd restarts
// without losing the daily $-loss cap, consecutive-loss halt, per-symbol
// cooldowns, or trades-today count.
//
// We deliberately do *not* restore positionContext or pendingOrder:
// the startup-cleanup path cancels any stray maker order, and live
// position recovery is its own concern (the trader polls MEXC for
// real positions, not local state).

import { readFile } from 'node:fs/promises';

export async function loadTraderStateFromDisk(statePath, now = Date.now()) {
  let raw;
  try { raw = await readFile(statePath, 'utf8'); }
  catch { return null; }

  let s;
  try { s = JSON.parse(raw); }
  catch { return null; }

  // If the saved day window has already rolled past, let the live
  // day-roll path produce clean defaults — restoring stale counters
  // would defeat the safety reset.
  const dailyResetAt = Number(s.dailyResetAt);
  if (!Number.isFinite(dailyResetAt) || dailyResetAt <= now) return null;

  return {
    tradesToday: Number.isFinite(Number(s.tradesToday)) ? Number(s.tradesToday) : 0,
    dailyPnlUsd: Number.isFinite(Number(s.dailyPnlUsd)) ? Number(s.dailyPnlUsd) : 0,
    consecutiveLosses: Number.isFinite(Number(s.consecutiveLosses)) ? Number(s.consecutiveLosses) : 0,
    haltedAt: typeof s.haltedAt === 'string' ? s.haltedAt : null,
    dailyResetAt,
    cooldownUntil: filterFutureCooldowns(s.cooldownUntil, now),
  };
}

function filterFutureCooldowns(raw, now) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [sym, ts] of Object.entries(raw)) {
    const t = Number(ts);
    if (Number.isFinite(t) && t > now) out[sym] = t;
  }
  return out;
}
