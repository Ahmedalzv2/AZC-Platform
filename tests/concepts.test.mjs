import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

const { app } = loadApp();

describe('ICT data invariants — these protect your trading rules from drift', () => {
  test('every asset has the same checks array length', () => {
    const lengths = [...app.ASSETS].map((a) => a.checks.length);
    const unique = [...new Set(lengths)];
    assert.equal(unique.length, 1, `assets disagree on checks length: ${JSON.stringify(lengths)}`);
  });

  test('CHECK_LABELS length matches asset checks length', () => {
    const checksLen = [...app.ASSETS][0].checks.length;
    assert.equal(app.CHECK_LABELS.length, checksLen);
  });

  // An asset with entry/sl/tp1 all zero is in the explicit "no active plan"
  // state — the dashboard shows WAITING PLAN and the user builds fresh
  // levels from the cockpit. The level-shape invariants only apply once
  // a plan exists.
  const hasPlan = (a) => Number(a.entry) > 0 || Number(a.sl) > 0 || Number(a.tp1 || a.tp) > 0;

  test('every asset with an active plan has entry, sl, and a TP', () => {
    for (const a of [...app.ASSETS]) {
      if (!hasPlan(a)) continue;
      assert.ok(a.entry > 0, `${a.symbol}: entry must be positive`);
      assert.ok(a.sl > 0, `${a.symbol}: sl must be positive`);
      assert.ok(a.tp1 > 0 || a.tp > 0, `${a.symbol}: needs tp1 or tp`);
    }
  });

  test('level geometry: SL and TP1 sit on opposite sides of entry (no malformed setups)', () => {
    // HTF bias is independent of setup direction — bias can be BEARISH while
    // the active setup is a counter-trend LONG bounce (e.g. BTC, ETH). The
    // invariant we *can* enforce is that SL and TP1 are never on the same
    // side of entry (which would be a broken/illogical setup).
    for (const a of [...app.ASSETS]) {
      if (!hasPlan(a)) continue;
      const tp = a.tp1 || a.tp;
      const slBelow = a.sl < a.entry;
      const tpAbove = tp > a.entry;
      const isLong = slBelow && tpAbove;
      const isShort = !slBelow && !tpAbove;
      assert.ok(
        isLong || isShort,
        `${a.symbol}: malformed levels — entry=${a.entry} sl=${a.sl} tp1=${tp} (SL and TP1 must be on opposite sides of entry)`,
      );
    }
  });

  test('TP and SL are at meaningfully different prices from entry', () => {
    for (const a of [...app.ASSETS]) {
      if (!hasPlan(a)) continue;
      const tp = a.tp1 || a.tp;
      assert.notEqual(a.sl, a.entry, `${a.symbol}: SL equals entry`);
      assert.notEqual(tp, a.entry, `${a.symbol}: TP1 equals entry`);
    }
  });

  test('grade is one of {a-plus, a, b}', () => {
    const allowed = new Set(['a-plus', 'a', 'b']);
    for (const a of [...app.ASSETS]) {
      assert.ok(allowed.has(a.grade), `${a.symbol}: unknown grade "${a.grade}"`);
    }
  });

  test('NON_BINANCE_ASSETS list every asset that lacks a Binance-pulled price', () => {
    // Sanity: GOLD/SILVER/US100 should be in the list per ICT AutoPilot rules.
    const nb = new Set([...app.NON_BINANCE_ASSETS]);
    assert.ok(nb.has('GOLD'));
    assert.ok(nb.has('SILVER'));
    assert.ok(nb.has('US100'));
  });

  test('OUTCOME_CHECKS are sorted ascending and reasonable', () => {
    const checks = [...app.OUTCOME_CHECKS];
    for (let i = 1; i < checks.length; i++) {
      assert.ok(checks[i] > checks[i - 1], `OUTCOME_CHECKS not sorted: ${checks.join(',')}`);
    }
    assert.ok(checks[0] >= 1, 'first check too soon');
    assert.ok(checks[checks.length - 1] <= 24 * 60, 'last check beyond a day');
  });

  test('Dead Zone window covers 19:00–22:00 GST (no-trade rule)', () => {
    const dz = [...app.SESSION_DEFS].find((s) => s.type === 'dead');
    assert.ok(dz, 'Dead Zone must exist');
    assert.equal(dz.startH, 19);
    assert.equal(dz.endH, 22);
  });
});
