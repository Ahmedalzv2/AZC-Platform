import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { eqConstTime, authedWriteWith } from '../relay-auth.mjs';

describe('eqConstTime', () => {
  test('equal strings → true', () => assert.equal(eqConstTime('abc', 'abc'), true));
  test('different lengths → false (without compare)', () => assert.equal(eqConstTime('ab', 'abc'), false));
  test('same length, different content → false', () => assert.equal(eqConstTime('abc', 'abd'), false));
  test('null + empty → equal (zero-length both)', () => assert.equal(eqConstTime(null, ''), true));
  test('null vs string → false', () => assert.equal(eqConstTime(null, 'x'), false));
});

describe('authedWriteWith', () => {
  function reqWith(headers = {}) { return { headers }; }

  test('no token configured → pass-through (legacy mode)', () => {
    assert.equal(authedWriteWith('', reqWith()), true);
    assert.equal(authedWriteWith('', reqWith({ 'x-ict-token': 'anything' })), true);
    assert.equal(authedWriteWith(null, reqWith()), true);
  });

  test('token configured + correct header → true', () => {
    assert.equal(authedWriteWith('s3cret', reqWith({ 'x-ict-token': 's3cret' })), true);
  });

  test('token configured + missing header → false', () => {
    assert.equal(authedWriteWith('s3cret', reqWith()), false);
  });

  test('token configured + wrong header → false', () => {
    assert.equal(authedWriteWith('s3cret', reqWith({ 'x-ict-token': 'wrong' })), false);
  });

  test('case-sensitive header key fallback (X-ICT-Token uppercase)', () => {
    // Node's http normalises to lowercase, but support both for robustness
    assert.equal(authedWriteWith('s3cret', reqWith({ 'X-ICT-Token': 's3cret' })), true);
  });

  test('falsy req or req.headers → false (defensive)', () => {
    assert.equal(authedWriteWith('s3cret', null), false);
    assert.equal(authedWriteWith('s3cret', {}), false);
  });
});
