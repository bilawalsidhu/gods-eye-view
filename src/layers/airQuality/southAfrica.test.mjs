import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSaStations,
  normalizeSaMeasurements,
  selectSaReadings,
  saObservationTime,
  SA_POLLUTANTS,
} from './southAfrica.js';
import { createAirQualitySource } from './providers.js';
import { createAirQualityLayer } from './index.js';

const now = Date.parse('2026-10-20T10:00:00Z');
const regions = [
  {
    regionId: 2,
    name: 'Western Cape',
    stations: [
      {
        stationId: 1,
        name: 'Khayelitsha',
        active: true,
        owner: 'City of Cape Town',
        location: { latitude: -34.04, longitude: 18.67 },
      },
      {
        stationId: 2,
        name: 'Silent station',
        active: false,
        location: { latitude: -33.9, longitude: 18.5 },
      },
    ],
  },
];
const channel = (extra = {}) => ({
  name: 'PM2.5',
  active: true,
  valid: true,
  value: 12.5,
  units: 'µg/m³',
  datetime: '2026-10-20T11:00:00+02:00',
  ...extra,
});
const entry = (channels) => [
  {
    stationId: 1,
    regionData: {
      datetime: '2026-10-20T12:00:00+02:00',
      channels,
    },
  },
];
const snapshot = (channels) => {
  const stations = normalizeSaStations(regions);
  return {
    schemaVersion: 1,
    fetchedAt: now,
    stale: false,
    stations,
    readings: normalizeSaMeasurements(entry(channels), stations),
  };
};

test('catalog retains silent stations; all nine provinces have no city allowlist', () => {
  const provinces = [
    'Western Cape',
    'Eastern Cape',
    'Northern Cape',
    'Free State',
    'Gauteng',
    'KwaZulu-Natal',
    'Limpopo',
    'Mpumalanga',
    'North West',
  ];
  const result = normalizeSaStations(
    provinces.map((name, i) => ({
      name,
      stations: [
        {
          ...regions[0].stations[0],
          stationId: i + 1,
          name: `Rural municipality ${i}`,
        },
      ],
    })),
  );
  assert.equal(result.length, 9);
  assert.equal(normalizeSaStations(regions)[1].active, false);
  assert.throws(() => normalizeSaStations([]), /Empty/);
  assert.throws(() => normalizeSaStations([{}]), /Malformed/);
});

test('invalid coordinates are not coerced into zero; catalog identity is stable', () => {
  const result = normalizeSaStations([
    {
      ...regions[0],
      stations: [
        ...regions[0].stations,
        {
          ...regions[0].stations[0],
          stationId: 9,
          location: { latitude: null, longitude: '' },
        },
      ],
    },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].stationId, '1');
});

test('timestamps use source offsets or SAST and reject ambiguous dates', () => {
  assert.equal(saObservationTime('2026-10-20T12:00:00'), now);
  assert.equal(saObservationTime('2026-10-20T10:00:00Z'), now);
  assert.equal(saObservationTime('20/10/2026'), null);
});

test('fresh station timestamp cannot hide years-old channel data', () => {
  const p = snapshot([channel({ datetime: '2020-06-01T00:00:00+02:00' })]);
  assert.equal(
    p.readings.length,
    1,
    'inventory can retain last reported values',
  );
  assert.deepEqual(selectSaReadings(p, 'PM2.5', now), []);
});

test('invalid, inactive, null, negative, exotic units and future measurements never appear current', () => {
  for (const override of [
    { valid: false },
    { active: false },
    { value: null },
    { value: '' },
    { value: -1 },
    { value: Infinity },
    { units: 'mg/Nm3' },
    { datetime: '2026-10-21T12:00:00+02:00' },
  ])
    assert.equal(
      selectSaReadings(snapshot([channel(override)]), 'PM2.5', now).length,
      0,
    );
  assert.equal(
    selectSaReadings(snapshot([channel({ value: 0 })]), 'PM2.5', now)[0].value,
    0,
  );
});

test('concentrations retain original units, hourly period and attribution without AQI or emissions claims', () => {
  const p = snapshot([
    channel(),
    channel({ name: 'CO2', value: 420, units: 'ppm' }),
  ]);
  const [co2] = selectSaReadings(p, 'CO2', now);
  assert.equal(co2.units, 'ppm');
  assert.equal(co2.band, null);
  assert.equal(co2.risk, null);
  assert.equal(co2.kind, 'observation');
  assert.equal(co2.averagingMinutes, 60);
  assert.equal(co2.owner, 'City of Cape Town');
  assert.equal(selectSaReadings(p, 'PM2.5', now).length, 1);
  assert.ok(SA_POLLUTANTS.includes('H2S'));
});

