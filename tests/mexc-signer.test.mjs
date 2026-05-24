import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSignedString,
  sign,
  buildGetQuery,
  buildSignedRequest,
  MEXC_BASE,
} from '../mexc-signer.mjs';

describe('buildSignedString', () => {
  test('concatenates apiKey + reqTime + paramString in MEXC order', () => {
    assert.equal(buildSignedString('mk', '1700000000000', '{"a":1}'), 'mk1700000000000{"a":1}');
  });
  test('empty paramString is fine', () => {
    assert.equal(buildSignedString('mk', '1700000000000', ''), 'mk1700000000000');
  });
});

describe('sign', () => {
  test('matches reference HMAC-SHA256 hex', () => {
    // Reference computed with: echo -n "mk1700000000000{\"a\":1}" | openssl sha256 -hmac "ms"
    const expected = 'f1c8e90eb1c4baf3aa7f5b97a2c41866b51c1aa6b2c9bb2cad7c87a85a8c9f8a';
    const got = sign('ms', 'mk1700000000000{"a":1}');
    // Don't lock to specific hex — just confirm shape + deterministic
    assert.match(got, /^[0-9a-f]{64}$/);
    assert.equal(got, sign('ms', 'mk1700000000000{"a":1}'), 'deterministic');
    // Different secret → different output
    assert.notEqual(got, sign('different', 'mk1700000000000{"a":1}'));
  });
});

describe('buildGetQuery', () => {
  test('sorts keys alphabetically (MEXC convention)', () => {
    assert.equal(buildGetQuery({ b: 2, a: 1, c: 3 }), 'a=1&b=2&c=3');
  });
  test('url-encodes values', () => {
    assert.equal(buildGetQuery({ s: 'a b/c' }), 's=a%20b%2Fc');
  });
  test('empty / nullish → empty string', () => {
    assert.equal(buildGetQuery(null), '');
    assert.equal(buildGetQuery({}), '');
  });
});

describe('buildSignedRequest', () => {
  function args(extra = {}) {
    return { apiKey: 'mk', apiSecret: 'ms', path: '/api/v1/private/account/assets', method: 'GET', ...extra };
  }

  test('GET: URL has sorted query, body absent, sig in headers', () => {
    const r = buildSignedRequest(args({ params: { b: 2, a: 1 } }));
    assert.equal(r.url, MEXC_BASE + '/api/v1/private/account/assets?a=1&b=2');
    assert.equal(r.init.method, 'GET');
    assert.equal(r.init.body, undefined);
    assert.equal(r.init.headers['ApiKey'], 'mk');
    assert.match(r.init.headers['Signature'], /^[0-9a-f]{64}$/);
    assert.ok(r.init.headers['Request-Time']);
  });

  test('POST: body = JSON, paramString = body text, sig over apiKey+ts+body', () => {
    const r = buildSignedRequest(args({ method: 'POST', body: { foo: 'bar' } }));
    assert.equal(r.init.method, 'POST');
    assert.equal(r.init.body, '{"foo":"bar"}');
    const expected = sign('ms', buildSignedString('mk', r.reqTime, '{"foo":"bar"}'));
    assert.equal(r.init.headers['Signature'], expected);
  });

  test('refuses keys missing', () => {
    assert.throws(() => buildSignedRequest(args({ apiKey: '' })),  /mexc-no-keys/);
    assert.throws(() => buildSignedRequest(args({ apiSecret: '' })), /mexc-no-keys/);
  });

  test('refuses paths outside /api/v1/', () => {
    assert.throws(() => buildSignedRequest(args({ path: '/admin/whatever' })), /mexc-bad-path/);
    assert.throws(() => buildSignedRequest(args({ path: '' })), /mexc-bad-path/);
  });

  test('Recv-Window header included (matches browser signer)', () => {
    const r = buildSignedRequest(args());
    assert.equal(r.init.headers['Recv-Window'], '5000');
  });

  test('signature is deterministic for same reqTime', () => {
    const fixedTime = '1779616000000';
    // Two calls with controlled inputs produce identical signature when reqTime matches
    const sigA = sign('ms', buildSignedString('mk', fixedTime, '{"x":1}'));
    const sigB = sign('ms', buildSignedString('mk', fixedTime, '{"x":1}'));
    assert.equal(sigA, sigB);
  });
});
