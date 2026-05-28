// Pure restart-restore decision. On boot the trader holds persisted state
// (pendingOrder + positionContext) but the exchange is the source of truth.
// This decides what to re-adopt without any I/O, so the branching is testable.
//
// Closes the maker-fill-during-downtime gap: a limit order's positionContext
// only gains a posId once filled, so the old posId-only restore dropped a
// fill that landed while the trader was down. The position then resurfaced
// via orphan-adoption as source='manual-orphan' — excluded from drift gates,
// never max-hold closed, and post-mortem'd in the wrong bucket. Here we
// detect that fill from live positions and re-adopt it as a bot position
// with its full fire-time context intact.

const idEq = (a, b) => String(a) === String(b);

export function decideRestore({ persisted, openPositions = [], openOrders = [], now = Date.now() }) {
  const pc = persisted?.positionContext || null;
  const po = persisted?.pendingOrder || null;

  // Already-filled position: trust the persisted posId only if MEXC still holds it.
  if (pc?.posId) {
    const stillOpen = openPositions.some(p => idEq(p.positionId, pc.posId));
    return stillOpen
      ? { kind: 'position', positionContext: pc }
      : { kind: 'position-gone', posId: pc.posId, symbol: pc.symbol };
  }

  // Pending maker window: order was placed, fill state unknown at shutdown.
  if (po?.orderId != null) {
    const livePos = openPositions.find(p => p.symbol === po.symbol);
    if (livePos) {
      // Filled during downtime. Re-adopt with rich context rather than
      // letting orphan-adoption mislabel it. Without persisted context there
      // is nothing rich to restore — let the orphan path handle it.
      if (!pc) return { kind: 'pending-gone' };
      return {
        kind: 'pending-filled',
        positionContext: { ...pc, posId: livePos.positionId, filledAt: now },
      };
    }
    const stillResting = openOrders.some(o => idEq(o.orderId, po.orderId));
    if (stillResting) return { kind: 'pending-resting', pendingOrder: po, positionContext: pc };
    return { kind: 'pending-gone' };
  }

  return { kind: 'none' };
}
