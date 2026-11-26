import assert from 'node:assert/strict';
import test from 'node:test';
import { createAirQualityLayer } from './src/layers/airQuality/index.js';
import { fromDegrees } from './src/geo/ellipsoid.js';
import { bindFakeDraw } from './src/testSupport/fakeDrawPort.mjs';
import { recordFacts } from './src/data/entityContext.js';
import { layerSnapshot } from './src/data/layerSnapshot.js';
import { setLocale } from './src/i18n/index.js';

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
      async getSnapshot({ provider }) {
        const a = answers[provider];
        if (a instanceof Error) throw a;
        return a ?? [];
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

test('analyst provider availability', async () => {
  const layer = harness({ openaq: noKey() }, [
    def('openaq', { requiresKeyId: 'openaq', direct: false }),
  ]);
  await layer.update();
  await flush();
  const stats = layer.getStats();
  const snap = layerSnapshot({
    id: 'air-quality',
    name: 'Air quality',
    enabled: true,
    stats,
  });
  console.log(
    'stats',
    JSON.stringify({
      keyRequired: stats.keyRequired,
      error: stats.error,
      count: stats.count,
      label: stats.loadingLabel,
    }),
    'feedState',
    snap.feedState,
  );
  assert.notEqual(snap.feedState, 'nominal');
});
