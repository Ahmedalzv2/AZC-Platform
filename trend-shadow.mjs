// Shadow observability for the trend+trail lane, parallel to meanrev-shadow.mjs.
// The verified-stronger lane (production decideStep/tradeNetR, gated, all-taker)
// runs dry-run alongside mean-rev so the deployment gate compares LIVE signal
// cadence, fill realism, and fee drag — not more backtests. Each noteworthy
// decideStep outcome becomes one JSONL line.
//
// Pure on purpose: the executor calls main() at module load, so its logic can't
// be imported under test. Keep the record shape here where it can.

// Health/heartbeat snapshot, written each cycle to .trend-state/state.json. A
// stale lastCycleAt is the "active but dead" signal. Trend entry is a taker
// breakout (no resting maker order), so there is no `pending` state to track.
export function buildTrendHealth({ now, cycleCount, dryRun, killed, basket, positions, cooldowns }) {
  return {
    ts: now,
    lastCycleAt: now,
    cycleCount,
    dryRun: !!dryRun,
    killed: !!killed,
    strategy: 'trend-trail-4h',
    basket,
    positions,
    cooldowns: cooldowns || {},
  };
}

// Map a decideStep result to a shadow record, or null when there's nothing
// worth logging (no breakout, or an open position merely trailing). Records:
// entry (breakout open), exit (trailing-stop close), skip (breakout suppressed
// by the regime gate — the fill-audit-relevant near-miss).
export function trendSignalRecord({ now, d, barTs, symbol, dryRun, netR, sentiment }) {
  const base = { ts: now, barTs, dryRun: !!dryRun, symbol, strategy: 'trend-trail-4h' };
  if (d.action === 'open') return { ...base, decision: 'entry', dir: d.dir, entry: d.entry, stop: d.initialStop, atr: d.atrAtEntry, ...(sentiment ? { sentiment } : {}) };
  if (d.action === 'close') return { ...base, decision: 'exit', exit: d.exit, win: !!d.win, ...(netR != null ? { netR } : {}) };
  if (d.action === 'flat' && d.regime === 'chop') return { ...base, decision: 'skip', reason: 'chop' };
  return null;
}
