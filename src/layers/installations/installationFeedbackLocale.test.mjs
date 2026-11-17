import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, translateKnown } from '../../i18n/index.js';
import { createControls } from './controls.js';

function stats(state) {
  const layerState = { records: [], enabled: true, ...state };
  return createControls({
    state: layerState,
    services: {},
    parts: {},
    source: {},
  }).methods.getStats();
}

for (const locale of ['es', 'ru']) {
  test(`${locale}: installation feedback is in the UI language`, () => {
    setLocale(locale);
    const empty = stats({ status: 'empty', lastUpdate: 1 }).statusMessage;
    assert.notEqual(empty, 'No mapped sites in view');
    const found = stats({
      status: 'ready',
      lastUpdate: 1,
      records: [{ kind: 'installation' }, { kind: 'installation' }],
    }).statusMessage;
    assert.notEqual(found, '2 mapped sites in view');
    const tiles = stats({
      status: 'unavailable',
      failureReason: 'tiles_unavailable',
    }).statusMessage;
    assert.notEqual(tiles, 'Map tiles temporarily unavailable');
    const retry = stats({
      status: 'unavailable',
      failureReason: 'names_unavailable',
      retryAt: Date.now() + 5000,
    }).statusMessage;
    assert.doesNotMatch(retry, /^Mapped names temporarily unavailable/);
    for (const text of [
      'Too many mapped sites in view to list them all',
      'Installation context unavailable',
    ]) {
      assert.notEqual(translateKnown(text), text);
    }
  });
}

test('en: installation feedback keeps its English wording', () => {
  setLocale('en');
  assert.equal(
    stats({ status: 'empty', lastUpdate: 1 }).statusMessage,
    'No mapped sites in view',
  );
  assert.equal(
    stats({
      status: 'ready',
      lastUpdate: 1,
      records: [{ kind: 'installation' }],
    }).statusMessage,
    '1 mapped site in view',
  );
  assert.equal(
    stats({
      status: 'ready',
      lastUpdate: 1,
      wide: true,
      coverage: { kind: 'subject', radiusM: 25000 },
      records: [{ kind: 'installation' }, { kind: 'installation' }],
    }).statusMessage,
    '2 mapped sites within 25 km of the contact',
  );
  assert.equal(
    stats({
      status: 'unavailable',
      failureReason: 'names_unavailable',
      retryAt: Date.now() + 5000,
    }).statusMessage,
    'Mapped names temporarily unavailable — retrying in 5s',
  );
});
