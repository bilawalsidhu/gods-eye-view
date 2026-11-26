import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOpenAqLocations,
  normalizeOpenAqLatest,
  normalizeOpenAqHours,
} from './openAq.js';
import {
  createAirQualitySnapshotSource,
  createAirQualitySource,
} from './providers.js';
import { createAirQualityLayer } from './index.js';
const now = Date.parse('2026-10-20T12:00:00Z');
const location = {
  id: 1,
  name: 'Nairobi',
  coordinates: { latitude: -1.28, longitude: 36.82 },
  country: { code: 'KE', name: 'Kenya' },
  owner: { name: 'Research network' },
  provider: { name: 'Original network' },
  sensors: [{ id: 9, parameter: { name: 'pm25', units: 'µg/m³' } }],
  licenses: [
    {
      name: 'CC BY 4.0',
      attribution: { name: 'Original network', url: 'https://example.org' },
    },
  ],
};
const latest = {
  locationsId: 1,
  sensorsId: 9,
  value: 12,
  datetime: { utc: new Date(now).toISOString() },
};

test('OpenAQ preserves source attribution and joins sensor IDs without inventing AQI', () => {
  const stations = normalizeOpenAqLocations([
    location,
    location,
    { ...location, id: 3, isMobile: true },
    { ...location, id: 2, coordinates: { latitude: null, longitude: 10 } },
  ]);
  assert.equal(stations.length, 1);
  const rows = normalizeOpenAqLatest(
    stations[0],
    [
      latest,
      latest,
      { ...latest, sensorsId: 8 },
      { ...latest, value: null },
      { ...latest, value: -1 },
      { ...latest, locationsId: 2 },
      { ...latest, datetime: { utc: '2020-01-01T00:00:00Z' } },
    ],
    now,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].parameter, 'PM2.5');
  assert.equal('rating' in rows[0], false);
  assert.equal('sensors' in rows[0], false);
  assert.equal(rows[0].averagingMinutes, null);
  assert.equal(rows[0].licenses[0].attribution, 'Original network');
});

test('OpenAQ treats only an explicitly identified monitor as a reference monitor', () => {
  for (const [metadata, expected] of [
    [{ isMonitor: true }, true],
    [{ isMonitor: false }, false],
    [{}, false],
  ]) {
    const [station] = normalizeOpenAqLocations([{ ...location, ...metadata }]);
    assert.equal(station.monitor, expected);
    const [reading] = normalizeOpenAqLatest(station, [latest], now);
    assert.equal(reading.monitor, expected);
  }
});

test('an injected provider controls source, parameters and UI without renderer edits', async () => {
  let calls = 0;
  const definition = {
    id: 'community-network',
    title: 'Community',
    label: 'Community observations',
    network: 'Community network',
    observation: true,
    parameters: ['NO2'],
    legend: [],
    source: {
      getSnapshot: async () => {
        calls++;
        return [];
      },
    },
  };
  const source = createAirQualitySource({ providers: [definition] });
  assert.equal(calls, 0);
  await source.getSnapshot({ provider: 'community-network' });
  assert.equal(calls, 1);
  const layer = createAirQualityLayer({
    source,
    overlayHost: { setVisible() {}, clearSource() {}, setEntries() {} },
  });
  // The provider's pollutants decide the views on offer: the AQI and NO2.
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.sublists.map((group) => group.tiles.map((tile) => tile.id)),
    [['aqi'], ['NO2']],
  );
  assert.equal(layer.setParams({ view: 'PM2.5' }), false);

  assert.equal(layer.setParams({ view: 'NO2' }), undefined);
  assert.equal(layer.getParams().view, 'NO2');
  assert.throws(
    () => createAirQualitySource({ providers: [definition, definition] }),
    /Invalid/,
  );
  assert.throws(() => createAirQualitySource({ providers: [] }), /requires/);
});

test('OpenAQ missing key and rejected key produce actionable setup guidance', async () => {
  for (const status of [428, 401, 403]) {
    const source = createAirQualitySource({
      fetchImpl: async () => new Response('', { status }),
    });
    await assert.rejects(source.getSnapshot({ provider: 'openaq' }), (e) =>
      status === 428
        ? e.code === 'no_key'
        : /Provider Settings/.test(e.message),
    );
  }
});

test('multiple sensors do not double-count one station and pollutant', () => {
  const station = normalizeOpenAqLocations([location])[0];
  station.sensors.push({ id: 10, parameter: 'PM2.5', units: 'µg/m³' });
  const a = { ...latest, sensorsId: 10, value: 20 };
  const b = { ...latest, sensorsId: 9, value: 10 };
  assert.deepEqual(
    normalizeOpenAqLatest(station, [a, b], now),
    normalizeOpenAqLatest(station, [b, a], now),
  );
  const result = normalizeOpenAqLatest(station, [a, b], now);
  assert.equal(result.length, 1);
  assert.equal(result[0].sensorId, 9);
});

