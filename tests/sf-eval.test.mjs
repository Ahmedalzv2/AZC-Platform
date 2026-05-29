import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnlyMode, buildEvalPayload, redactCreds, READ_ONLY_MODES } from '../sf-eval.mjs';

describe('assertReadOnlyMode — the hard guard against trading', () => {
  test('allows read-only/instant modes', () => {
    for (const m of ['check_api_active', 'accountinfo', 'accountbalance', 'positions_snapshot', 'market_ticker', 'fetch_pnl']) {
      assert.doesNotThrow(() => assertReadOnlyMode(m), `${m} should be allowed`);
    }
  });

  test('throws on state-changing modes (set_leverage, set_marginmode, set_hedgemode, cancel_order)', () => {
    for (const m of ['set_leverage', 'set_marginmode', 'set_hedgemode', 'cancel_order']) {
      assert.throws(() => assertReadOnlyMode(m), /not read-only|not allowed/i, `${m} must be rejected`);
    }
  });

  test('throws on anything unknown or trade-like, and on missing mode', () => {
    for (const m of ['place_order', 'trade', 'buy', undefined, '', null]) {
      assert.throws(() => assertReadOnlyMode(m));
    }
  });
});

describe('buildEvalPayload — never carries trade fields', () => {
  const creds = { api_key: 'K', api_secret: 'S', passphrase: 'P' };

  test('includes exchange/mode/creds and defaults encryptor to "2"', () => {
    const p = buildEvalPayload({ exchange: 'bybit', mode: 'accountinfo', ...creds });
    assert.equal(p.exchange, 'bybit');
    assert.equal(p.mode, 'accountinfo');
    assert.equal(p.api_key, 'K');
    assert.equal(p.api_secret, 'S');
    assert.equal(p.secret_key, 'S');      // mirror, per webhook contract
    assert.equal(p.passphrase, 'P');
    assert.equal(p.encryptor, '2');
  });

  test('payload has NO trade/sizing/leverage keys', () => {
    const p = buildEvalPayload({ exchange: 'bybit', mode: 'positions_snapshot', ...creds });
    for (const forbidden of ['position', 'qty', 'qty_in_percentage', 'buy_leverage', 'sell_leverage', 'margin_mode', 'force_tp']) {
      assert.equal(p[forbidden], undefined, `must not contain ${forbidden}`);
    }
  });

  test('rejects a non-read-only mode before building anything', () => {
    assert.throws(() => buildEvalPayload({ exchange: 'bybit', mode: 'set_leverage', ...creds }));
  });
});

describe('redactCreds — never surface secrets', () => {
  test('masks every credential field, keeps the rest', () => {
    const r = redactCreds({ exchange: 'bybit', mode: 'accountinfo', api_key: 'AKIA123', api_secret: 'sec', secret_key: 'sec', passphrase: 'pp', success: true });
    assert.equal(r.api_key, '***redacted***');
    assert.equal(r.api_secret, '***redacted***');
    assert.equal(r.secret_key, '***redacted***');
    assert.equal(r.passphrase, '***redacted***');
    assert.equal(r.exchange, 'bybit');
    assert.equal(r.mode, 'accountinfo');
    assert.equal(r.success, true);
  });

  test('leaves absent/empty credential fields untouched (no fake masks)', () => {
    const r = redactCreds({ exchange: 'bybit', passphrase: '' });
    assert.equal(r.passphrase, '');
    assert.equal('api_key' in r, false);
  });

  test('READ_ONLY_MODES excludes every state-changing mode', () => {
    for (const m of ['set_leverage', 'set_marginmode', 'set_hedgemode', 'cancel_order']) {
      assert.equal(READ_ONLY_MODES.includes(m), false);
    }
  });
});
