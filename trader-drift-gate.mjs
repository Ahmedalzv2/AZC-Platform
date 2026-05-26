// Pure drift-gate decision. Shared by the side-gate (LONG/SHORT) and
// the session-gate (asia/london/ny-am/late-ny/off). Both apply the same
// "absolute expR threshold after min sample" rule so the operator only
// has one mental model.
//
// Inputs:
//   sum = { total, expectancyR }            (from trade-stats.summarise)
//   thresholds = { minSample, downshiftR, blockR }
//
// Output:
//   { n, expR, status: 'enabled'|'downshifted'|'blocked', reason }

export function decideGate(sum, thresholds) {
  const { minSample, downshiftR, blockR } = thresholds;
  const total = sum?.total ?? 0;
  if (total < minSample) {
    return { n: total, expR: sum?.expectancyR ?? null, status: 'enabled',
      reason: `below min sample (${total}/${minSample})` };
  }
  const r = sum.expectancyR ?? 0;
  if (r < blockR) {
    return { n: total, expR: r, status: 'blocked',
      reason: `live ${r.toFixed(3)}R/trade < block threshold ${blockR}R after ${total} trades` };
  }
  if (r < downshiftR) {
    return { n: total, expR: r, status: 'downshifted',
      reason: `live ${r.toFixed(3)}R/trade < downshift threshold ${downshiftR}R after ${total} trades — halving risk` };
  }
  return { n: total, expR: r, status: 'enabled',
    reason: `live ${r >= 0 ? '+' : ''}${r.toFixed(3)}R/trade over ${total} trades` };
}

// Bucket a flat trade list by session label, defaulting to 'off' when
// the session field is missing or 'no-killzone'.
export function groupBySession(trades) {
  const groups = {};
  for (const t of trades) {
    const k = (t.session && t.session !== 'no-killzone') ? t.session : 'off';
    (groups[k] ||= []).push(t);
  }
  return groups;
}
