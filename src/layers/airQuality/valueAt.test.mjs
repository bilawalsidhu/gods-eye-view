import assert from 'node:assert/strict';
import test from 'node:test';
import { AIR_QUALITY_VALUE_RADIUS_KM, createAirQualityLayer } from './index.js';
import { interpretHourly } from './interpretation.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { onAqiPeriods } from '../../testSupport/airQualityViewer.mjs';

const ALL = ['PM2.5', 'PM10', 'O3', 'NO2', 'SO2', 'CO'];
const DEFINITION = {
  id: 'national',
  title: 'national',
  label: 'Air quality · national',
  network: 'NATIONAL',
  coverage: 'national coverage',
  observation: true,
  direct: true,
  parameters: ALL,
};
const CAPE_TOWN = { lat: -33.92, lon: 18.42, name: 'Cape Town' };
const DURBAN = { lat: -29.86, lon: 31.03, name: 'Durban' };
const NOW = 1_700_000_000_000;

/** One pollutant reading at a station, as a provider answers it. */
const pollutant = (place, parameter, value, extra = {}) => ({
  id: `national:${place.name.toLowerCase().replace(' ', '-')}:${parameter}`,
  provider: 'national',
  stationId: place.name.toLowerCase().replace(' ', '-'),
  name: place.name,
  zone: 'Region',
  lat: place.lat,
  lon: place.lon,
  parameter,
  scale: parameter,
  units: parameter === 'CO' ? 'mg/m³' : 'µg/m³',
  value,
  label: `${value}`,
  kind: 'observation',
  averagingMinutes: 60,
  observedMs: NOW - 10 * 60_000,
  color: '#8cb4ce',
  ...extra,
});

// Quantities keep number and unit together with a no-break space.
const plain = (text) => text.replace(/\s/gu, ' ');
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A layer whose provider answers `rows` (as AQI-view values, or one pollutant). */
function layerWith(rows) {
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  bindFakeDraw(viewer, {
    camera: {
      on: () => () => {},
      viewRectangle: () => ({ west: 10, south: -40, east: 35, north: -20 }),
    },
    query: {
      pickEllipsoid: (x, y) =>
        fromDegrees(
          CAPE_TOWN.lon + (x - 400) * 0.001,
          CAPE_TOWN.lat + (300 - y) * 0.001,
        ),
      isOccluded: () => false,
    },
  });
  const layer = createAirQualityLayer({
    source: {
      definitions: [DEFINITION],
      getCoverage: () => null,
      async getSnapshot(request) {
        return request.mode === 'aqi'
          ? onAqiPeriods(rows)
          : rows
              .filter((row) => row.parameter === request.parameter)
              .map(interpretHourly);
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewer);
  return layer;
}

const stations = (extra = {}) => [
  pollutant(CAPE_TOWN, 'PM2.5', 12, extra),
  pollutant(CAPE_TOWN, 'NO2', 20, extra),
  pollutant(DURBAN, 'PM2.5', 40, extra),
  pollutant(DURBAN, 'NO2', 30, extra),
];

test('getValueAt reads the nearest station within the radius', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const layer = layerWith(stations());
  assert.equal(layer.getValueAt(-33.9, 18.4), null, 'off');
  layer.enable();
  assert.equal(layer.getValueAt(-33.9, 18.4), null, 'nothing loaded');
  await layer.update();
  await flush();
  const cape = layer.getValueAt(-33.9, 18.4);
  assert.match(cape.value, /^US AQI \d+ · /);
  assert.equal(plain(cape.detail), 'Cape Town · 3 km');
  assert.equal(cape.at, NOW - 10 * 60_000);
  assert.equal(cape.stale, undefined);
  const durban = layer.getValueAt(-29.9, 31.0);
  assert.equal(plain(durban.detail), 'Durban · 5 km');
  assert.notEqual(durban.value, cape.value, 'each reads its own station');
  assert.equal(AIR_QUALITY_VALUE_RADIUS_KM, 50);
  const none = {
    value: null,
    reason: 'No station within 50 km',
  };
  assert.deepEqual(layer.getValueAt(48.85, 2.35), none, 'Paris');
  assert.deepEqual(layer.getValueAt(-31.5, 24), none, 'between stations');
  assert.equal(layer.getValueAt(Number.NaN, 18.4), null);
  assert.equal(layer.getValueAt(-33.9, undefined), null);
  layer.disable();
  assert.equal(layer.getValueAt(-33.9, 18.4), null);
  layer.destroy();
});

test('getValueAt gives the computed US AQI with its band in words', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const layer = layerWith([
    pollutant(CAPE_TOWN, 'PM2.5', 12),
    pollutant(DURBAN, 'PM2.5', 600),
  ]);
  layer.enable();
  await layer.update();
  await flush();
  assert.equal(layer.getValueAt(-33.92, 18.42).value, 'US AQI 56 · Moderate');
  // Above 500 the index shows as "500+".
  assert.match(layer.getValueAt(-29.86, 31.03).value, /^US AQI 500\+ · /);
  layer.destroy();
});

test('getValueAt gives a pollutant view as concentration and EEA band', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const layer = layerWith(stations());
  layer.enable();
  layer.setParams({ view: 'PM2.5' });
  await layer.update();
  await flush();
  const cape = layer.getValueAt(-33.92, 18.42);
  assert.equal(plain(cape.value), 'PM2.5 12 µg/m³ · Fair');
  assert.equal(
    plain(layer.getValueAt(-29.86, 31.03).value).slice(0, 15),
    'PM2.5 40 µg/m³ ',
  );
  layer.destroy();
});

test('getValueAt marks an observation older than two hours as stale', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const layer = layerWith(stations({ observedMs: NOW - 3 * 3600_000 }));
  layer.enable();
  await layer.update();
  await flush();
  const old = layer.getValueAt(-33.92, 18.42);
  assert.equal(old.at, NOW - 3 * 3600_000);
  assert.equal(old.stale, true);
  layer.destroy();
});

test('getValueAt shows an unrated station without a band', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const layer = layerWith([
    pollutant(CAPE_TOWN, 'PM2.5', 12, { qualityFlagged: true }),
  ]);
  layer.enable();
  await layer.update();
  await flush();
  assert.equal(layer.getValueAt(-33.92, 18.42).value, 'US AQI —');
  layer.destroy();
});
