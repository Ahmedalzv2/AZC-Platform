import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('_refreshLiveTradingModalIfOpen — 1s diag refresh', () => {
  function fakeModalIsOpen(sandbox) {
    // Simulate the modal being in the DOM.
    sandbox.document.getElementById = (id) => {
      if (id === 'liveTradingModal') return { id };
      return null;
    };
  }
  function fakeModalIsClosed(sandbox) {
    sandbox.document.getElementById = () => null;
  }

  test('no-ops when the modal is not in the DOM', () => {
    const { app, sandbox } = loadApp();
    fakeModalIsClosed(sandbox);
    let renderedTimes = 0;
    sandbox.openLiveTradingModal = () => { renderedTimes++; };
    app._refreshLiveTradingModalIfOpen();
    assert.equal(renderedTimes, 0, 'should skip when modal closed');
  });

  test('skips re-render when an INPUT is focused (avoids stealing typing)', () => {
    const { app, sandbox } = loadApp();
    fakeModalIsOpen(sandbox);
    let renderedTimes = 0;
    sandbox.openLiveTradingModal = () => { renderedTimes++; };
    sandbox.document.activeElement = { tagName: 'INPUT' };
    app._refreshLiveTradingModalIfOpen();
    assert.equal(renderedTimes, 0, 'INPUT focus blocks re-render');
  });

  test('skips re-render when a SELECT is focused (preserves dropdown interaction)', () => {
    const { app, sandbox } = loadApp();
    fakeModalIsOpen(sandbox);
    let renderedTimes = 0;
    sandbox.openLiveTradingModal = () => { renderedTimes++; };
    sandbox.document.activeElement = { tagName: 'SELECT' };
    app._refreshLiveTradingModalIfOpen();
    assert.equal(renderedTimes, 0, 'SELECT focus blocks re-render');
  });

  test('skips re-render when a TEXTAREA is focused', () => {
    const { app, sandbox } = loadApp();
    fakeModalIsOpen(sandbox);
    let renderedTimes = 0;
    sandbox.openLiveTradingModal = () => { renderedTimes++; };
    sandbox.document.activeElement = { tagName: 'TEXTAREA' };
    app._refreshLiveTradingModalIfOpen();
    assert.equal(renderedTimes, 0);
  });

  test('re-renders when modal is open AND nothing is focused', () => {
    const { app, sandbox } = loadApp();
    fakeModalIsOpen(sandbox);
    let renderedTimes = 0;
    sandbox.openLiveTradingModal = () => { renderedTimes++; };
    sandbox.document.activeElement = null;
    app._refreshLiveTradingModalIfOpen();
    assert.equal(renderedTimes, 1);
  });

  test('re-renders when modal is open AND a non-form element is focused (e.g. BODY)', () => {
    const { app, sandbox } = loadApp();
    fakeModalIsOpen(sandbox);
    let renderedTimes = 0;
    sandbox.openLiveTradingModal = () => { renderedTimes++; };
    sandbox.document.activeElement = { tagName: 'BODY' };
    app._refreshLiveTradingModalIfOpen();
    assert.equal(renderedTimes, 1, 'BODY focus is the default, should refresh');
  });
});
