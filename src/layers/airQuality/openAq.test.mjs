import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenAqLocations, normalizeOpenAqLatest } from './openAq.js';
import { createAirQualitySource } from './providers.js';
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
  assert.equal(rows[0].rating, null);
  assert.equal(rows[0].averagingMinutes, null);
  assert.equal(rows[0].licenses[0].attribution, 'Original network');
});

test('an injected provider controls source, parameters and UI without renderer edits', async () => {
  let calls = 0;
  const definition = {
    id: 'community-network',
    title: 'Community',
    label: 'Community observations',
    network: 'Community network',
    coverage: 'Regional',
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
  await source.getSnapshot();
  assert.equal(calls, 1);
  const layer = createAirQualityLayer({
    source,
    overlayHost: { setVisible() {}, clearSource() {}, setEntries() {} },
  });
  const controls = layer.getRowControls();
  assert.equal(controls.summary.settings[0].chips.length, 1);
  assert.equal(controls.summary.settings[0].chips[0].id, 'community-network');
  assert.equal(layer.setParams({ provider: 'openaq' }), false);
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
  assert.ok(!source.definitions.find((p) => p.id === 'saaqis').viewDriven);
});

test('snapshot adapter carries bounded cooldown metadata and tolerates malformed rate-limit responses', async () => {
  const { createAirQualitySnapshotSource } = await import('./providers.js');
  for (const [body, expected] of [
    [JSON.stringify({ retryAt: now + 120_000 }), now + 120_000],
    [JSON.stringify({ retryAt: now + 1e12 }), now + 24 * 3600_000],
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
