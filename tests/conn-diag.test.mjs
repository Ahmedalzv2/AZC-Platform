import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('_classifyConnTest — surface the right fix hint in the modal', () => {
  test('null result (never tested) → "not run"', () => {
    const { app } = loadApp();
    const c = app._classifyConnTest(null);
    assert.equal(c.label, 'not run');
  });

  test('ok:true → green checkmark', () => {
    const { app } = loadApp();
    const c = app._classifyConnTest({ ok: true, status: 200 });
    assert.match(c.label, /OK/);
    assert.equal(c.color, 'var(--bull)');
  });

  test('no-keys → tells user to paste keys', () => {
    const { app } = loadApp();
    const c = app._classifyConnTest({ ok: false, error: 'no-keys' });
    assert.match(c.label, /no keys/);
    assert.match(c.hint, /paste/i);
  });

  test('no-worker → tells user to paste Worker URL', () => {
    const { app } = loadApp();
    const c = app._classifyConnTest({ ok: false, error: 'no-worker' });
    assert.match(c.label, /no worker/);
    assert.match(c.hint, /Worker URL/i);
  });

  test('MEXC code 10007 (no permission) → tells user to enable Contract Trade', () => {
    const { app } = loadApp();
    const c = app._classifyConnTest({
      ok: false, status: 400,
      response: { code: 10007, msg: 'Signature for this request is not valid' },
    });
    assert.match(c.label, /10007/);
    assert.match(c.hint, /Contract Trade/i);
  });

  test('MEXC code 700002 (signature mismatch) → key/secret pairing hint', () => {
    const { app } = loadApp();
    const c = app._classifyConnTest({
      ok: false, status: 400,
      response: { code: 700002, msg: 'Signature error' },
    });
    assert.match(c.label, /700002/);
    assert.match(c.hint, /signature/i);
    assert.match(c.hint, /paste|disconnect/i);
  });

  test('MEXC code 30004 (IP whitelist) → tells user to disable IP whitelist', () => {
    const { app } = loadApp();
    const c = app._classifyConnTest({
      ok: false, status: 400,
      response: { code: 30004, msg: 'IP not allowed' },
    });
    assert.match(c.hint, /IP/);
    assert.match(c.hint, /disable|whitelist/i);
  });

  test('HTTP 401 with unknown code → defaults to IP whitelist hint (most common cause)', () => {
    const { app } = loadApp();
    const c = app._classifyConnTest({ ok: false, status: 401, response: { msg: 'Unauthorized' } });
    assert.match(c.label, /401/);
    assert.match(c.hint, /IP whitelist|Contract Trade/i);
  });

  test('HTTP 403 → same fallback as 401', () => {
    const { app } = loadApp();
    const c = app._classifyConnTest({ ok: false, status: 403, response: {} });
    assert.match(c.hint, /IP whitelist|Contract Trade/i);
  });

  test('Unknown failure shape → graceful fallback hint, no crash', () => {
    const { app } = loadApp();
    const c = app._classifyConnTest({ ok: false, status: 500, response: {} });
    assert.match(c.label, /500/);
    assert.ok(c.hint.length > 0, 'fallback hint should not be empty');
  });

  test('network error → suggests verifying Worker URL is reachable', () => {
    const { app } = loadApp();
    const c = app._classifyConnTest({ ok: false, error: 'network', detail: 'fetch failed' });
    assert.match(c.label, /network/);
    assert.match(c.hint, /Worker|reachable/i);
  });

  test('_MEXC_FIX_HINTS catalogues the codes we have specific fixes for', () => {
    const { app } = loadApp();
    // Spot-check: keep this in sync with the production map so the test
    // catches a missing hint when a new code is added.
    assert.ok(app._MEXC_FIX_HINTS[10007]);
    assert.ok(app._MEXC_FIX_HINTS[700002]);
    assert.ok(app._MEXC_FIX_HINTS[30004]);
  });
});
