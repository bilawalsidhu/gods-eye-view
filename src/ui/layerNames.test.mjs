import assert from 'node:assert/strict';
import test from 'node:test';
import { APPLICATION_LAYER_METADATA } from '../app/constructCatalog.js';
import { setLocale, t } from '../i18n/index.js';
import { FEED_SOURCE, COMBINED_SOURCE } from '../layers/localAdsb/status.js';
import {
  LAYER_NAME_KEYS,
  PANEL_LABEL_KEYS,
  sourceLabel,
  sourceStatusLabel,
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

for (const locale of ['en', 'es', 'ru', 'zh-CN']) {
  test(`${locale}: wells name omits snapshot and count labels are translated`, () => {
    setLocale(locale);
    try {
      assert.equal(LAYER_NAME_KEYS['us-groundwater'], 'U.S. Groundwater Wells');
      const name = t(LAYER_NAME_KEYS['us-groundwater']);
      assert.doesNotMatch(name, /Snapshot|\uFFFD/);
      if (locale !== 'en') {
        assert.notEqual(name, 'U.S. Groundwater Wells');
        assert.notEqual(
          t('Catalog records: {count}', { count: '1' }),
          'Catalog records: 1',
        );
        assert.notEqual(t('Water Wells'), 'Water Wells');
      }
    } finally {
      setLocale('en');
    }
  });
}
test('a provider name carries the fallback or stale state it answered in', () => {
  assert.equal(sourceStatusLabel('Plane Finder', null), 'Plane Finder');
  assert.equal(sourceStatusLabel('adsb.lol', 'fallback'), 'adsb.lol · FALLBACK');
  assert.equal(sourceStatusLabel('OpenSky Network', 'stale'), 'OpenSky Network · STALE');
  setLocale('ru');
  try {
    assert.equal(
      sourceStatusLabel('adsb.lol', 'fallback'),
      `adsb.lol · ${t('FALLBACK')}`,
    );
    assert.notEqual(t('FALLBACK'), 'FALLBACK');
  } finally {
    setLocale('en');
  }
});
