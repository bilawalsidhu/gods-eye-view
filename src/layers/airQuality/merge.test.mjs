import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRatedReading,
  mergeObservations,
  mergeStationValues,
} from './merge.js';

const reading = (provider, id, lat, lon, overrides = {}) => ({
  id: `${provider}:${id}`,
  provider,
  lat,
  lon,
  name: id,
  observedMs: Date.parse('2026-11-23T10:00:00Z'),
  value: 12,
  units: 'µg/m³',
  parameter: 'PM2.5',
  ...overrides,
});

test('a direct reading replaces an OpenAQ copy within 150 m', () => {
  const merged = mergeObservations([
    {
      provider: 'openaq',
      direct: false,
      readings: [reading('openaq', '1', -33.9249, 18.4241)],
    },
    {
      provider: 'national',
      direct: true,
      readings: [reading('national', '1', -33.925, 18.4242)],
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].provider, 'national');
});

test('a rated copy beats an unrated direct reading, and then the newer one loses to direct', () => {
  const site = (provider, overrides) =>
    reading(provider, '1', 28.6, 77.2, overrides);
  const rated = { assessment: { label: 'Poor', severity: 3 } };
  const older = { observedMs: Date.parse('2026-11-23T09:00:00Z') };
  const unrated = {
    assessment: { reason: 'A verified one-hour average is needed.' },
  };
  const merge = (national, openaq) =>
    mergeObservations([
      {
        provider: 'national',
        direct: true,
        readings: [site('national', national)],
      },
      { provider: 'openaq', direct: false, readings: [site('openaq', openaq)] },
    ]).map((kept) => kept.provider);
  assert.deepEqual(merge({ ...unrated, ...older }, rated), ['openaq']);
  assert.deepEqual(merge(unrated, { ...rated, monitor: false }), ['national']);
  // Neither rated: the direct reading wins even when it is older.
  assert.deepEqual(merge({ ...unrated, ...older }, {}), ['national']);
  assert.deepEqual(merge({ ...rated, ...older }, rated), ['national']);
});

test("rated means a category on the view's scale", () => {
  assert.equal(isRatedReading({ assessment: { label: 'Good' } }), true);
  assert.equal(isRatedReading({ assessment: { label: 'Good' } }, 'NO2'), true);
  // A network's own index alone is not the view's scale.
  assert.equal(isRatedReading({ rating: { label: 'Good', score: 2 } }), false);
  assert.equal(isRatedReading({ assessment: { reason: 'No usable' } }), false);
  assert.equal(isRatedReading({ rating: null }), false);
  // The AQI view rates on the computed US AQI only.
  const aqi = { aqi: { index: 57, leading: 'pm25' } };
  assert.equal(isRatedReading(aqi, 'aqi'), true);
  assert.equal(isRatedReading({ aqi: null }, 'aqi'), false);
  assert.equal(isRatedReading({ assessment: { label: 'Good' } }, 'aqi'), false);
  assert.equal(isRatedReading(aqi, 'PM2.5'), false);
});

test('the merge ranks on the view it is given', () => {
  const at = (provider, extra) => ({
    id: `${provider}:1`,
    lat: 10,
    lon: 10,
    observedMs: 1000,
    ...extra,
  });
  const kept = mergeObservations(
    [
      {
        provider: 'national',
        direct: true,
        readings: [at('national', { aqi: null })],
      },
      {
        provider: 'openaq',
        direct: false,
        readings: [at('openaq', { aqi: { index: 40, leading: 'pm25' } })],
      },
    ],
    { view: 'aqi' },
  );
  assert.deepEqual(
    kept.map((reading) => reading.id),
    ['openaq:1'],
  );
});

test('readings 200 m apart both stay', () => {
  const merged = mergeObservations([
    {
      provider: 'openaq',
      direct: false,
      readings: [reading('openaq', '1', -33.9249, 18.4241)],
    },
    {
      provider: 'national',
      direct: true,
      readings: [reading('national', '1', -33.9249 + 0.0018, 18.4241)],
    },
  ]);
  assert.equal(merged.length, 2);
});

test('ties keep the newer reading', () => {
  const merged = mergeObservations([
    {
      provider: 'national',
      direct: true,
      readings: [
        reading('national', '1', -33.925, 18.4242, {
          observedMs: Date.parse('2026-11-23T10:00:00Z'),
        }),
      ],
    },
    {
      provider: 'regional',
      direct: true,
      readings: [
        reading('regional', '1', -33.925, 18.4242, {
          observedMs: Date.parse('2026-11-23T11:00:00Z'),
        }),
      ],
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].observedMs, Date.parse('2026-11-23T11:00:00Z'));
});

test('a network never collapses its own neighbouring stations', () => {
  const merged = mergeObservations([
    {
      provider: 'openaq',
      direct: false,
      readings: [
        reading('openaq', '1', 51.5, -0.12),
        reading('openaq', '2', 51.5003, -0.12),
      ],
    },
  ]);
  assert.equal(merged.length, 2);
});

test('neighbouring grid cells are checked, and the dedupe distance is an option', () => {
  // 0.02° cells: these two sit either side of a cell edge, about 22 m apart.
  const lists = [
    {
      provider: 'openaq',
      direct: false,
      readings: [reading('openaq', '1', 10.0399, 20.0399)],
    },
    {
      provider: 'national',
      direct: true,
      readings: [reading('national', '1', 10.0401, 20.0401)],
    },
  ];
  assert.deepEqual(
    mergeObservations(lists).map((row) => row.provider),
    ['national'],
  );
  assert.equal(mergeObservations(lists, { dedupeM: 10 }).length, 2);
});

test('three providers at one site all resolve to the best reading', () => {
  const rows = ['direct', 'first', 'second'].map((provider, i) =>
    reading(provider, '1', 0, [0, 0.0006, 0.0007][i]),
  );
  const replaced = new Map();
  const kept = mergeObservations(
    rows.map((row, i) => ({
      provider: row.provider,
      direct: i === 0,
      readings: [row],
    })),
    { replaced },
  );
  assert.deepEqual(kept, [rows[0]]);
  assert.equal(replaced.get(rows[1]), rows[0]);
  assert.equal(replaced.get(rows[2]), rows[0]);
});

test('in the AQI view a site pools its networks’ pollutants, the freshest of each', () => {
  const t0 = Date.parse('2026-11-23T10:00:00Z');
  const station = (provider, extra) => ({
    id: `${provider}:1:aqi`,
    provider,
    network: provider.toUpperCase(),
    lat: 10,
    lon: 10,
    observedMs: t0,
    aqi: { index: 50, leading: 'pm25' },
    monitor: true,
    ...extra,
  });
  const national = station('national', {
    values: { pm25: 12, o3: 80 },
    aqiValues: { pm25: 12, o3: 80 },
    valueTimes: { pm25: t0 - 3600_000, o3: t0 },
    valueMethods: { pm25: 'nowcast', o3: 'nowcast' },
    hourValues: { o3: 90 },
    aqiExcluded: { co: 'hours' },
  });
  const copy = station('openaq', {
    lon: 10.0005,
    values: { pm25: 30, no2: 40, so2: 999 },
    // Its SO2 was left out of its own index (implausible): not offered.
    aqiValues: { pm25: 30, no2: 40 },
    valueTimes: { pm25: t0, no2: t0, so2: t0 },
    valueAveraging: { no2: 60 },
    aqiExcluded: { so2: 'implausible' },
  });
  const sensor = station('sensors', {
    lon: 9.9995,
    monitor: false,
    values: { co: 1 },
    valueTimes: { co: t0 },
  });
  const combineCalls = [];
  const replaced = new Map();
  const merged = mergeObservations(
    [
      { provider: 'national', direct: true, readings: [national] },
      { provider: 'openaq', direct: false, readings: [copy] },
      { provider: 'sensors', direct: false, readings: [sensor] },
    ],
    {
      view: 'aqi',
      replaced,
      combine: (kept, others) => {
        combineCalls.push([kept.id, others.map((r) => r.id)]);
        return mergeStationValues(kept, others);
      },
    },
  );
  assert.equal(merged.length, 1);
  // The monitor ranked best is kept; the rest come in best first.
  assert.deepEqual(combineCalls, [
    ['national:1:aqi', ['openaq:1:aqi', 'sensors:1:aqi']],
  ]);
  const [site] = merged;
  assert.equal(site.id, 'national:1:aqi');
  // PM2.5 from the copy (an hour newer), O3 kept, NO2 added; no sensor CO.
  assert.deepEqual(site.values, { pm25: 30, o3: 80, no2: 40 });
  assert.deepEqual(site.valueTimes, { pm25: t0, o3: t0, no2: t0 });
  assert.deepEqual(site.valueMethods, { o3: 'nowcast' });
  assert.deepEqual(site.valueAveraging, { no2: 60 });
  assert.deepEqual(site.hourValues, { o3: 90 });
  assert.deepEqual(site.valueSources, {
    pm25: { provider: 'openaq', id: 'openaq:1:aqi', network: 'OPENAQ' },
    o3: { provider: 'national', id: 'national:1:aqi', network: 'NATIONAL' },
    no2: { provider: 'openaq', id: 'openaq:1:aqi', network: 'OPENAQ' },
  });
  assert.deepEqual(site.excluded, { co: 'hours', so2: 'implausible' });
  // Every dropped reading points at the site's one reading.
  assert.equal(replaced.get(copy), site);
  assert.equal(replaced.get(sensor), site);
  // Without `combine` the kept reading is unchanged.
  const plain = mergeObservations(
    [
      { provider: 'national', direct: true, readings: [national] },
      { provider: 'openaq', direct: false, readings: [copy] },
    ],
    { view: 'aqi' },
  );
  assert.deepEqual(plain, [national]);
  // A low-cost sensor kept on its own takes in nothing.
  assert.equal(mergeStationValues(sensor, [copy]), sensor);
});

test('one site matches across the antimeridian and near the poles', () => {
  const pair = (a, b) =>
    mergeObservations([
      { provider: 'national', direct: true, readings: [a] },
      { provider: 'openaq', direct: false, readings: [b] },
    ]).map((kept) => kept.provider);
  // 111 m apart across 180°: one site, the direct reading kept.
  assert.deepEqual(
    pair(
      reading('national', '1', -16.5, 179.9995),
      reading('openaq', '1', -16.5, -179.9995),
    ),
    ['national'],
  );
  // 0.6° of longitude apart near the pole is about 12 m, 30 grid columns.
  assert.deepEqual(
    pair(
      reading('national', '2', 89.99, 0),
      reading('openaq', '2', 89.99, 0.6),
    ),
    ['national'],
  );
  // Either side of the pole itself.
  assert.deepEqual(
    pair(
      reading('national', '3', -89.9995, 10),
      reading('openaq', '3', -89.9995, -170),
    ),
    ['national'],
  );
  // At 75° N, 0.03° of longitude is about 860 m: two sites.
  assert.deepEqual(
    pair(
      reading('national', '4', 75, 20),
      reading('openaq', '4', 75, 20.03),
    ).sort(),
    ['national', 'openaq'],
  );
});
