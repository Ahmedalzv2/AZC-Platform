import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideRestore } from '../trader-restore.mjs';

const POS_CTX_FILLED = {
  symbol: 'SOL_USDT', dir: 'bull', side: 1, entry: 80.40, sl: 79.9, tp: 81.1,
  qty: 134, lev: 10, orderId: 'ord-1', posId: '139500', filledAt: 1_000,
};
const POS_CTX_PENDING = {
  symbol: 'SOL_USDT', dir: 'bull', side: 1, entry: 80.40, sl: 79.9, tp: 81.1,
  qty: 134, lev: 10, orderId: 'ord-1', openedAt: 1_000,
};
const PENDING = { symbol: 'SOL_USDT', orderId: 'ord-1', expiresAt: 2_000 };
const LIVE_POS = { positionId: '139500', symbol: 'SOL_USDT', holdAvgPrice: 80.4 };

describe('decideRestore — pure restart adoption', () => {
  it('returns none when nothing persisted', () => {
    assert.equal(decideRestore({ persisted: {} }).kind, 'none');
  });

  it('adopts a posId-backed position still open at the exchange', () => {
    const d = decideRestore({
      persisted: { positionContext: POS_CTX_FILLED },
      openPositions: [LIVE_POS],
    });
    assert.equal(d.kind, 'position');
    assert.equal(d.positionContext.posId, '139500');
  });

  it('drops a posId-backed position that is gone from the exchange', () => {
    const d = decideRestore({
      persisted: { positionContext: POS_CTX_FILLED },
      openPositions: [],
    });
    assert.equal(d.kind, 'position-gone');
    assert.equal(d.posId, '139500');
  });

  it('GAP: maker filled during downtime → re-adopt as bot position with posId + filledAt', () => {
    const d = decideRestore({
      persisted: { pendingOrder: PENDING, positionContext: POS_CTX_PENDING },
      openPositions: [LIVE_POS],
      openOrders: [],
      now: 5_000,
    });
    assert.equal(d.kind, 'pending-filled');
    assert.equal(d.positionContext.posId, '139500');
    assert.equal(d.positionContext.filledAt, 5_000);
    // rich fire-time context survives — not a manual orphan
    assert.equal(d.positionContext.entry, 80.40);
    assert.equal(d.positionContext.source, undefined);
  });

  it('resumes watching a maker order still resting unfilled', () => {
    const d = decideRestore({
      persisted: { pendingOrder: PENDING, positionContext: POS_CTX_PENDING },
      openPositions: [],
      openOrders: [{ orderId: 'ord-1', symbol: 'SOL_USDT' }],
    });
    assert.equal(d.kind, 'pending-resting');
    assert.equal(d.pendingOrder.orderId, 'ord-1');
    assert.equal(d.positionContext.orderId, 'ord-1');
  });

  it('drops a pending order that vanished with no fill', () => {
    const d = decideRestore({
      persisted: { pendingOrder: PENDING, positionContext: POS_CTX_PENDING },
      openPositions: [],
      openOrders: [],
    });
    assert.equal(d.kind, 'pending-gone');
  });

  it('matches orderId across number/string types', () => {
    const d = decideRestore({
      persisted: { pendingOrder: { ...PENDING, orderId: 12345 }, positionContext: { ...POS_CTX_PENDING, orderId: 12345 } },
      openPositions: [],
      openOrders: [{ orderId: '12345', symbol: 'SOL_USDT' }],
    });
    assert.equal(d.kind, 'pending-resting');
  });

  it('falls back to none when a fill is seen but no context was persisted', () => {
    const d = decideRestore({
      persisted: { pendingOrder: PENDING },
      openPositions: [LIVE_POS],
    });
    assert.equal(d.kind, 'pending-gone');
  });
});
