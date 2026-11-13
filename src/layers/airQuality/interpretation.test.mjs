import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  interpretHourly,
  EEA_HOURLY_LIMITS,
  hourlyLegend,
} from './interpretation.js';
import { normalizeOpenAqHours } from './openAq.js';
import { createAirQualityLayer } from './index.js';
import { createAirQualitySource } from './providers.js';
const now = Date.parse('2026-10-24T12:00:00Z');
const base = {
  parameter: 'PM2.5',
  value: 4,
  units: 'µg/m³',
  averagingMinutes: 60,
};
test('all published pollutant boundaries classify inclusively without rounding down', () => {
  for (const [parameter, limits] of Object.entries(EEA_HOURLY_LIMITS)) {
    for (const [i, value] of limits.entries()) {
      assert.equal(
        interpretHourly({ ...base, parameter, value }).assessment.severity,
        i,
      );
      assert.equal(
        interpretHourly({ ...base, parameter, value: value + 0.01 }).assessment
          .severity,
        i + 1,
      );
    }
    assert.equal(hourlyLegend(parameter).length, 6);
  }
  assert.equal(
    interpretHourly({ ...base, units: 'mg/m3', value: 0.015 }).assessment.label,
    'Fair',
  );
});
test('unknown periods, incomplete or flagged hours, unsupported units and CO2 never claim good air', () => {
  for (const patch of [
    { averagingMinutes: null },
    { averagingMinutes: 1440 },
    { coveragePercent: 50 },
    { coveragePercent: null },
    { qualityFlagged: true },
    { units: 'ppb' },
    { parameter: 'CO2' },
    { parameter: 'CO' },
    { value: null },
    { value: -1 },
    { value: Infinity },
  ]) {
    const result = interpretHourly({ ...base, ...patch });
    assert.ok(result.assessment.reason);
    assert.equal(result.assessment.label, undefined);
    assert.equal(result.color, '#8cb4ce');
  }
  assert.deepEqual(hourlyLegend('CO2'), []);
});
const sensor = { id: 100, parameter: 'PM2.5', units: 'µg/m³' };
const station = {
  stationId: '1',
  name: 'Station',
  sensors: [sensor],
  lat: 0,
  lon: 0,
};
const hour = (extra = {}) => ({
  value: 12,
  parameter: { name: 'pm25', units: 'µg/m³' },
  period: {
    interval: '01:00:00',
    datetimeFrom: { utc: '2026-10-24T10:00:00Z' },
    datetimeTo: { utc: '2026-10-24T11:00:00Z' },
  },
  flagInfo: { hasFlags: false },
  coverage: { percentCoverage: 100 },
  ...extra,
});
test('hourly data chooses latest complete period, retaining source units, time and quality', () => {
  const [r] = normalizeOpenAqHours(station, sensor, [hour()], now);
  assert.equal(r.assessment.label, 'Fair');
  assert.equal(r.assessment.basis, 'calculated');
  assert.equal(r.value, 12);
  assert.equal(r.averagingMinutes, 60);
  assert.equal(r.observedMs, now - 3600000);
  assert.equal(
    normalizeOpenAqHours(station, sensor, [hour({ coverage: null })], now)[0]
      .assessment.label,
    undefined,
  );
  assert.equal(
    normalizeOpenAqHours(
      station,
      sensor,
      [hour({ flagInfo: { hasFlags: true } })],
      now,
    )[0].assessment.label,
    undefined,
  );
  for (const patch of [
    { parameter: { name: 'pm10', units: 'µg/m³' } },
    { value: null },
    { period: { interval: '24:00:00' } },
  ])
    assert.deepEqual(
      normalizeOpenAqHours(station, sensor, [hour(patch)], now),
      [],
    );
  assert.deepEqual(
    normalizeOpenAqHours(station, sensor, [hour()], now + 7 * 3600000),
    [],
  );
});
test('readout leads with the highest selected-pollutant category and distinguishes a calculated comparison', async () => {
  const definition = createAirQualitySource().definitions.find(
    (p) => p.id === 'openaq',
  );
  const rows = [4, 55].map((value, i) =>
    interpretHourly({
      ...base,
      value,
      id: `station-${i}`,
      name: i ? 'Z concern' : 'A good',
      kind: 'observation',
      scale: 'PM2.5',
      label: `${value} µg/m³`,
      observedMs: Date.now(),
      lat: 0,
      lon: 0,
    }),
  );
  const layer = createAirQualityLayer({
    source: { definitions: [definition], getSnapshot: async () => rows },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init({
    dataSources: { add() {}, remove() {} },
    camera: {
      computeViewRectangle: () => ({
        west: -0.1,
        south: -0.1,
        east: 0.1,
        north: 0.1,
      }),
    },
  });
  layer.enable();
  await layer.update();
  const controls = layer.getRowControls();
  assert.equal(controls.summary.status, 'PM2.5 · Poor');
  assert.match(controls.summary.overview[0].text, /Poor · Z concern/);
  assert.match(controls.summary.overview.at(-1).text, /this pollutant only/);
  assert.equal(controls.list.items[0].badge, 'Poor');
  assert.match(controls.list.items[0].text, /Calculated comparison/);
  assert.equal(controls.legend.length, 7);
  assert.equal(layer.getAnalystRecords()[0].assessment.basis, 'calculated');
  layer.destroy();
});

test('the overview excludes stations beyond the horizon and suppresses guidance on failed refreshes', async () => {
  const definition = createAirQualitySource().definitions.find(
    (p) => p.id === 'openaq',
  );
  const rows = [4, 55].map((value, i) =>
    interpretHourly({
      ...base,
      value,
      id: `station-${i}`,
      stationId: String(i),
      name: i ? 'Beyond horizon' : 'Visible station',
      kind: 'observation',
      observedMs: Date.now(),
      lat: 0,
      lon: i ? 120 : 0,
    }),
  );
  let stale = false;
  let fail = false;
  const layer = createAirQualityLayer({
    source: {
      definitions: [definition],
      getSnapshot: async () => {
        if (fail) throw new Error('Rate limited');
        return rows;
      },
      getCoverage: () => ({ stale }),
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init({
    dataSources: { add() {}, remove() {} },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 1_000_000),
      computeViewRectangle: () => Cesium.Rectangle.MAX_VALUE,
    },
    scene: { globe: { ellipsoid: Cesium.Ellipsoid.WGS84 } },
  });
  layer.enable();
  await layer.update();
  assert.equal(layer.getRowControls().summary.status, 'PM2.5 · Good');
  assert.equal(layer.getRowControls().list.items.length, 1);
  stale = true;
  await layer.update();
  assert.deepEqual(layer.getRowControls().summary.overview, []);
  stale = false;
  fail = true;
  await layer.update();
  assert.deepEqual(layer.getRowControls().summary.overview, []);
  layer.destroy();
});
