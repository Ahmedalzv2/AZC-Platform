import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrphanContext } from '../trader-orphan.mjs';

const SOL_POS = {
  positionId: '1395669999',
  symbol: 'SOL_USDT',
  positionType: 1,        // 1 = long, 2 = short (MEXC contract v1)
  holdAvgPrice: 80.40,
  holdVol: 134,
  leverage: 10,
};
const SOL_META = { contractSize: 0.1, priceUnit: 0.01, minVol: 1 };

describe('buildOrphanContext — pure helper', () => {
  it('returns null when pos is missing', () => {
    assert.equal(buildOrphanContext({ pos: null, planOrders: [], contractMeta: SOL_META }), null);
  });

  it('returns null when positionId is missing', () => {
    assert.equal(buildOrphanContext({ pos: { symbol: 'SOL_USDT' }, planOrders: [], contractMeta: SOL_META }), null);
  });

  it('returns null when positionType is unknown', () => {
    assert.equal(buildOrphanContext({ pos: { ...SOL_POS, positionType: 9 }, planOrders: [], contractMeta: SOL_META }), null);
  });

  it('returns null when entry price is invalid', () => {
    assert.equal(buildOrphanContext({ pos: { ...SOL_POS, holdAvgPrice: 0 }, planOrders: [], contractMeta: SOL_META }), null);
  });

  it('returns null when holdVol is invalid', () => {
    assert.equal(buildOrphanContext({ pos: { ...SOL_POS, holdVol: 0 }, planOrders: [], contractMeta: SOL_META }), null);
  });

  it('maps positionType=1 → bull / side=1', () => {
    const ctx = buildOrphanContext({ pos: SOL_POS, planOrders: [], contractMeta: SOL_META });
    assert.equal(ctx.dir, 'bull');
    assert.equal(ctx.side, 1);
  });

  it('maps positionType=2 → bear / side=3', () => {
    const ctx = buildOrphanContext({ pos: { ...SOL_POS, positionType: 2 }, planOrders: [], contractMeta: SOL_META });
    assert.equal(ctx.dir, 'bear');
    assert.equal(ctx.side, 3);
  });

  it('tags source=manual-orphan so the close path can branch', () => {
    const ctx = buildOrphanContext({ pos: SOL_POS, planOrders: [], contractMeta: SOL_META });
    assert.equal(ctx.source, 'manual-orphan');
  });

  it('carries through entry/qty/lev/contractSize from MEXC + meta', () => {
    const ctx = buildOrphanContext({ pos: SOL_POS, planOrders: [], contractMeta: SOL_META });
    assert.equal(ctx.entry, 80.40);
    assert.equal(ctx.qty, 134);
    assert.equal(ctx.lev, 10);
    assert.equal(ctx.contractSize, 0.1);
  });

  it('defaults contractSize to 1 when meta is missing or invalid', () => {
    const ctx = buildOrphanContext({ pos: SOL_POS, planOrders: [], contractMeta: null });
    assert.equal(ctx.contractSize, 1);
  });

  it('sl/tp are null when no plan orders are attached', () => {
    const ctx = buildOrphanContext({ pos: SOL_POS, planOrders: [], contractMeta: SOL_META });
    assert.equal(ctx.sl, null);
    assert.equal(ctx.tp, null);
  });

  it('pulls sl/tp from the active plan tied to this positionId', () => {
    const planOrders = [
      { positionId: '1395669999', state: 1, stopLossPrice: 80.56, takeProfitPrice: 80.11 },
    ];
    const ctx = buildOrphanContext({ pos: SOL_POS, planOrders, contractMeta: SOL_META });
    assert.equal(ctx.sl, 80.56);
    assert.equal(ctx.tp, 80.11);
  });

  it('ignores plan orders for a different positionId', () => {
    const planOrders = [
      { positionId: 'unrelated', state: 1, stopLossPrice: 99, takeProfitPrice: 100 },
    ];
    const ctx = buildOrphanContext({ pos: SOL_POS, planOrders, contractMeta: SOL_META });
    assert.equal(ctx.sl, null);
    assert.equal(ctx.tp, null);
  });

  it('ignores already-triggered plan orders (state != 1 and isFinished != 0)', () => {
    const planOrders = [
      { positionId: '1395669999', state: 3, stopLossPrice: 80.56, takeProfitPrice: 80.11 },
    ];
    const ctx = buildOrphanContext({ pos: SOL_POS, planOrders, contractMeta: SOL_META });
    assert.equal(ctx.sl, null);
    assert.equal(ctx.tp, null);
  });

  it('accepts plans where isFinished=0 even without explicit state field', () => {
    const planOrders = [
      { positionId: '1395669999', isFinished: 0, stopLossPrice: 80.56, takeProfitPrice: 80.11 },
    ];
    const ctx = buildOrphanContext({ pos: SOL_POS, planOrders, contractMeta: SOL_META });
    assert.equal(ctx.sl, 80.56);
    assert.equal(ctx.tp, 80.11);
  });

  it('filledAt + openedAt anchor at adoption time (now), not MEXC create time', () => {
    const now = 1_700_000_000_000;
    const ctx = buildOrphanContext({ pos: SOL_POS, planOrders: [], contractMeta: SOL_META, now });
    assert.equal(ctx.filledAt, now);
    assert.equal(ctx.openedAt, now);
  });
});
