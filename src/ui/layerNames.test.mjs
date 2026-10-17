import assert from 'node:assert/strict';
import test from 'node:test';
import { APPLICATION_LAYER_METADATA } from '../app/constructCatalog.js';
import { setLocale, t } from '../i18n/index.js';
import { FEED_SOURCE, COMBINED_SOURCE } from '../layers/localAdsb/status.js';
import {
  LAYER_NAME_KEYS,
  PANEL_LABEL_KEYS,
  sourceLabel,
} from './layerNames.js';

// Layers whose module name is a proper name and stays as it is in every
// language: the Bhote Koshi pair belong to a scripted scene.
const UNTRANSLATED_NAMES = new Set(['bhote-koshi-2026', 'bhote-koshi-locator']);

const catalogIds = APPLICATION_LAYER_METADATA.map((layer) => layer.id);

test('every catalog layer has a translatable name', () => {
  const missing = catalogIds.filter(
    (id) =>
      !UNTRANSLATED_NAMES.has(id) &&
      !Object.hasOwn(LAYER_NAME_KEYS, id) &&
      !Object.hasOwn(PANEL_LABEL_KEYS, id),
  );
  assert.deepEqual(
    missing,
    [],
    'add the layer to LAYER_NAME_KEYS in src/ui/layerNames.js',
  );
});

test('the name tables list only catalog layers', () => {
  const unknown = [
    ...Object.keys(LAYER_NAME_KEYS),
    ...Object.keys(PANEL_LABEL_KEYS),
    ...UNTRANSLATED_NAMES,
  ].filter((id) => !catalogIds.includes(id));
  assert.deepEqual(unknown, []);
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: Local ADS-B source names translate without their own entry`, () => {
    setLocale(locale);
    try {
      for (const source of [FEED_SOURCE, COMBINED_SOURCE]) {
        assert.notEqual(t(source), source, 'the catalog has the entry');
        assert.equal(sourceLabel(source), t(source));
      }
    } finally {
      setLocale('en');
    }
  });
}
