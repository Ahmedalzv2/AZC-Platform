// Pure helper: build a positionContext from an open MEXC position the
// trader didn't fire (i.e. an orphan — opened by Force Fire, Stage @
// FVG, or a direct exchange click). Adoption lets the bot monitor close
// and write a post-mortem under trade-learnings/manual/{wins,losses,be}/
// without polluting its auto-drift gates.
//
// Returns null when the inputs aren't usable. Caller is responsible for
// fetching the MEXC position, plan-order list, and contract meta — this
// stays pure for unit tests.

// A posId the trader already reconciled-closed must never be re-adopted.
// MEXC's open_positions endpoint flaps a closing position in and out of the
// list for up to a few minutes after the stop fills; without this guard the
// main loop closes the position, falls straight through to tryAdoptOrphan in
// the same cycle, sees the flapped-back posId, and re-adopts it — re-booking
// the same loss every cycle. Posids are unique per position, so blocking a
// recently-closed one for an hour can never reject a legitimate new trade.
export function isReadoptBlocked(posId, closedPosIds, now = Date.now(), ttlMs = 3_600_000) {
  if (!posId || !closedPosIds || typeof closedPosIds.get !== 'function') return false;
  const ts = Number(closedPosIds.get(String(posId)));
  return Number.isFinite(ts) && (now - ts) < ttlMs;
}

export function buildOrphanContext({ pos, planOrders, contractMeta, now = Date.now() }) {
  if (!pos || !pos.positionId) return null;

  const dir = pos.positionType === 1 ? 'bull'
            : pos.positionType === 2 ? 'bear'
            : null;
  if (!dir) return null;

  const entry = Number(pos.holdAvgPrice ?? pos.openAvgPrice);
  const qty   = Number(pos.holdVol);
  const lev   = Number(pos.leverage);
  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (!Number.isFinite(qty)   || qty   <= 0) return null;

  const { sl, tp } = pickActivePlanLevels({ planOrders, positionId: pos.positionId });

  const contractSize = Number(contractMeta?.contractSize);
  return {
    symbol: pos.symbol,
    dir,
    side: dir === 'bull' ? 1 : 3,
    entry,
    sl, tp,
    qty,
    lev: Number.isFinite(lev) && lev > 0 ? lev : null,
    contractSize: Number.isFinite(contractSize) && contractSize > 0 ? contractSize : 1,
    posId: String(pos.positionId),
    // filledAt anchored at adoption — older MEXC fields are unreliable on
    // the open_positions response. Max-hold check is gated separately so
    // an orphan never gets force-closed by the bot.
    filledAt: now,
    openedAt: now,
    meta: contractMeta || null,
    source: 'manual-orphan',
    orderId: null, htfDir: null, tier: null, riskPct: null,
    priceAtCall: null, distPct: null, fvgBody: null, fvgBodyPct: null,
    fvgFormedAt: null, session: null, sentiment: null,
  };
}

function pickActivePlanLevels({ planOrders, positionId }) {
  if (!Array.isArray(planOrders) || !planOrders.length) return { sl: null, tp: null };
  const active = planOrders.find(p => {
    if (String(p.positionId || '') !== String(positionId)) return false;
    return p.state === 1 || p.isFinished === 0;
  });
  if (!active) return { sl: null, tp: null };
  const slP = Number(active.stopLossPrice);
  const tpP = Number(active.takeProfitPrice);
  return {
    sl: Number.isFinite(slP) && slP > 0 ? slP : null,
    tp: Number.isFinite(tpP) && tpP > 0 ? tpP : null,
  };
}
