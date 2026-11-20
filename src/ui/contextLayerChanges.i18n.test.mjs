// The blocked-visibility toast reason in the UI language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/index.js';
import {
  _handleContextLayerChange,
  localizeVisibilityBlockReason,
} from './contextLayerChanges.js';

function fakeShell() {
  const toasts = [];
  return {
    destroyed: false,
    _userFacingContextNotificationTokens: new Set(),
    _contextSessionSnapshot: null,
    _contextModeChanging: false,
    _contextMode: null,
    _contextModeEntering: null,
    _syncContextModeButtons() {},
    showToast(message) {
      toasts.push(message);
    },
    toasts,
  };
}

test.afterEach(() => setLocale('en'));

test('en: the toast shows the reason unchanged', () => {
  setLocale('en');
  const shell = fakeShell();
  _handleContextLayerChange.call(shell, {
    type: 'visibility-blocked',
    layerId: 'street-level',
    enabled: true,
    origin: 'user',
    reason: 'Data source unavailable',
  });
  assert.deepEqual(shell.toasts, ['Data source unavailable']);
  assert.equal(
    localizeVisibilityBlockReason('Overpass returned HTTP 503'),
    'Overpass returned HTTP 503',
  );
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: a known lifecycle reason is looked up in the catalog`, () => {
    setLocale(locale);
    const shell = fakeShell();
    shell._contextMode = null;
    _handleContextLayerChange.call(shell, {
      type: 'visibility-blocked',
      layerId: 'street-level',
      enabled: true,
      origin: 'user',
      reason: 'Data source unavailable',
    });
    assert.equal(shell.toasts.length, 1);
    assert.notEqual(shell.toasts[0], 'Data source unavailable');
  });

  test(`${locale}: an unknown provider message passes through verbatim`, () => {
    setLocale(locale);
    assert.equal(
      localizeVisibilityBlockReason('Overpass returned HTTP 503'),
      'Overpass returned HTTP 503',
    );
  });
}
