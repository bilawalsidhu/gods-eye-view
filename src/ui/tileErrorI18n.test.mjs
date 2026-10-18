// Vector tile and weather image failures reach the DATA LAYERS row and the
// ALPR retry chip in the UI language; the sources keep them in English.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/index.js';
import { createVectorTileSource } from '../sources/vectorTiles.js';

globalThis.document ??= {
  getElementById: () => null,
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
};
const { LayerPanel } = await import('./layerPanel.js');
const { localizeLoadingPresentation } = await import('./shellFeedback.js');

const row = (id, error) =>
  LayerPanel.prototype._buildMetaText({
    id,
    enabled: true,
    stats: { status: 'unavailable', error, source: 'OpenSky' },
  });
const chipLabel = (label) =>
  localizeLoadingPresentation({
    state: 'retry',
    label,
    detail: 'ALPR cameras · retrying in 53s',
  }).label;

test.afterEach(() => setLocale('en'));

test('the vector tile source fails with the catalog key', async () => {
  const source = createVectorTileSource({
    tileJsonUrl: 'https://tiles.example/index.json',
    decode: () => [],
    fetchImpl: async () => new Response('', { status: 503 }),
  });
  await assert.rejects(source.getMetadata(), {
    message: 'Vector tile metadata unavailable',
  });
});

test('en: tile and weather image failures stay English', () => {
  setLocale('en');
  assert.match(
    row('alpr-cameras', 'Vector tile metadata unavailable'),
    / · Vector tile metadata unavailable$/,
  );
  assert.match(
    row('weather-radar', 'Weather image HTTP 404'),
    /Weather image HTTP 404$/,
  );
  assert.equal(
    chipLabel('VECTOR TILE METADATA UNAVAILABLE'),
    'VECTOR TILE METADATA UNAVAILABLE',
  );
  assert.equal(
    chipLabel('VECTOR TILES UNAVAILABLE (HTTP 503)'),
    'VECTOR TILES UNAVAILABLE (HTTP 503)',
  );
  assert.equal(chipLabel('SOMETHING ELSE'), 'SOMETHING ELSE');
});

const EXPECTED = {
  ru: {
    metadata: 'Метаданные векторных тайлов недоступны',
    http: 'Векторные тайлы недоступны (HTTP 503)',
    weather: 'Снимок погоды: HTTP 404',
  },
  es: {
    metadata: 'Metadatos de teselas vectoriales no disponibles',
    http: 'Teselas vectoriales no disponibles (HTTP 503)',
    weather: 'Imagen del clima: HTTP 404',
  },
};

for (const [locale, expected] of Object.entries(EXPECTED)) {
  test(`${locale}: tile failures are translated in the row and the chip`, () => {
    setLocale(locale);
    assert.match(
      row('alpr-cameras', 'Vector tile metadata unavailable'),
      new RegExp(` · ${expected.metadata}$`),
    );
    assert.ok(
      row('alpr-cameras', 'Vector tiles unavailable (HTTP 503)').endsWith(
        expected.http,
      ),
    );
    assert.equal(
      chipLabel('VECTOR TILE METADATA UNAVAILABLE'),
      expected.metadata.toLocaleUpperCase(locale),
    );
    assert.equal(
      chipLabel('VECTOR TILES UNAVAILABLE (HTTP 503)'),
      expected.http.toLocaleUpperCase(locale),
    );
  });

  test(`${locale}: a weather image failure is not read as a source name`, () => {
    setLocale(locale);
    assert.ok(
      row('weather-radar', 'Weather image HTTP 404').endsWith(expected.weather),
    );
  });
}
