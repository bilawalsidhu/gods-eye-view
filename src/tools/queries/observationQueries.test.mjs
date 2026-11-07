import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogForSurface, composeCatalog, coreTools } from '../index.js';

const current = () => Date.now();
const station = (id, lat, lon, ageMs = 30 * 60_000, overrides = {}) => ({
  id: `eccc:${id}`,
  stationId: id,
  provider: 'eccc',
  scale: 'AQHI',
  value: 4,
  band: 'moderate',
  name: `Station ${id}`,
  lat,
  lon,
  observedMs: current() - ageMs,
  ...overrides,
});
const nearToronto = { lat: 43.65, lon: -79.38, radius_km: 70 };
const nearWarsaw = { lat: 52.23, lon: 21.01, radius_km: 50 };
const withServices = (services) =>
  composeCatalog({ tools: coreTools, services });

test('observation tools are offered on MCP but not voice (prompt budget)', () => {
  const catalog = withServices({
    airQuality: { getSnapshot: async () => [] },
    gnss: { getSnapshot: async () => ({ ageMs: 0, rows: [] }) },
  });
  for (const name of ['get_air_quality', 'get_gnss_integrity']) {
    assert.ok(catalogForSurface(catalog, 'mcp').get(name));
    assert.equal(catalogForSurface(catalog, 'voice').get(name), undefined);
  }
});

test('observation tools are excluded without their source services', () => {
  const empty = withServices({});
  assert.equal(empty.get('get_air_quality'), undefined);
  assert.equal(empty.get('get_gnss_integrity'), undefined);
});

test('air quality filters by area and returns nearest readings with the provider scale', async () => {
  const all = [
    station('far', 44.1, -79.3),
    station('near', 43.66, -79.38, 20_000, { name: 'Near\n station' }),
    station('warsaw', 52.23, 21.01),
  ];
  const result = await withServices({
    airQuality: { getSnapshot: async () => all },
  }).call('get_air_quality', { area: nearToronto });
  assert.equal(result.data.total, 2);
  assert.deepEqual(
    result.data.rows.map((r) => r.id),
    ['eccc:near', 'eccc:far'],
  );
  assert.equal(result.data.rows[0].station, 'Near station');
  assert.equal(result.data.rows[0].value, 4);
  assert.equal(result.data.rows[0].scale, 'AQHI');
  assert.equal(result.data.rows[0].risk, 'Moderate health risk');
  assert.equal(result.data.stale, false);
  assert.match(result.data.coverage, /Canada only/);
});

test('air-quality scope and limit never imply nationwide zero when region is empty', async () => {
  const result = await withServices({
    airQuality: {
      getSnapshot: async () => [station('toronto', 43.65, -79.38)],
    },
  }).call('get_air_quality', { area: nearWarsaw });
  assert.equal(result.data.total, 0);
  assert.match(result.summary, /does not establish clean air/);
  assert.match(result.summary, /Canada only/);
});

test('air-quality excludes old, future, malformed and unknown-provider readings', async () => {
  const result = await withServices({
    airQuality: {
      getSnapshot: async () => [
        station('fresh', 43.65, -79.38),
        station('old', 43.65, -79.38, 7 * 60 * 60_000),
        station('future', 43.65, -79.38, -120_000),
        station('foreign', 43.65, -79.38, 0, { provider: 'unknown' }),
        station('missing', 43.65, -79.38, 0, { lat: Number.NaN }),
      ],
    },
  }).call('get_air_quality', { area: nearToronto });
  assert.equal(result.data.total, 1);
  assert.equal(result.data.rows[0].id, 'eccc:fresh');
});

test('air-quality reports a stale upstream snapshot without presenting it as live', async () => {
  const result = await withServices({
    airQuality: {
      getSnapshot: async () => [
        station('lagged', 43.65, -79.38, 3 * 60 * 60_000),
      ],
    },
  }).call('get_air_quality', { area: nearToronto });
  assert.equal(result.data.stale, true);
  assert.match(result.summary, /stale/);
});

test('air-quality freshness is measured within the requested area', async () => {
  const result = await withServices({
    airQuality: {
      getSnapshot: async () => [
        station('toronto', 43.65, -79.38, 3 * 60 * 60_000),
        station('vancouver', 49.28, -123.12, 30_000),
      ],
    },
  }).call('get_air_quality', { area: nearToronto });
  assert.equal(result.data.total, 1);
  assert.equal(result.data.stale, true);
  assert.match(result.summary, /stale/);
});

