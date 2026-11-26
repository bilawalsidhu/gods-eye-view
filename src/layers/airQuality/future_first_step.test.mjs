import assert from 'node:assert/strict';
import test from 'node:test';
import { FIELD_IDS } from './field.js';
import { createAirQualityLayer } from './index.js';
import { createLocalAirQualityFieldSource } from './fieldSource.js';
import { createWorldClock } from '../../time/worldClock.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

const HOUR = 3600_000;
const SCALE = {
  pm25: 20,
  pm10: 10,
  o3: 50,
  no2: 50,
  so2: 20,
  co: 500,
  aqi: 10,
};
const gridsOf = (region, valueAt) =>
  Object.fromEntries(
    FIELD_IDS.map((id) => {
      const values = new Uint16Array(region.width * region.height);
      for (let y = 0; y < region.height; y++)
        for (let x = 0; x < region.width; x++) {
          const v = valueAt(x, y, id);
          values[y * region.width + x] =
            v === null ? 65535 : Math.round(v * SCALE[id]);
        }
      return [id, values];
    }),
  );
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const NATIONAL = {
  id: 'national',
  title: 'National',
  label: 'Air quality · National',
  network: 'NATIONAL',
  direct: true,
  parameters: ['PM2.5', 'PM10', 'O3', 'NO2', 'SO2', 'CO'],
};
const capeTown = () => [
  {
    id: 'national:cape-town:PM2.5',
    provider: 'national',
    stationId: 'cape-town',
    name: 'Cape Town',
    zone: 'WC',
    lat: -33.92,
    lon: 18.42,
    parameter: 'PM2.5',
    scale: 'PM2.5',
    units: 'µg/m³',
    value: 12,
    label: '12',
    kind: 'observation',
    averagingMinutes: 60,
    observedMs: Date.now() - 10 * 60_000,
    color: '#8cb4ce',
  },
];
function harness({
  fieldSource = null,
  clock = createWorldClock(),
  definitions = [NATIONAL],
  getSnapshot = async () => capeTown(),
} = {}) {
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const { draw } = bindFakeDraw(viewer, {
    camera: {
      on: () => () => {},
      viewRectangle: () => ({ west: 10, south: -40, east: 30, north: -25 }),
      pose: () => ({ height: 2_000_000 }),
    },
    query: {
      pickEllipsoid: (x, y) =>
        fromDegrees(18.42 + (x - 400) * 0.001, -33.92 + (300 - y) * 0.001),
      isOccluded: () => false,
    },
    globe: {
      isSettled: () => true,
      imagery: { add: (spec) => ({ spec, remove() {} }) },
    },
  });
  const layer = createAirQualityLayer({
    source: { definitions, getSnapshot },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    fieldSource,
    clock,
    registerCredit: () => true,
  });
  layer.init(viewer);
  layer.enable();
  return { layer, clock, points: () => draw.find('air-quality:points:') };
}
function hostField({ run = Date.now() - HOUR, steps = [0, 24] } = {}) {
  const WORLD = {
    width: 4,
    height: 3,
    lon0: 0,
    lat0: 90,
    step: 90,
    wrap: true,
  };
  const calls = { manifest: [] };
  return {
    run,
    calls,
    source: {
      async getManifest(options = {}) {
        calls.manifest.push(options);
        return {
          source: 'CAMS',
          run: new Date(run).toISOString(),
          scale: SCALE,
          global: { ...WORLD, steps },
        };
      },
      async getStep() {
        return { global: gridsOf(WORLD, () => 10) };
      },
    },
  };
}
const MANIFEST = {
  scale: SCALE,
  global: { width: 2, height: 2, lon0: 0, lat0: 1, step: 1, steps: [0, 3, 6] },
};

test('a run whose first step is ahead of now reaches the timeline', async () => {
  const host = hostField({ run: Date.now(), steps: [6, 9] });
  const h = harness({ fieldSource: host.source });
  await h.layer.update();
  await settle();
  const { start, end } = h.clock.coverage();
  assert.deepEqual(
    { start, end },
    {
      start: host.run + 6 * HOUR,
      end: host.run + 9 * HOUR,
    },
  );
});
