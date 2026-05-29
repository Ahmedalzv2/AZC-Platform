// Restore daily counters, per-symbol cooldowns, and the persisted trade
// state (positionContext + pendingOrder) from a previous run's state.json.
// Survives systemd restarts so trades-today, cooldowns, and the live trade
// context don't reset on every redeploy.
//
// positionContext and pendingOrder are passed through RAW (not pre-filtered)
// so decideRestore can reconcile them against the live exchange. In
// particular a maker context persisted BEFORE its fill has no posId yet —
// decideRestore needs that context to re-adopt a fill that landed during
// downtime with its full fire-time WHY intact, instead of letting orphan-
// adoption mislabel it as manual. Pre-nulling no-posId contexts here (the
// old behaviour) silently broke that path.
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
    // Raw — decideRestore verifies against MEXC and handles the no-posId
    // (maker pre-fill) case.
    positionContext: pickObject(s.positionContext),
    pendingOrder: (s.pendingOrder && typeof s.pendingOrder === 'object' && s.pendingOrder.orderId != null)
      ? s.pendingOrder : null,
    // Daily-window counters, so they reset with the day-roll above.
    sentimentShadowSkips24h: dayRolled ? 0 : pickNonNegInt(s.sentimentGate?.shadowWouldSkipCount24h),
    sentimentLiveSkips24h:   dayRolled ? 0 : pickNonNegInt(s.sentimentGate?.liveSkipCount24h),
  };
}

function pickNonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function pickObject(v) {
  return v && typeof v === 'object' ? v : null;
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
