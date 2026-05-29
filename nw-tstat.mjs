// Newey-West (Bartlett-kernel) HAC t-statistic for the mean of a return
// series. Mirrors the Jegadeesh-Titman notebook's treatment: iid standard
// errors understate significance when returns are serially correlated (trend
// regimes cluster), so the HAC correction widens the SE and the honest t-stat
// is the HAC one. Pure + dependency-free so it can run in the test harness.

// Newey-West (1994) rule-of-thumb bandwidth, clamped to a usable lag count.
export function autoLag(n) {
  if (n <= 1) return 0;
  return Math.max(0, Math.min(Math.floor(4 * Math.pow(n / 100, 2 / 9)), n - 1));
}

// Long-run variance of the mean via Bartlett-weighted autocovariances:
//   S = g0 + 2 Σ_{l=1..L} (1 - l/(L+1)) g_l ,   Var(mean) = S / n.
export function neweyWestTStat(x, maxlags) {
  const n = x.length;
  if (n === 0) return { n: 0, mean: 0, seIid: 0, tIid: 0, seHac: 0, tHac: 0, lags: 0 };
  const mean = x.reduce((s, v) => s + v, 0) / n;
  const e = x.map(v => v - mean);
  const g = (l) => { let s = 0; for (let t = l; t < n; t++) s += e[t] * e[t - l]; return s / n; };
  const g0 = g(0);
  const L = Math.max(0, Math.min(maxlags ?? autoLag(n), n - 1));
  let S = g0;
  for (let l = 1; l <= L; l++) S += 2 * (1 - l / (L + 1)) * g(l);
  const seHac = Math.sqrt(Math.max(0, S / n));
  const tHac = seHac > 0 ? mean / seHac : 0;
  // iid SE uses the sample variance (n-1 denominator).
  const s2 = n > 1 ? e.reduce((s, v) => s + v * v, 0) / (n - 1) : 0;
  const seIid = n > 1 ? Math.sqrt(s2 / n) : 0;
  const tIid = seIid > 0 ? mean / seIid : 0;
  return { n, mean, seIid, tIid, seHac, tHac, lags: L };
}
