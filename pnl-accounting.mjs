// Pure P/L accounting: gross +/- trading fees +/- funding cost over the
// hold window. MEXC futures specifics:
//   - Trading fee model: taker pays ~0.02% (some pairs are zero-fee
//     promo); maker may receive a small rebate (-0.005%).
//   - Funding: charged every 8 hours at 00:00 / 08:00 / 16:00 UTC. If a
//     position is open at any funding timestamp, notional × funding rate
//     is charged (or paid, depending on rate sign).
//
// Defaults assume MEXC's "zero-fee futures" promo (most USDT-margined
// pairs are 0% maker + 0% taker right now). Funding default = 0.01% per
// 8h — a conservative typical-case cost; real rate varies by pair and
// is queryable but we keep this a static config so the post-mortem
// renders predictably. Override via the localStorage key
// `ict_mexc_fees` = JSON with any of {taker, maker, fundingPct8h}.
//
// All percentages are decimal fractions: 0.0002 = 0.02%.

export const MEXC_FEE_DEFAULTS = Object.freeze({
  taker:        0,        // zero-fee promo. Real rate currently 0.0002 if not promo'd.
  maker:        0,        // ditto. Some pairs pay a small rebate (-0.00005).
  fundingPct8h: 0.0001,   // 0.01% per 8h window held.
});

const FUNDING_WINDOW_MS = 8 * 60 * 60 * 1000;

// Number of MEXC funding boundaries (00/08/16 UTC) the hold crossed. A
// position opened at 07:55 and closed at 08:05 crosses 1 window (the
// 08:00 boundary) → charged once. Same hold opened at 08:05 closed at
// 08:15 crosses 0 windows → no funding.
export function fundingWindowsCrossed(openMs, closeMs) {
  const o = Math.floor(Number(openMs) / FUNDING_WINDOW_MS);
  const c = Math.floor(Number(closeMs) / FUNDING_WINDOW_MS);
  return Math.max(0, c - o);
}

export function mexcFeeConfig(overrideJson) {
  let over = null;
  try { over = overrideJson ? JSON.parse(overrideJson) : null; } catch (e) {}
  return { ...MEXC_FEE_DEFAULTS, ...(over || {}) };
}

// Pure: gross + fees + funding → net realised USD.
//
// fees are signed (positive = cost; negative = rebate). funding is per-
// window applied at notionalOpen × rate × windowsCrossed.
//
// Returns:
//   grossUsd       — directional P/L only (exit-entry)*qty*signSide
//   feeUsdOpen     — fee at fill, signed
//   feeUsdClose    — fee at exit,  signed
//   fundingUsd     — total funding paid (always >=0 with default config)
//   holdMs         — closeTs - openTs (informational)
//   windowsCrossed — funding windows (for transparency)
//   netUsd         — gross - openFee - closeFee - funding
export function computeRealizedNet({
  side, entry, exit, qty,
  openTs, closeTs,
  feePctOpen,  feePctClose,
  fundingPct8h,
}) {
  const s = String(side || '').toLowerCase();
  const dir = s === 'short' ? -1 : 1; // long or anything else → long
  const e  = Number(entry), x = Number(exit), q = Number(qty);
  if (!Number.isFinite(e) || !Number.isFinite(x) || !Number.isFinite(q) || q <= 0) {
    return { grossUsd: 0, feeUsdOpen: 0, feeUsdClose: 0, fundingUsd: 0, holdMs: 0, windowsCrossed: 0, netUsd: 0 };
  }
  const grossUsd     = dir * (x - e) * q;
  const notionalOpen = e * q;
  const notionalClose= x * q;
  const feeUsdOpen   = notionalOpen  * (Number(feePctOpen)  || 0);
  const feeUsdClose  = notionalClose * (Number(feePctClose) || 0);
  const o = Number(openTs), c = Number(closeTs);
  const holdMs       = Number.isFinite(o) && Number.isFinite(c) ? Math.max(0, c - o) : 0;
  const windowsCrossed = (Number.isFinite(o) && Number.isFinite(c)) ? fundingWindowsCrossed(o, c) : 0;
  const fundingUsd   = windowsCrossed * notionalOpen * (Number(fundingPct8h) || 0);
  const netUsd       = grossUsd - feeUsdOpen - feeUsdClose - fundingUsd;
  return { grossUsd, feeUsdOpen, feeUsdClose, fundingUsd, holdMs, windowsCrossed, netUsd };
}
