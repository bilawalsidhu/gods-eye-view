import { initAirQualityTestLayer } from '../../testSupport/airQualityViewer.mjs';
// The Air quality layer reads in the UI language: layer name, Weather card
// (title, coverage, status, legend, categories) and its own failure text.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale, t } from '../../i18n/index.js';
import { layerNameForId, localizeLayerName } from '../../ui/layerNames.js';
import { LayerPanel } from '../../ui/layerPanel.js';
import { translateFeedError } from '../../ui/statusText.js';
import { createAirQualityLayer } from './index.js';
import { createDefaultAirQualityProviders } from './providers.js';
import { interpretHourly, hourlyLegend } from './interpretation.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { onAqiPeriods } from '../../testSupport/airQualityViewer.mjs';

function inLocale(locale, run) {
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale('en');
  }
}

/** OpenAQ's default provider definition, read as one national answer. */
const OPENAQ = {
  ...createDefaultAirQualityProviders().find((entry) => entry.id === 'openaq'),
  viewDriven: false,
};

function harness(source) {
  const layer = createAirQualityLayer({
    source: { definitions: [OPENAQ], ...source },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  const viewer = {};
  bindFakeDraw(viewer);
  layer.init(viewer);
  layer.enable(viewer);
  return layer;
}

const reading = {
  id: 'openaq:A:PM2.5',
  provider: 'openaq',
  stationId: 'A',
  name: 'Toronto',
  zone: 'ont',
  lat: 43.65,
  lon: -79.38,
  parameter: 'PM2.5',
  scale: 'PM2.5',
  units: 'µg/m³',
  value: 12,
  kind: 'observation',
  averagingMinutes: 60,
  // Recent: a reading older than six hours is not drawn.
  observedMs: Date.now() - 10 * 60_000,
  color: '#8cb4ce',
  label: '12',
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
    const layer = harness({
      getSnapshot: async (request) =>
        request?.mode === 'aqi' ? onAqiPeriods([reading]) : [reading],
    });
    await layer.update();
    layer.setParams({ station: 'openaq:A:aqi' });
    const controls = inLocale(locale, () => layer.getRowControls());
    const english = [
      ...controls.summary.toggles.map((t) => t.label),
      controls.list.title,
      ...controls.sublists
        .flatMap((g) => g.tiles.map((tile) => tile.note))
        .filter(Boolean),
      controls.summary.label,
      controls.summary.coverage,
      controls.summary.status,
      ...controls.legend.map((entry) => entry.label),
      ...controls.list.items.map((item) => item.text),
    ].filter((text) =>
      /\b(Air quality|Worldwide|stations?|STATIONS|HIGHEST IN VIEW|Good|Fair|Moderate|Poor|Unhealthy|Hazardous)\b/.test(
        text,
      ),
    );
    assert.ok(controls.sublists.some((g) => g.tiles.some((t) => t.note)));
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
          source: 'OpenAQ · Worldwide',
          lastUpdate: null,
        },
      }),
    );
    assert.ok(!row.includes('Air quality request failed'), row);
  });
}

for (const locale of ['en', 'es', 'ru']) {
  test(`${locale}: the Weather card names a failed network in its language; the row keeps the error`, async () => {
    const layer = harness({
      getSnapshot: async () => {
        throw new Error('Air quality provider unavailable');
      },
    });
    await layer.update();
    const line = inLocale(
      locale,
      () =>
        layer
          .getRowControls()
          .summary.lines.find((item) => item.id === 'provider-openaq').text,
    );
    assert.equal(
      line,
      inLocale(locale, () => t('{network} unavailable', { network: 'OpenAQ' })),
    );
    // The failure itself stays the layer's error, for the Layers row.
    assert.equal(layer.getStats().error, 'Air quality provider unavailable');
    assert.ok(translateFeedError('Air quality provider unavailable'));
  });
}

