// Shadow observability for the mean-rev lane. In DRY_RUN the executor opens
// nothing, so reconcileClosed/notifyLearn never fire and the lane is a
// stdout-only black box. This turns every decision — an armed entry intent or
// a skip — into one JSONL line, so a shadow run produces a reviewable signal
// stream. That stream is the input the deployment gate ("N sane shadow
// signals") and the live-vs-backtest fill audit both need before any live arm.
//
// Pure on purpose: the executor calls main() at module load, so its logic
// can't be imported under test. Keep the record shape here where it can.

// Health/heartbeat snapshot for the lane, written each cycle to
// .meanrev-state/state.json. A relay endpoint can serve this so status is
// visible without digging through journal/file state. lastCycleAt going
// stale means the cycle stopped completing — the "active but dead" signal.
export function buildMeanRevHealth({ now, cycleCount, dryRun, killed, basket, pending, positions, cooldowns }) {
  return {
    ts: now,
    lastCycleAt: now,
    cycleCount,
    dryRun: !!dryRun,
    killed: !!killed,
    strategy: 'meanrev-4h-fade',
    basket,
    pending,
    positions,
    cooldowns: cooldowns || {},
  };
}

export function shadowSignalRecord({ now, plan, barTs, dryRun, sentiment }) {
  const base = {
    ts: now,
    barTs,
    dryRun: !!dryRun,
    symbol: plan.symbol,
    strategy: 'meanrev-4h-fade',
  };
  if (plan.skip) return { ...base, decision: 'skip', reason: plan.skip };
  return {
    ...base,
    decision: 'entry',
    dir: plan.dir,
    entry: plan.entry,
    stop: plan.stop,
    tp: plan.tp,
    qty: plan.qty,
    riskUsd: plan.riskUsd,
    atr: plan.atr,
    ...(sentiment ? { sentiment } : {}),
  };
}