test('air-quality rows are limited without hiding the total', async () => {
  const all = Array.from({ length: 10 }, (_, i) =>
    station(String(i), 43.65 + i / 1000, -79.38),
  );
  const result = await withServices({
    airQuality: { getSnapshot: async () => all },
  }).call('get_air_quality', { area: nearToronto, limit: 3 });
  assert.equal(result.data.total, 10);
  assert.equal(result.data.returned, 3);
  assert.equal(result.data.truncated, true);
});

test('air-quality malformed snapshot fails rather than pretending no readings', async () => {
  await assert.rejects(
    withServices({ airQuality: { getSnapshot: async () => null } }).call(
      'get_air_quality',
      { area: nearToronto },
    ),
    (error) => error.code === 'malformed',
  );
});

const gnssRow = (hex, degraded, lat = 51.5, lon = -0.1) => ({
  hex,
  degraded,
  lat,
  lon,
});

test('GNSS uses the layer classifier and labels abnormal accuracy without saying jammed', async () => {
  const rows = [
    gnssRow('abc001', true),
    gnssRow('abc002', true),
    gnssRow('abc003', false),
  ];
  let received;
  const result = await withServices({
    gnss: {
      async getSnapshot(anchor) {
        received = anchor;
        return { ageMs: 5000, rows, classifier: 'gev-nic-nacp-v2' };
      },
    },
  }).call('get_gnss_integrity', { location: { lat: 51.5, lon: -0.1 } });
  assert.deepEqual(received, { latitude: 51.5, longitude: -0.1 });
  assert.equal(result.data.total, 1);
  assert.equal(result.data.rows[0].level, 'high');
  assert.equal(result.data.rows[0].aircraft, 3);
  assert.equal(result.data.rows[0].degraded, 2);
  assert.equal(result.data.anomaly_cells, 1);
  assert.match(result.summary, /does not prove GNSS interference/);
  assert.equal(result.data.provenance.classifier.validated, false);
});

test('GNSS small samples cannot prove normal operation', async () => {
  const result = await withServices({
    gnss: {
      getSnapshot: async () => ({
        ageMs: 100,
        rows: [gnssRow('abc001', false), gnssRow('abc002', false)],
      }),
    },
  }).call('get_gnss_integrity', { location: { lat: 51.5, lon: -0.1 } });
  assert.equal(result.data.total, 0);
  assert.match(result.summary, /does not establish normal GPS operation/);
});

test('GNSS stale input cannot produce a live assessment', async () => {
  const result = await withServices({
    gnss: {
      getSnapshot: async () => ({
        ageMs: 40 * 60_000,
        stale: true,
        rows: Array.from({ length: 3 }, (_, i) =>
          gnssRow(`abc00${i + 1}`, true),
        ),
      }),
    },
  }).call('get_gnss_integrity', { location: { lat: 51.5, lon: -0.1 } });
  assert.equal(result.data.stale, true);
  assert.equal(result.data.total, 0);
  assert.match(result.summary, /no current assessment/);
});

test('GNSS ignores malformed rows and counts repeated aircraft once per cell', async () => {
  const result = await withServices({
    gnss: {
      getSnapshot: async () => ({
        ageMs: 0,
        rows: [
          gnssRow('abc001', true),
          gnssRow('abc001', true),
          gnssRow('abc002', false),
          gnssRow('abc003', true),
          gnssRow('badhex!', true),
          { hex: 'abc004', lat: null, lon: -0.1, degraded: true },
        ],
      }),
    },
  }).call('get_gnss_integrity', { location: { lat: 51.5, lon: -0.1 } });
  assert.equal(result.data.total, 1);
  assert.equal(result.data.rows[0].aircraft, 3);
});

test('GNSS rejects malformed timestamps and validates tool arguments', async () => {
  const catalog = withServices({
    gnss: { getSnapshot: async () => ({ ageMs: -1, rows: [] }) },
  });
  await assert.rejects(
    catalog.call('get_gnss_integrity', { location: { lat: 51.5, lon: -0.1 } }),
    (error) => error.code === 'malformed',
  );
  await assert.rejects(
    catalog.call('get_gnss_integrity', {
      location: { lat: 51.5, lon: -0.1 },
      limit: 1000,
    }),
    (error) => error.code === 'invalid_arguments',
  );
  await assert.rejects(
    catalog.call('get_air_quality', { area: nearToronto }),
    (error) => error.code === 'unsupported',
  );
});
