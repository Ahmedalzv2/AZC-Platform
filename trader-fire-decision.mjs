// Pure fire-decision logic — every gate that lives between "we have
// candidates" and "we place the order" runs here. No exchange calls, no
// I/O, no side effects. Caller fetches the snapshot (pending order
// flag, open positions count, gate states, current session label,
// risk tiers) and receives back a structured decision the order-
// placement wrapper can act on.
//
// Splitting this out:
//   1. Lets tests pin every skip path and risk-tier permutation without
//      mocking MEXC.
//   2. Keeps azc-trader.mjs's `tryFire` to I/O + logging.
//   3. Survives future gate additions — new rule lands as one more
//      conditional here plus one more test case.

const TIER_MARGIN = 0.5;  // top-1 wins "best" iff its distPct is >50% better than top-2

export function decideFireAction({
  candidates,        // [{symbol, fvg:{dir, formedAt}, distPct, ...}]
  pendingOrder,      // boolean
  openPositions,    // number
  maxOpenPositions, // number
  sideStatus,        // { long: {status, reason}, short: {status, reason} }
  sessionStatus,     // { asia: {status, reason}, london: {...}, ... }
  symbolSideStatus = null, // { "SOL_USDT:long": {status, reason}, ... }
  currentSession,    // 'asia' | 'london' | 'ny-am' | 'late-ny' | 'off'
  riskTiers,         // { default, top2, best }
  sentimentSnapshot = null,
  sentimentGateMode = 'off',
}) {
  if (pendingOrder)                            return { action: 'skip', skip: 'pending-order' };
  if (openPositions >= maxOpenPositions)       return { action: 'skip', skip: 'in-position' };
  if (!Array.isArray(candidates) || !candidates.length) {
    return { action: 'skip', skip: 'no-candidates' };
  }

  // Symbol-side gate filters candidates BEFORE pick. Unlike side/session
  // (which gate the global top-1 and skip the whole cycle on block),
  // symbol-side exists precisely to let a healthy XRP:short fire when
  // SOL:short is bleeding. Missing keys fail-open.
  const symSideKey = c => `${c.symbol}:${c.fvg.dir === 'bull' ? 'long' : 'short'}`;
  const surviving = symbolSideStatus
    ? candidates.filter(c => symbolSideStatus[symSideKey(c)]?.status !== 'blocked')
    : candidates;
  if (!surviving.length) {
    return {
      action: 'skip', skip: 'symbol-side-blocked-all',
      detail: `${candidates.length} candidate(s) blocked by symbol-side gate`,
    };
  }

  // Closest to FVG mid wins. Stable sort by distPct ascending so ties
  // preserve scan order — matters when distPct rounds to the same float
  // across two symbols.
  const sorted = [...surviving].sort((a, b) => a.distPct - b.distPct);
  const pick = sorted[0];

  const sideKey = pick.fvg.dir === 'bull' ? 'long' : 'short';
  const sideState = sideStatus?.[sideKey];
  if (sideState?.status === 'blocked') {
    return {
      action: 'skip', skip: 'side-blocked',
      detail: `${sideKey.toUpperCase()}: ${sideState.reason}`,
    };
  }

  const sessionState = sessionStatus?.[currentSession];
  if (sessionState?.status === 'blocked') {
    return {
      action: 'skip', skip: 'session-blocked',
      detail: `${currentSession}: ${sessionState.reason}`,
    };
  }

  // Sentiment gate: optional, opt-in via sentimentGateMode. Disagreement
  // only triggers when both the FVG direction and sentiment label are
  // non-neutral; neutral and null fail-open (other gates still apply).
  const gateMode = sentimentGateMode || 'off';
  const sLabel = sentimentSnapshot?.label || null;
  const dir = pick.fvg.dir;
  const disagree =
    (dir === 'bull' && sLabel === 'bear') ||
    (dir === 'bear' && sLabel === 'bull');

  if (disagree && gateMode === 'live') {
    return {
      action: 'skip',
      skip: 'sentiment-disagree',
      detail: `${sLabel} sentiment vs ${dir} setup`,
      source: sentimentSnapshot.source,
    };
  }
  const shadowAttach = (gateMode === 'shadow' && disagree)
    ? { gate: 'sentiment', wouldSkip: true, label: sLabel, source: sentimentSnapshot.source }
    : null;

  // Tier selection:
  //   "best" = top-1 AND its distPct is meaningfully (>50%) better than #2
  //   "top2" = top-1 with no clear margin, or sole candidate
  let tier;
  if (sorted.length === 1) {
    tier = 'top2';
  } else if ((sorted[1].distPct - pick.distPct) / Math.max(pick.distPct, 1e-9) > TIER_MARGIN) {
    tier = 'best';
  } else {
    tier = 'top2';
  }
  const baseRiskPct = tier === 'best' ? riskTiers.best
                    : tier === 'top2' ? riskTiers.top2
                    :                   riskTiers.default;

  // Drift-gate risk downshifts compound multiplicatively — side, session,
  // and symbol-side all downshifted eighths the per-trade risk.
  let riskPct = baseRiskPct;
  const downshifts = [];
  if (sideState?.status === 'downshifted') {
    riskPct *= 0.5;
    downshifts.push({ source: 'side', key: sideKey, reason: sideState.reason });
  }
  if (sessionState?.status === 'downshifted') {
    riskPct *= 0.5;
    downshifts.push({ source: 'session', key: currentSession, reason: sessionState.reason });
  }
  const symSideState = symbolSideStatus?.[symSideKey(pick)];
  if (symSideState?.status === 'downshifted') {
    riskPct *= 0.5;
    downshifts.push({ source: 'symbol-side', key: symSideKey(pick), reason: symSideState.reason });
  }

  return {
    action: 'fire',
    pick, tier, baseRiskPct, riskPct,
    sideKey, sessionKey: currentSession,
    candidateCount: sorted.length,
    downshifts,
    ...(shadowAttach ? { shadow: shadowAttach } : {}),
  };
}
