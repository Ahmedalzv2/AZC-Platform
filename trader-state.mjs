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

  // If the saved day window has already rolled past, let the live
  // day-roll path produce clean defaults.
  const dailyResetAt = Number(s.dailyResetAt);
  if (!Number.isFinite(dailyResetAt) || dailyResetAt <= now) return null;

  return {
    tradesToday: Number.isFinite(Number(s.tradesToday)) ? Number(s.tradesToday) : 0,
    dailyPnlUsd: Number.isFinite(Number(s.dailyPnlUsd)) ? Number(s.dailyPnlUsd) : 0,
    dailyResetAt,
    cooldownUntil: filterFutureCooldowns(s.cooldownUntil, now),
    positionContext: pickRehydratablePosition(s.positionContext),
    // Persisted on the same daily window as tradesToday/dailyPnlUsd — the
    // gate window only has meaning if it survives the systemd restarts
    // that punctuate every dev iteration. Without this, six restarts in
    // a day silently wipe the sentiment shadow sample.
    sentimentShadowSkips24h: pickNonNegInt(s.sentimentGate?.shadowWouldSkipCount24h),
    sentimentLiveSkips24h:   pickNonNegInt(s.sentimentGate?.liveSkipCount24h),
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
