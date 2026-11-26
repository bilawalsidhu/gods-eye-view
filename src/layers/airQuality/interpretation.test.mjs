import { initAirQualityTestLayer } from '../../testSupport/airQualityViewer.mjs';
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
  // The published EEA bands (and CO's WHO-based steps), pinned here.
  assert.deepEqual(EEA_HOURLY_LIMITS, {
    'PM2.5': [5, 15, 50, 90, 140],
    PM10: [15, 45, 120, 195, 270],
    NO2: [10, 25, 60, 100, 150],
    O3: [60, 100, 120, 160, 180],
    SO2: [20, 40, 125, 190, 275],
    CO: [4, 7, 10, 35, 100],
  });
  for (const [parameter, limits] of Object.entries(EEA_HOURLY_LIMITS)) {
    // Each pollutant in the layer's unit: µg/m³, CO mg/m³.
    const units = parameter === 'CO' ? 'mg/m³' : 'µg/m³';
    for (const [i, value] of limits.entries()) {
      assert.equal(
        interpretHourly({ ...base, parameter, units, value }).assessment
          .severity,
        i,
      );
      assert.equal(
        interpretHourly({ ...base, parameter, units, value: value + 0.01 })
          .assessment.severity,
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

test('CO is banded in mg/m³ on the same six bands', () => {
  assert.deepEqual(EEA_HOURLY_LIMITS.CO, [4, 7, 10, 35, 100]);
  const co = (value, units = 'mg/m³') =>
    interpretHourly({ ...base, parameter: 'CO', units, value }).assessment;
  assert.equal(co(0.4).label, 'Good');
  assert.equal(co(8).label, 'Moderate');
  assert.equal(co(120).label, 'Extremely poor');
  // 9000 µg/m³ is 9 mg/m³.
  assert.equal(co(9000, 'µg/m³').label, 'Moderate');
  assert.equal(co(0.4).units, 'mg/m³');
  // CO's bands are the WHO's; the EEA's label belongs to the other gases.
  assert.equal(co(0.4).method, 'WHO-based carbon monoxide bands');
  assert.equal(
    interpretHourly({ ...base, parameter: 'NO2', units: 'µg/m³', value: 5 })
      .assessment.method,
    'EEA hourly pollutant bands',
  );
  assert.deepEqual(
    hourlyLegend('CO').map((band) => band.range),
    [
      '0–4 mg/m³',
      '>4–7 mg/m³',
      '>7–10 mg/m³',
      '>10–35 mg/m³',
      '>35–100 mg/m³',
      '>100 mg/m³',
    ],
  );
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
test('readout ranks the highest selected-pollutant category first and keeps the calculated comparison in its details', async () => {
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
  initAirQualityTestLayer(layer, {
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
  layer.setParams({ view: 'PM2.5' });
  layer.enable();
  await layer.update();
  const controls = layer.getRowControls();
  assert.equal(controls.summary.status, '2 stations');
  // Highest first, in its band's colour; the comparison is the tooltip.
  assert.equal(controls.list.items[0].text, 'Z concern');
  assert.equal(controls.list.items[0].lead, '55');
  assert.equal(controls.list.items[0].swatch, '#f29457');
  assert.match(controls.list.items[0].title, /Calculated comparison/);
  // The PM2.5 ramp: six EEA bands, 0 to the open top band.
  assert.equal(controls.legend.length, 6);
  assert.equal(layer.getAnalystRecords()[0].assessment.basis, 'calculated');
  layer.destroy();
});

test('the card counts and lists only stations this side of the horizon', async () => {
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
  initAirQualityTestLayer(layer, {
    dataSources: { add() {}, remove() {} },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 1_000_000),
      computeViewRectangle: () => Cesium.Rectangle.MAX_VALUE,
    },
    scene: { globe: { ellipsoid: Cesium.Ellipsoid.WGS84 } },
  });
  layer.setParams({ view: 'PM2.5' });
  layer.enable();
  await layer.update();
  assert.equal(layer.getRowControls().summary.status, '1 station');
  assert.equal(layer.getRowControls().list.items.length, 1);
  assert.equal(layer.getRowControls().list.items[0].text, 'Visible station');
  // A stale or failed refresh keeps what is drawn and says so in the stats.
  stale = true;
  await layer.update();
  assert.equal(layer.getStats().stale, true);
  stale = false;
  fail = true;
  await layer.update();
  assert.equal(layer.getRowControls().list.items.length, 1);
  assert.equal(
    layer.getRowControls().summary.lines.at(-1).text,
    'OpenAQ unavailable',
  );
  layer.destroy();
});

test('an implausible hourly value is unrated in a pollutant view, as in the AQI view', () => {
  const hourly = (parameter, value, units = 'µg/m³') =>
    interpretHourly({ parameter, value, units, averagingMinutes: 60 });
  const stuck = hourly('PM2.5', 9999);
  assert.equal(stuck.assessment.label, undefined);
  assert.match(stuck.assessment.reason, /Implausibly high/);
  assert.equal(stuck.color, '#8cb4ce');
  // At its ceiling a value is still rated.
  assert.equal(hourly('PM2.5', 3000).assessment.label, 'Extremely poor');
  // Carbon monoxide's ceiling is 200 mg/m³ in every view (175 ppm is 200.5).
  assert.equal(hourly('CO', 150, 'mg/m³').assessment.label, 'Extremely poor');
  assert.match(hourly('CO', 175, 'ppm').assessment.reason, /Implausibly high/);
  // NO2's is 8,000 µg/m³, twice the 3,856 its US AQI table puts at 500.
  assert.equal(hourly('NO2', 8000).assessment.label, 'Extremely poor');
  assert.match(hourly('NO2', 8001).assessment.reason, /Implausibly high/);
});