test('duplicate station/pollutant observations keep the newest valid value', () => {
  const p = snapshot([
    channel(),
    channel({ value: 20, datetime: '2026-10-20T12:00:00+02:00' }),
    channel(),
  ]);
  assert.equal(p.readings.length, 1);
  assert.equal(p.readings[0].value, 20);
});

test('provider composition preserves Canada, propagates errors and rechecks cached measurement age', async () => {
  let clock = now;
  let calls = 0;
  const source = createAirQualitySource({
    canada: { getSnapshot: async () => ['canada'] },
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      return Response.json(snapshot([channel()]));
    },
  });
  assert.deepEqual(await source.getSnapshot(), ['canada']);
  assert.equal(calls, 0);
  assert.equal((await source.getSnapshot({ provider: 'saaqis' })).length, 1);
  assert.equal(source.getCoverage().stations.length, 2);
  clock += 7 * 3600_000;
  assert.deepEqual(await source.getSnapshot({ provider: 'saaqis' }), []);
  await assert.rejects(source.getSnapshot({ provider: 'other' }), /Unknown/);
  const failed = createAirQualitySource({
    fetchImpl: async () => new Response('', { status: 503 }),
  });
  await assert.rejects(
    failed.getSnapshot({ provider: 'saaqis' }),
    /unavailable/,
  );
});

test('provider switch clears old markers and ignores late requests; view changes unsubscribe on destroy', async () => {
  let resolveCanada;
  let removed = false;
  let listener;
  const source = {
    definitions: createAirQualitySource().definitions.filter((p) =>
      ['eccc', 'saaqis'].includes(p.id),
    ),
    getSnapshot: ({ provider }) =>
      provider === 'saaqis'
        ? Promise.resolve(selectSaReadings(snapshot([channel()]), 'PM2.5', now))
        : new Promise((resolve) => {
            resolveCanada = resolve;
          }),
  };
  const layer = createAirQualityLayer({
    source,
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init({
    dataSources: { add() {}, remove() {} },
    camera: {
      computeViewRectangle: () => ({
        west: 0,
        east: 0.1,
        south: 0,
        north: 0.1,
      }),
      moveEnd: {
        addEventListener(fn) {
          listener = fn;
          return () => {
            removed = true;
          };
        },
      },
    },
  });
  layer.enable();
  const old = layer.update();
  layer.setParams({ provider: 'saaqis' });
  await layer.update();
  resolveCanada([]);
  assert.equal(await old, false);
  assert.equal(layer.getStats().count, 1);
  const card = layer.getRowControls();
  assert.equal(card.legend.length, 6);
  assert.deepEqual(
    card.list.items,
    [],
    'no distant Canadian or South African fallback',
  );
  assert.ok(
    card.summary.lines.some((line) =>
      line.text.includes('No current observations'),
    ),
  );
  assert.equal(layer.getAnalystRecords()[0].units, 'µg/m³');
  listener();
  layer.destroy();
  assert.equal(removed, true);
});

test('a Canada-only injected source cannot be labelled South African', () => {
  const layer = createAirQualityLayer({
    source: { getSnapshot: async () => [] },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  assert.equal(layer.setParams({ provider: 'saaqis' }), false);
  assert.equal(layer.getParams().provider, 'eccc');
  assert.equal(layer.getRowControls().summary.settings[0].chips.length, 1);
});

test('provider index requires matching time, pollutant, category and supported scale', async () => {
  const { attachSaIndexes } = await import('./southAfrica.js');
  const row = {
    stationId: '1',
    parameter: 'PM2.5',
    observedMs: Date.parse('2026-10-20T10:00:00Z'),
  };
  const payload = (score, description, overrides = {}) => ({
    indexType: 1,
    data: [
      {
        stationId: 1,
        datetime: '2026-10-20T12:00:00+02:00',
        indexes: [{ pollutant: 'PM2.5', index: score, description }],
        ...overrides,
      },
    ],
  });
  for (const [score, label] of [
    [1, 'Good'],
    [3, 'Good'],
    [4, 'Moderate'],
    [5, 'Moderate'],
    [6, 'Unhealthy'],
    [7, 'Unhealthy'],
    [8, 'Very Unhealthy'],
    [9, 'Very Unhealthy'],
    [10, 'Hazardous'],
  ]) {
    assert.equal(
      attachSaIndexes([row], payload(score, label))[0].rating.label,
      label,
    );
  }
  for (const p of [
    null,
    payload(-9999, 'Good'),
    payload(11, 'Hazardous'),
    payload(1.5, 'Good'),
    payload(1, 'Hazardous'),
    payload(1, 'Good', { datetime: '2026-10-19T12:00:00+02:00' }),
    { ...payload(1, 'Good'), indexType: 2 },
  ]) {
    assert.equal(attachSaIndexes([row], p)[0].rating, null);
  }
  assert.equal(
    attachSaIndexes([{ ...row, parameter: 'CO2' }], payload(1, 'Good'))[0]
      .rating,
    null,
  );
});
