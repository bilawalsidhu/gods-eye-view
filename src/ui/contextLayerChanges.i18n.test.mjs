// The blocked-visibility toast reason in the UI language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/index.js';
import {
  contextLayerEnableBlockReason,
  parseContextLayerBlockReason,
} from '../contextModePolicy.js';
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
    _contextMode: 'space-missions',
    _contextModeEntering: null,
    _syncContextModeButtons() {},
    showToast(message) {
      toasts.push(message);
    },
    toasts,
  };
}

const ENGLISH_GUARD =
  'Space Missions isolates replay data. Exit the mode to enable Live Flights.';

test.afterEach(() => setLocale('en'));

test('the guard reason is English data and parses back to its layer name', () => {
  const reason = contextLayerEnableBlockReason({
    contextMode: 'space-missions',
    change: { layerId: 'flights', enabled: true, origin: 'user' },
    layerName: 'Live Flights',
  });
  assert.equal(reason, ENGLISH_GUARD);
  assert.deepEqual(parseContextLayerBlockReason(reason), {
    layer: 'Live Flights',
  });
  assert.equal(parseContextLayerBlockReason('Data source unavailable'), null);
  assert.equal(
    parseContextLayerBlockReason(
      'Space Missions isolates replay data. Exit the mode to enable .',
    ),
    null,
  );
});

test('en: the toast shows the reason unchanged', () => {
  setLocale('en');
  const shell = fakeShell();
  _handleContextLayerChange.call(shell, {
    type: 'visibility-blocked',
    layerId: 'flights',
    enabled: true,
    origin: 'user',
    reason: ENGLISH_GUARD,
  });
  assert.deepEqual(shell.toasts, [ENGLISH_GUARD]);
  assert.equal(
    localizeVisibilityBlockReason('Overpass returned HTTP 503'),
    'Overpass returned HTTP 503',
  );
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: the Space Missions block toast is localized with the layer name`, () => {
    setLocale(locale);
    const reason = contextLayerEnableBlockReason({
      contextMode: 'space-missions',
      change: { layerId: 'flights', enabled: true, origin: 'user' },
      layerName: 'Live Flights',
    });
    const shell = fakeShell();
    _handleContextLayerChange.call(shell, {
      type: 'visibility-blocked',
      layerId: 'flights',
      enabled: true,
      origin: 'user',
      reason,
    });
    assert.equal(shell.toasts.length, 1);
    assert.notEqual(shell.toasts[0], ENGLISH_GUARD, 'toast must be localized');
    assert.doesNotMatch(shell.toasts[0], /Space Missions isolates/);
    assert.doesNotMatch(shell.toasts[0], /Live Flights/);
  });

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
