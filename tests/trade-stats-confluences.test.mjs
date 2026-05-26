import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLearningFile } from '../trade-stats.mjs';

const sampleBody = (line) => [
  '# X_USDT LONG — LOSS',
  '',
  '- Fired: 2026-05-26T00:00:00.000Z',
  '- Outcome: LOSS',
  '- Realised: -0.0500 USD -1.00R',
  '- Session: asia',
  '- Grade: top2',
  '- Bias: bear',
  line,
  '',
].join('\n');

describe('parseLearningFile confluence extraction', () => {
  it('extracts fvg-body and fvg-dist from the confluences line', () => {
    const body = sampleBody('- Confluences: htf-agree:bear, tier:top2, kz:asia, fvg-body:0.12%, fvg-dist:0.051%');
    const t = parseLearningFile('2026-05-26-0000-X_USDT-SHORT.md', body);
    assert.ok(Math.abs(t.fvgBodyPct - 0.0012) < 1e-12);
    assert.ok(Math.abs(t.fvgDistPct - 0.00051) < 1e-12);
  });

  it('returns null for missing confluence values', () => {
    const body = sampleBody('- Confluences: htf-agree:bear');
    const t = parseLearningFile('2026-05-26-0000-X_USDT-SHORT.md', body);
    assert.equal(t.fvgBodyPct, null);
    assert.equal(t.fvgDistPct, null);
  });

  it('returns null when there is no confluences line at all', () => {
    const body = [
      '# X_USDT LONG — LOSS',
      '- Outcome: LOSS',
      '- Realised: -0.05 USD -1.00R',
    ].join('\n');
    const t = parseLearningFile('2026-05-26-0000-X_USDT-SHORT.md', body);
    assert.equal(t.fvgBodyPct, null);
  });
});