const eeaRussian = [
  'Хорошее',
  'Приемлемое',
  'Умеренное',
  'Плохое',
  'Очень плохое',
  'Крайне плохое',
];
const russianScales = {
  openaq: { view: 'PM2.5', labels: eeaRussian },
  'US AQI': {
    provider: 'openaq',
    view: 'aqi',
    labels: [
      'Хорошо',
      'Умеренно',
      'Вредно для чувствительных групп',
      'Вредно',
      'Очень вредно',
      'Опасно',
    ],
  },
};
for (const [scale, { provider = scale, view, labels }] of Object.entries(
  russianScales,
)) {
  test(`ru: ${scale} legend, tiles and map labels use their scale's grammar`, async () => {
    const definition = createDefaultAirQualityProviders().find(
      (p) => p.id === provider,
    );
    let rows = [];
    let overlays = [];
    const layer = createAirQualityLayer({
      source: {
        // Reusing the definition under another id must retain its scale context.
        definitions: [{ ...definition, id: 'injected', viewDriven: false }],
        getSnapshot: async (request) =>
          request?.mode === 'aqi' ? onAqiPeriods(rows) : rows,
      },
      overlayHost: {
        setEntries(_id, entries) {
          overlays = entries;
        },
        setVisible() {},
        clearSource() {},
      },
    });
    const radians = (degrees) => (degrees * Math.PI) / 180;
    initAirQualityTestLayer(layer, {
      dataSources: { add() {}, remove() {} },
      // Around the reading, which is then the station nearest the centre.
      camera: {
        computeViewRectangle: () => ({
          west: radians(-80),
          south: radians(43),
          east: radians(-79),
          north: radians(44),
        }),
      },
    });
    layer.setParams({ view });
    layer.enable();
    setLocale('ru');
    try {
      await layer.update();
      const controls = layer.getRowControls();
      // Every view shows a numeric ramp.
      assert.deepEqual(
        controls.legend.map((entry) => entry.label),
        view === 'aqi'
          ? ['0', '50', '100', '150', '200', '300+']
          : ['0', '5', '15', '50', '90', '140+'],
      );
      assert.equal(
        t('Moderate'),
        'Умеренный',
        'shared risk wording is preserved',
      );
      assert.equal(
        t('Moderate', { context: 'fire behavior' }),
        'умеренная активность',
      );
      for (const [i, label] of labels.entries()) {
        const raw = {
          ...reading,
          id: 'observation',
          kind: 'observation',
          parameter: 'PM2.5',
          scale: 'PM2.5',
          units: 'µg/m³',
          averagingMinutes: 60,
          observedMs: Date.now(),
          value:
            view === 'aqi'
              ? [5, 20, 45, 100, 200, 300][i]
              : [4, 10, 25, 60, 100, 150][i],
        };
        rows = view === 'aqi' ? [raw] : [interpretHourly(raw)];
        await layer.update();
        const card = layer.getRowControls();
        const tile = card.sublists
          .flatMap((group) => group.tiles)
          .find((item) => item.id === view);
        assert.ok(tile.title.endsWith(` · ${label}`), tile.title);
        assert.ok(overlays[0].title.endsWith(` · ${label}`));
        if (view !== 'aqi')
          assert.equal(
            rows[0].assessment.label,
            hourlyLegend('PM2.5')[i].label,
            'source categories stay English',
          );
      }
    } finally {
      layer.destroy();
      setLocale('en');
    }
  });
}

test('every catalogue names each band of a scale differently', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../../i18n/locales/', import.meta.url);
  // Each band, with its short form where it has one: a band may share its
  // short name with its own long one, never with another band.
  const scales = {
    'EEA hourly quality': [
      ['Good'],
      ['Fair'],
      ['Moderate'],
      ['Poor'],
      ['Very poor'],
      ['Extremely poor', 'Extreme'],
    ],
    'US AQI category': [
      ['Good'],
      ['Moderate'],
      ['Unhealthy for Sensitive Groups', 'Sensitive groups'],
      ['Unhealthy'],
      ['Very Unhealthy'],
      ['Hazardous'],
    ],
  };
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 13);
  const clashes = [];
  for (const file of files) {
    const catalogue = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    for (const [context, bands] of Object.entries(scales)) {
      const owner = new Map();
      bands.forEach((names, band) => {
        for (const name of names) {
          const text = catalogue[`${context}|${name}`];
          assert.ok(text, `${file}: ${context}|${name} is missing`);
          if (owner.has(text) && owner.get(text) !== band)
            clashes.push(`${file} ${context}: "${text}"`);
          owner.set(text, band);
        }
      });
    }
  }
  assert.deepEqual(clashes, []);
});
