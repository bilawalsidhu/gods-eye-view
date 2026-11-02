import assert from 'node:assert/strict';
import test from 'node:test';
import { APPLICATION_LAYER_METADATA } from '../app/constructCatalog.js';
import { setLocale, t } from '../i18n/index.js';
import { FEED_SOURCE, COMBINED_SOURCE } from '../layers/localAdsb/status.js';
import {
  LAYER_NAME_KEYS,
  PANEL_LABEL_KEYS,
  layerNameForId,
  sourceLabel,
} from './layerNames.js';
import { translateFeedError } from './statusText.js';

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

for (const [locale, name, source, unavailable] of [
  [
    'en',
    'CABA Traffic Enforcement',
    'Buenos Aires Data · location inventory',
    'CABA inventory unavailable',
  ],
  [
    'es',
    'Fiscalización de tránsito de CABA',
    'Buenos Aires Data · inventario de ubicaciones',
    'Inventario de CABA no disponible',
  ],
  [
    'ru',
    'Контроль дорожного движения CABA',
    'Buenos Aires Data · реестр местоположений',
    'Реестр CABA недоступен',
  ],
  ['zh-CN', 'CABA 交通执法', 'Buenos Aires Data · 位置清单', 'CABA 清单不可用'],
]) {
  test(`${locale}: CABA inventory labels and unavailable state follow the UI language`, () => {
    setLocale(locale);
    try {
      assert.equal(layerNameForId('caba-traffic-enforcement'), name);
      assert.equal(
        sourceLabel('Buenos Aires Data · location inventory'),
        source,
      );
      assert.equal(
        translateFeedError('CABA inventory unavailable'),
        unavailable,
      );
    } finally {
      setLocale('en');
    }
  });
}
