// Restore daily counters, per-symbol cooldowns, and a still-open
// positionContext from a previous run's state.json. Survives systemd
// restarts so trades-today, cooldowns, and (when armed) the live trade
// context don't reset on every redeploy.
//
// positionContext is returned only when posId is present — without an
// exchange position id the trader has no way to verify the trade is
// still alive, and the cleanest move is to drop it and let the live
// position poller observe whatever MEXC shows. The caller is expected
// to verify the position still exists on MEXC before applying.
//
// The consecutiveLosses/haltedAt cascade was removed 2026-05-26 — drift
// gates (side + session + symbol-side) replace it.

import { readFile } from 'node:fs/promises';

export async function loadTraderStateFromDisk(statePath, now = Date.now()) {
  let raw;
  try { raw = await readFile(statePath, 'utf8'); }
  catch { return null; }

  let s;
  try { s = JSON.parse(raw); }
  catch { return null; }

  // The saved daily window may have rolled past while the trader was down.
  // When it has, the daily COUNTERS (trades, P&L, sentiment skips) reset to
  // a fresh day — but restart-safety state (an open position, live cooldowns,
  // and the closedPosIds re-adopt guard) is TIME-based, not day-based, and
  // must survive the boundary. The old code returned null on a rolled day,
  // discarding all of it: a restart minutes after midnight then re-adopted a
  // still-flapping closed position and re-booked its loss (the #260 bug,
  // reopened by the clock), and an open position lost its tracking entirely.
  const savedReset = Number(s.dailyResetAt);
  const dayRolled  = !Number.isFinite(savedReset) || savedReset <= now;

  return {
    tradesToday: dayRolled ? 0 : (Number.isFinite(Number(s.tradesToday)) ? Number(s.tradesToday) : 0),
    dailyPnlUsd: dayRolled ? 0 : (Number.isFinite(Number(s.dailyPnlUsd)) ? Number(s.dailyPnlUsd) : 0),
    // null signals the caller to keep its own fresh nextUtcMidnight().
    dailyResetAt: dayRolled ? null : savedReset,
    cooldownUntil: filterFutureCooldowns(s.cooldownUntil, now),
    closedPosIds: filterRecentClosedPosIds(s.closedPosIds, now),
    positionContext: pickRehydratablePosition(s.positionContext),
    // Daily-window counters, so they reset with the day-roll above.
    sentimentShadowSkips24h: dayRolled ? 0 : pickNonNegInt(s.sentimentGate?.shadowWouldSkipCount24h),
    sentimentLiveSkips24h:   dayRolled ? 0 : pickNonNegInt(s.sentimentGate?.liveSkipCount24h),
  };
}

function pickNonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function pickRehydratablePosition(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  if (!ctx.posId) return null;
  return ctx;
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

// Reconciled-closed posIds, kept only while still inside the re-adopt block
// window so a restart mid-flap doesn't re-adopt a position the previous run
// already booked. Mirrors the 1h TTL in trader-orphan.isReadoptBlocked.
function filterRecentClosedPosIds(raw, now, ttlMs = 3_600_000) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [pid, ts] of Object.entries(raw)) {
    const t = Number(ts);
    if (Number.isFinite(t) && (now - t) < ttlMs) out[pid] = t;
  }
  return out;
}
