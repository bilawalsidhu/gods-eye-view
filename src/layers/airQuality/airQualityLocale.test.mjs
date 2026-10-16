// The Air quality layer (AQHI) reads in the UI language: layer name, Weather
// card (title, coverage, status, legend, risk) and its own failure text.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale, t } from '../../i18n/index.js';
import { layerNameForId, localizeLayerName } from '../../ui/layerNames.js';
import { LayerPanel } from '../../ui/layerPanel.js';
import { translateFeedError } from '../../ui/statusText.js';
import { createAirQualityLayer } from './index.js';

function inLocale(locale, run) {
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale('en');
  }
}

function harness(source) {
  const layer = createAirQualityLayer({
    source,
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  const viewer = { dataSources: { add() {}, remove() {} } };
  layer.init(viewer);
  layer.enable(viewer);
  return layer;
}

const reading = {
  id: 'eccc:A',
  provider: 'eccc',
  scale: 'AQHI',
  value: 2,
  band: 'low',
  stationId: 'A',
  name: 'Toronto',
  zone: 'ont',
  lat: 43.65,
  lon: -79.38,
  observedMs: 1_700_000_000_000,
  color: '#4cc9f0',
  label: '2',
  risk: 'Low health risk',
  note: null,
};

for (const locale of ['es', 'ru']) {
  test(`${locale}: the layer name is translated`, () => {
    inLocale(locale, () => {
      assert.notEqual(t('Air quality'), 'Air quality', 'catalog has the entry');
      assert.equal(layerNameForId('air-quality'), t('Air quality'));
      assert.equal(localizeLayerName('Air quality'), t('Air quality'));
    });
  });

  test(`${locale}: the Weather card of Air quality is translated`, async () => {
    const layer = harness({ getSnapshot: async () => [reading] });
    await layer.update();
    const controls = inLocale(locale, () => layer.getRowControls());
    const english = [
      controls.summary.label,
      controls.summary.coverage,
      controls.summary.status,
      ...controls.legend.map((entry) => entry.label),
      ...controls.list.items.map((item) => item.text),
    ].filter((text) =>
      /\b(Air quality|Canada only|stations reporting|Low|Moderate|High|health risk)\b/.test(
        text,
      ),
    );
    assert.deepEqual(english, [], `English left in the ${locale} card`);
  });

  test(`${locale}: the Air quality failure text is translated in the row`, () => {
    const row = inLocale(locale, () =>
      LayerPanel.prototype._buildMetaText({
        id: 'air-quality',
        enabled: true,
        stats: {
          count: 0,
          error: 'Air quality request failed',
          source: 'ECCC',
          lastUpdate: null,
        },
      }),
    );
    assert.ok(!row.includes('Air quality request failed'), row);
  });
}

for (const locale of ['en', 'es', 'ru']) {
  test(`${locale}: the Weather card shows an HTTP failure as the row does`, async () => {
    const layer = harness({
      getSnapshot: async () => {
        throw new Error('ECCC HTTP 503');
      },
    });
    await layer.update();
    const card = inLocale(locale, () => layer.getRowControls().summary.status);
    assert.equal(
      card,
      inLocale(locale, () => translateFeedError('ECCC HTTP 503')),
    );
  });
}
