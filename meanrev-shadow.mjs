// Shadow observability for the mean-rev lane. In DRY_RUN the executor opens
// nothing, so reconcileClosed/notifyLearn never fire and the lane is a
// stdout-only black box. This turns every decision — an armed entry intent or
// a skip — into one JSONL line, so a shadow run produces a reviewable signal
// stream. That stream is the input the deployment gate ("N sane shadow
// signals") and the live-vs-backtest fill audit both need before any live arm.
//
// Pure on purpose: the executor calls main() at module load, so its logic
// can't be imported under test. Keep the record shape here where it can.

export function shadowSignalRecord({ now, plan, barTs, dryRun }) {
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
  };
}
