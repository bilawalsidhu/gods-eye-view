import assert from 'node:assert/strict';
import test from 'node:test';
import { createAirQualityLayer } from './src/layers/airQuality/index.js';
import { fromDegrees } from './src/geo/ellipsoid.js';
import { bindFakeDraw } from './src/testSupport/fakeDrawPort.mjs';
import { recordFacts } from './src/data/entityContext.js';
import { layerSnapshot } from './src/data/layerSnapshot.js';
import { setLocale } from './src/i18n/index.js';
import { onAqiPeriods } from './src/testSupport/airQualityViewer.mjs';

const ALL = ['PM2.5', 'PM10', 'O3', 'NO2', 'SO2', 'CO'];
const def = (id, extra = {}) => ({
  id,
  title: id,
  label: `Air quality · ${id}`,
  network: id.toUpperCase(),
  coverage: id,
  observation: true,
  direct: true,
  parameters: ALL,
  ...extra,
});
function harness(answers, definitions) {
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  bindFakeDraw(viewer, {
    camera: {
      on: () => () => {},
      viewRectangle: () => ({ west: 10, south: -40, east: 35, north: -20 }),
    },
    query: {
      pickEllipsoid: (x, y) =>
        fromDegrees(18.42 + (x - 400) * 0.001, -33.92 + (300 - y) * 0.001),
      isOccluded: () => false,
    },
  });
  const layer = createAirQualityLayer({
    source: {
      definitions,
      async getSnapshot({ provider, mode }) {
        const a = answers[provider];
        if (a instanceof Error) throw a;
        // The AQI view rates PM on its NowCast: the hours before it too.
        return mode === 'aqi' ? onAqiPeriods(a ?? []) : (a ?? []);
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewer);
  layer.enable();
  return layer;
}
const reading = (provider, parameter, value) => ({
  id: `${provider}:ct:${parameter}`,
  provider,
  stationId: 'ct',
  name: 'Cape Town',
  zone: 'WC',
  lat: -33.92,
  lon: 18.42,
  parameter,
  scale: parameter,
  units: 'µg/m³',
  value,
  label: `${value}`,
  kind: 'observation',
  averagingMinutes: 60,
  observedMs: Date.now() - 600000,
  color: '#8cb4ce',
});
const flush = () => new Promise((r) => setImmediate(r));
const noKey = () =>
  Object.assign(new Error('Provider API key required'), { code: 'no_key' });

test('Portuguese moderate quality', async () => {
  const layer = harness({ national: [reading('national', 'PM2.5', 20)] }, [
    def('national'),
  ]);
  await layer.update();
  await flush();
  setLocale('pt');
  try {
    const tile = layer
      .getRowControls()
      .sublists.find((g) => g.id === 'pollutants')
      .tiles.find((x) => x.id === 'PM2.5');
    console.log(JSON.stringify(tile));
    assert.equal(tile.note, 'Moderada');
  } finally {
    setLocale('en');
  }
});
