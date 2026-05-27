// Shared live-sizing helper.
//
// Why this exists:
// - The live trader and the backtest both need the same qty math.
// - A previous bug let qty fall through to minVol even when free margin
//   could not support the smallest tradable order, which created doomed
//   exchange submits (`Balance insufficient`) instead of a clean local skip.
// - Margin must be checked against the actual entry price, not the last
//   ticker price, because POST_ONLY orders reserve against the resting limit.

export function sizeTradeByRiskAndMargin({
  balance,
  riskPct,
  leverage,
  entry,
  stopDistUsdPerContract,
  contractSize,
  minVol,
  marginReservePct = 0.5,
}) {
  const bal = Number(balance);
  const risk = Number(riskPct);
  const lev = Number(leverage);
  const px = Number(entry);
  const stopUsd = Number(stopDistUsdPerContract);
  const cSize = Number(contractSize);
  const min = Number(minVol);
  const reserve = Number(marginReservePct);

  if (!Number.isFinite(bal) || bal <= 0) {
    return { qty: 0, riskUsd: 0, maxQtyByMargin: 0, reason: 'no-balance' };
  }
  if (!Number.isFinite(risk) || risk <= 0 || !Number.isFinite(stopUsd) || stopUsd <= 0) {
    return { qty: 0, riskUsd: 0, maxQtyByMargin: 0, reason: 'bad-risk-input' };
  }
  if (!Number.isFinite(lev) || lev <= 0 || !Number.isFinite(px) || px <= 0 || !Number.isFinite(cSize) || cSize <= 0) {
    return { qty: 0, riskUsd: bal * risk, maxQtyByMargin: 0, reason: 'bad-margin-input' };
  }
  if (!Number.isFinite(min) || min <= 0) {
    return { qty: 0, riskUsd: bal * risk, maxQtyByMargin: 0, reason: 'bad-min-vol' };
  }

  const riskUsd = bal * risk;
  let qty = Math.floor(riskUsd / stopUsd);
  const maxQtyByMargin = Math.floor((bal * reserve * lev) / (cSize * px));

  if (!Number.isFinite(maxQtyByMargin) || maxQtyByMargin < min) {
    return { qty: 0, riskUsd, maxQtyByMargin: Math.max(0, maxQtyByMargin || 0), reason: 'margin-too-low' };
  }

  if (qty < min) qty = min;
  if (qty > maxQtyByMargin) qty = maxQtyByMargin;

  return {
    qty,
    riskUsd,
    maxQtyByMargin,
    notional: qty * cSize * px,
    reason: null,
  };
}