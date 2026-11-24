import { initAirQualityTestLayer } from '../../testSupport/airQualityViewer.mjs';
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

test('impossible SAAQIS calendar dates never become current observations', () => {
  for (const timestamp of [
    '2026-02-30T12:00:00',
    '2025-02-29T12:00:00+02:00',
    '2026-09-31T11:00:00+02:00',
    '2026-10-20T24:00:00+02:00',
  ]) {
    assert.equal(saObservationTime(timestamp), null, timestamp);
  }
  assert.equal(
    saObservationTime('2024-02-29T12:00:00+02:00'),
    Date.parse('2024-02-29T10:00:00Z'),
  );
  assert.deepEqual(
    snapshot([channel({ datetime: '2026-09-31T11:00:00+02:00' })]).readings,
    [],
  );
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

test('provider composition propagates errors and rechecks cached measurement age', async () => {
  let clock = now;
  let calls = 0;
  const source = createAirQualitySource({
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      return Response.json(snapshot([channel()]));
    },
  });
  // South Africa is the first provider: the default one asked.
  assert.equal((await source.getSnapshot()).length, 1);
  assert.equal(calls, 1);
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

test('view switch clears old markers and ignores late requests; camera changes unsubscribe on destroy', async (t) => {
  // The layer's clock at the snapshot's time: its readings are an hour old.
  t.mock.timers.enable({ apis: ['Date'], now });
  const late = [];
  let removed = false;
  let listener;
  const source = {
    definitions: createAirQualitySource().definitions.filter((p) =>
      ['saaqis', 'cpcb'].includes(p.id),
    ),
    getSnapshot: ({ provider, parameter }) =>
      provider === 'saaqis'
        ? Promise.resolve(
            parameter === 'PM2.5'
              ? selectSaReadings(snapshot([channel()]), 'PM2.5', now)
              : [],
          )
        : new Promise((resolve) => late.push(resolve)),
  };
  const layer = createAirQualityLayer({
    source,
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
    },
  });
  initAirQualityTestLayer(layer, {
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
  layer.setParams({ view: 'PM2.5' });
  await layer.update();
  // India's answer for the US AQI view lands after the switch, in view.
  late[0]([
    {
      id: 'cpcb:late:PM2.5',
      provider: 'cpcb',
      stationId: 'late',
      name: 'Late station',
      lat: 0.05,
      lon: 0.05,
      parameter: 'PM2.5',
      units: 'µg/m³',
      value: 30,
      kind: 'observation',
      averagingMinutes: 60,
      observedMs: now,
    },
  ]);
  assert.equal(await old, true);
  assert.equal(layer.getStats().count, 1);
  const card = layer.getRowControls();
  // The EEA PM2.5 bands as one ramp: one scale for every network.
  assert.equal(card.legend.length, 6);
  assert.deepEqual(
    card.list.items,
    [],
    'no late answer and no distant South African fallback',
  );
  assert.equal(card.summary.status, '0 stations');
  assert.equal(layer.getAnalystRecords()[0].units, 'µg/m³');
  listener();
  layer.destroy();
  assert.equal(removed, true);
});

test('view-driven providers debounce navigation, abort old requests, and separate loading from empty coverage', async () => {
  let moveEnd,
    resolveOld,
    coverage = { partial: false };
  let rect = { west: 0, south: 0, east: 0.1, north: 0.1 };
  const calls = [];
  const definition = createAirQualitySource().definitions.find(
    (p) => p.id === 'openaq',
  );
  const layer = createAirQualityLayer({
    source: {
      definitions: [definition],
      getCoverage: () => coverage,
      getSnapshot: (request) => {
        calls.push(request);
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  initAirQualityTestLayer(layer, {
    dataSources: { add() {}, remove() {} },
    camera: {
      computeViewRectangle: () => rect,
      moveEnd: {
        addEventListener(fn) {
          moveEnd = fn;
          return () => {};
        },
      },
    },
  });
  layer.enable();
  const initial = layer.update();
  assert.match(layer.getRowControls().summary.status, /Loading/);
  const resolveInitial = resolveOld;
  rect = { ...rect, west: 1, east: 1.1 };
  moveEnd();
  moveEnd();
  moveEnd();
  assert.equal(calls[0].signal.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(calls.length, 2);
  assert.notDeepEqual(calls[0].view, calls[1].view);
  resolveInitial([]);
  assert.equal(
    await initial,
    true,
    'supersession must not fail the manager enable transaction',
  );
  assert.match(layer.getRowControls().summary.status, /Loading/);
  coverage = { partial: true };
  resolveOld([]);
  await new Promise((resolve) => setImmediate(resolve));
  // Answered with nothing yet: a count, not Loading.
  assert.equal(layer.getRowControls().summary.status, '0 stations');
  const complete = layer.update();
  coverage = { partial: false };
  resolveOld([]);
  await complete;
  assert.equal(layer.getRowControls().summary.status, '0 stations');
  rect = { ...rect, west: 2, east: 2.1 };
  moveEnd();
  layer.disable();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(calls.length, 3, 'disable cancels pending camera refresh');
  layer.destroy();
});

test('stale coverage says the network shows cached data; partial alone says nothing', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const definition = createAirQualitySource().definitions.find(
    (p) => p.id === 'saaqis',
  );
  for (const [coverage, lines] of [
    [
      { partial: true, stale: true },
      [
        {
          id: 'provider-saaqis',
          muted: true,
          text: 'SAAQIS: showing cached data',
        },
      ],
    ],
    [{ partial: true }, []],
  ]) {
    const layer = createAirQualityLayer({
      source: {
        definitions: [definition],
        getSnapshot: async () =>
          selectSaReadings(snapshot([channel()]), 'PM2.5', now),
        getCoverage: () => coverage,
      },
      overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    });
    initAirQualityTestLayer(layer, { dataSources: { add() {}, remove() {} } });
    layer.setParams({ view: 'PM2.5' });
    layer.enable();
    await layer.update();
    // The stations stay on the map and in the count either way.
    assert.equal(layer.getStats().count, 1);
    const { summary } = layer.getRowControls();
    assert.equal(summary.status, '1 station');
    assert.deepEqual(summary.lines, lines);
    layer.destroy();
  }
});

test('viewport rate limits are explicit and do not disable the layer', async () => {
  const definition = createAirQualitySource().definitions.find(
    (p) => p.id === 'openaq',
  );
  const layer = createAirQualityLayer({
    source: {
      definitions: [definition],
      getSnapshot: async () => [],
      getCoverage: () => ({ partial: true, stale: true, failureStatus: 429 }),
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  initAirQualityTestLayer(layer, {
    dataSources: { add() {}, remove() {} },
    camera: {
      computeViewRectangle: () => ({
        west: 0,
        south: 0,
        east: 0.1,
        north: 0.1,
      }),
    },
  });
  layer.enable();
  assert.equal(await layer.update(), true);
  // The budget is the network's own line; the status says what the map has.
  const controls = layer.getRowControls();
  assert.equal(controls.summary.status, '0 stations');
  assert.match(
    controls.summary.lines.find((line) => line.id === 'provider-openaq').text,
    /^OpenAQ: request budget reached/,
  );
  layer.destroy();
});

test('unresolved camera waits for a view instead of starting worldwide acquisition', async () => {
  let calls = 0;
  const definition = createAirQualitySource().definitions.find(
    (p) => p.id === 'openaq',
  );
  const layer = createAirQualityLayer({
    source: {
      definitions: [definition],
      getSnapshot: async () => {
        calls++;
        return [];
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  initAirQualityTestLayer(layer, { dataSources: { add() {}, remove() {} } });
  layer.enable();
  try {
    assert.equal(await layer.update(), true);
    assert.equal(calls, 0);
    assert.match(layer.getRowControls().summary.status, /Loading/);
  } finally {
    layer.destroy();
  }
});

test('progressive updates and rate-limit errors retry automatically; disable and destroy cancel timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const definition = createAirQualitySource().definitions.find(
    (p) => p.id === 'openaq',
  );
  for (const rateLimited of [false, true]) {
    let calls = 0;
    const layer = createAirQualityLayer({
      source: {
        definitions: [definition],
        getSnapshot: async () => {
          calls++;
          if (rateLimited && calls === 1)
            throw Object.assign(new Error('Provider request budget reached'), {
              retryAt: Date.now() + 2000,
            });
          return [];
        },
        getCoverage: () => ({
          partial: calls === 1,
          retryAt: calls === 1 ? Date.now() + 2000 : null,
        }),
      },
      overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    });
    initAirQualityTestLayer(layer, {
      dataSources: { add() {}, remove() {} },
      camera: {
        computeViewRectangle: () => ({
          west: 0,
          south: 0,
          east: 0.1,
          north: 0.1,
        }),
      },
    });
    layer.enable();
    try {
      assert.equal(await layer.update(), true);
      t.mock.timers.tick(1999);
      assert.equal(calls, 1);
      t.mock.timers.tick(102);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 2);
      calls = 0;
      await layer.update();
      layer.disable();
      t.mock.timers.tick(3000);
      assert.equal(calls, 1);
      layer.enable();
      calls = 0;
      await layer.update();
    } finally {
      layer.destroy();
    }
    t.mock.timers.tick(3000);
    assert.equal(calls, 1);
  }
});

test('navigation cancels the old view retry and only refreshes the new camera', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  let moveEnd,
    rect = { west: 0, south: 0, east: 0.1, north: 0.1 };
  const calls = [];
  const definition = createAirQualitySource().definitions.find(
    (p) => p.id === 'openaq',
  );
  const layer = createAirQualityLayer({
    source: {
      definitions: [definition],
      getSnapshot: async (request) => {
        calls.push(request.view);
        return [];
      },
      getCoverage: () => ({
        retryAt: calls.length === 1 ? Date.now() + 2000 : null,
      }),
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  initAirQualityTestLayer(layer, {
    dataSources: { add() {}, remove() {} },
    camera: {
      computeViewRectangle: () => rect,
      moveEnd: {
        addEventListener(fn) {
          moveEnd = fn;
          return () => {};
        },
      },
    },
  });
  layer.enable();
  try {
    await layer.update();
    rect = { ...rect, west: 1, east: 1.1 };
    moveEnd();
    t.mock.timers.tick(401);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2);
    assert.notDeepEqual(calls[0], calls[1]);
    t.mock.timers.tick(3000);
    assert.equal(calls.length, 2);
  } finally {
    layer.destroy();
  }
});