test('injected viewport travels through the fixed snapshot route without exposing credentials', async () => {
  let request;
  const source = createAirQualitySource({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({
        schemaVersion: 1,
        stations: [],
        readings: [],
        partial: false,
      });
    },
  });
  const view = [170, -30, -170, 30, 179, 0];
  await source.getSnapshot({ provider: 'openaq', view });
  assert.equal(
    new URL(request.url, 'http://localhost').searchParams.get('view'),
    view.join(','),
  );
  assert.equal(request.options.headers, undefined);
  assert.ok(source.definitions.find((p) => p.id === 'openaq').viewDriven);
});

test('snapshot adapter carries cooldown metadata and tolerates malformed rate-limit responses', async () => {
  const { createAirQualitySnapshotSource } = await import('./providers.js');
  for (const [body, expected] of [
    [JSON.stringify({ retryAt: now + 120_000 }), now + 120_000],
    [JSON.stringify({ retryAt: now + 1e12 }), now + 1e12],
    ['upstream busy', now + 60_000],
  ]) {
    const source = createAirQualitySnapshotSource({
      endpoint: '/api/air-quality/openaq',
      now: () => now,
      fetchImpl: async () => new Response(body, { status: 429 }),
    });
    await assert.rejects(
      source.getSnapshot(),
      (error) => error.retryAt === expected,
    );
  }
});

test('providers asked in parallel keep their own coverage', async () => {
  const calls = [];
  const provider = (id, slow) => ({
    id,
    title: id,
    label: id,
    network: id,
    observation: true,
    parameters: ['PM2.5'],
    source: {
      getCoverage: () => ({ network: id }),
      async getSnapshot() {
        calls.push(id);
        await new Promise((resolve) => setTimeout(resolve, slow ? 20 : 1));
        return [{ id: `${id}:1` }];
      },
    },
  });
  const source = createAirQualitySource({
    providers: [provider('slow', true), provider('fast', false)],
  });
  const ask = () =>
    Promise.all(
      ['slow', 'fast'].map((id) =>
        source.getSnapshot({ provider: id, parameter: 'PM2.5' }),
      ),
    );
  assert.deepEqual(
    (await ask()).map((rows) => rows[0].id),
    ['slow:1', 'fast:1'],
  );
  assert.equal(source.getCoverage('slow').network, 'slow');
  assert.equal(source.getCoverage('fast').network, 'fast');
  await ask();
  assert.deepEqual(calls, ['slow', 'fast', 'slow', 'fast']);
});

test('an hourly note names the bands used: WHO-based for CO, EEA for the rest', () => {
  const now = Date.parse('2026-11-20T12:30:00Z');
  const hour = (name, units, value) => ({
    value,
    parameter: { name, units },
    period: {
      interval: '01:00:00',
      datetimeFrom: { utc: '2026-11-20T10:00:00Z' },
      datetimeTo: { utc: '2026-11-20T11:00:00Z' },
    },
    coverage: { percentCoverage: 100 },
    flagInfo: { hasFlags: false },
  });
  const note = (parameter, name, units) => {
    const sensor = { id: 9, parameter, units, name };
    const station = {
      stationId: '1',
      name: 'S',
      lat: 1,
      lon: 1,
      country: 'ZA',
      sensors: [sensor],
    };
    return normalizeOpenAqHours(station, sensor, [hour(name, units, 1)], now)[0]
      ?.note;
  };
  assert.match(note('CO', 'co', 'mg/m³') ?? '', /WHO-based pollutant bands/);
  assert.match(note('PM2.5', 'pm25', 'µg/m³') ?? '', /EEA pollutant bands/);
});

test('a viewport snapshot without a station catalogue is accepted', async () => {
  const source = createAirQualitySnapshotSource({
    endpoint: '/api/air-quality/openaq',
    hourly: true,
    fetchImpl: async () =>
      Response.json({
        schemaVersion: 1,
        readings: [],
        checked: 3,
        eligible: 10,
        partial: true,
        retryAt: Date.now() + 8000,
      }),
  });
  assert.deepEqual(
    await source.getSnapshot({
      parameter: 'PM2.5',
      view: [0, 0, 1, 1, 0.5, 0.5],
    }),
    [],
  );
  assert.equal(source.getCoverage().eligible, 10);
  // A catalogue that is there must still be a list.
  const broken = createAirQualitySnapshotSource({
    endpoint: '/x',
    fetchImpl: async () =>
      Response.json({ schemaVersion: 1, stations: {}, readings: [] }),
  });
  await assert.rejects(broken.getSnapshot(), /Malformed/);
});
