import { initAirQualityTestLayer } from '../../testSupport/airQualityViewer.mjs';
// The Air quality layer (AQHI) reads in the UI language: layer name, Weather
// card (title, coverage, status, legend, risk) and its own failure text.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale, t } from '../../i18n/index.js';
import { layerNameForId, localizeLayerName } from '../../ui/layerNames.js';
import { LayerPanel } from '../../ui/layerPanel.js';
import { translateFeedError } from '../../ui/statusText.js';
import { createAirQualityLayer } from './index.js';
import { createDefaultAirQualityProviders } from './providers.js';
import { interpretHourly, hourlyLegend } from './interpretation.js';
import { attachSaIndexes, SA_INDEX_BANDS } from './southAfrica.js';
import { usAqiRange } from './usAqi.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

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
  const viewer = {};
  bindFakeDraw(viewer);
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

const eeaRussian = [
  'Хорошее',
  'Приемлемое',
  'Умеренное',
  'Плохое',
  'Очень плохое',
  'Крайне плохое',
];
const russianScales = {
  eccc: {
    view: 'aqhi',
    labels: ['Низкий', 'Умеренный', 'Высокий', 'Очень высокий'],
  },
  openaq: { view: 'PM2.5', labels: eeaRussian },
  // SAAQIS stations are rated on the EEA bands too; SAAQIS's own index keeps
  // its own grammar in the station's details.
  saaqis: { view: 'PM2.5', labels: eeaRussian },
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
const saaqisRussian = [
  'Хорошо',
  'Умеренно',
  'Вредно',
  'Очень вредно',
  'Опасно',
];

for (const [scale, { provider = scale, view, labels }] of Object.entries(
  russianScales,
)) {
  test(`ru: ${scale} legend, summary, badges and map labels use their scale's grammar`, async () => {
    const definition = createDefaultAirQualityProviders().find(
      (p) => p.id === provider,
    );
    let rows = [];
    let overlays = [];
    const layer = createAirQualityLayer({
      source: {
        // Reusing the definition under another id must retain its scale context.
        definitions: [{ ...definition, id: 'injected', viewDriven: false }],
        getSnapshot: async () => rows,
      },
      overlayHost: {
        setEntries(_id, entries) {
          overlays = entries;
        },
        setVisible() {},
        clearSource() {},
      },
    });
    initAirQualityTestLayer(layer, { dataSources: { add() {}, remove() {} } });
    layer.setParams({ view });
    layer.enable();
    setLocale('ru');
    try {
      await layer.update();
      const controls = layer.getRowControls();
      const ranges =
        view === 'aqi'
          ? labels.map((_label, i) => usAqiRange(i))
          : view === 'aqhi'
            ? definition.legend.map((band) => band.range)
            : hourlyLegend(view).map((band) => band.range);
      assert.deepEqual(
        controls.legend.slice(0, labels.length).map((entry) => entry.label),
        labels.map((label, i) => `${label}${ranges[i] ? ` ${ranges[i]}` : ''}`),
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
      if (view === 'aqhi') return;
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
        const band = SA_INDEX_BANDS[Math.min(i, SA_INDEX_BANDS.length - 1)];
        rows =
          view === 'aqi'
            ? [raw]
            : provider === 'openaq'
              ? [interpretHourly(raw)]
              : attachSaIndexes([raw], {
                  indexType: 1,
                  data: [
                    {
                      stationId: raw.stationId,
                      datetime: new Date(raw.observedMs).toISOString(),
                      indexes: [
                        {
                          pollutant: raw.parameter,
                          index: band.max,
                          description: band.label,
                        },
                      ],
                    },
                  ],
                }).map(interpretHourly);
        await layer.update();
        const card = layer.getRowControls();
        assert.equal(
          card.summary.status,
          `${view === 'aqi' ? 'US AQI' : 'PM2.5'} · ${label}`,
        );
        assert.ok(card.summary.overview[0].text.includes(label));
        assert.equal(card.list.items[0].badge, label);
        assert.ok(overlays[0].title.endsWith(` · ${label}`));
        if (provider === 'saaqis')
          assert.ok(
            card.list.items[0].title.includes(
              `Индекс SAAQIS ${band.max}/10 · ${saaqisRussian[SA_INDEX_BANDS.indexOf(band)]}`,
            ),
            card.list.items[0].title,
          );
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
