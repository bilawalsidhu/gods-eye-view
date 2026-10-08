import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';
import { LiveSourceError } from '../../sources/live/contract.js';
import { createVesselSource } from '../../sources/live/standalone.js';
import { AISSTREAM_CACHE_MAX } from '../../../server/providers/vessels/ais-store.js';

const vessel = (id, latitude, longitude, extra = {}) => ({
  id,
  reference: id,
  latitude,
  longitude,
  name: `SHIP ${id}`,
  imo: '',
  type: 'Cargo',
  destination: '',
  speedMps: 6.17,
  courseDeg: 181.2,
  headingDeg: 180,
  observedAtMs: Date.UTC(2026, 0, 1),
  altitudeDatum: 'sea-surface',
  ...extra,
});
const records = [
  vessel('366999712', 37.81, -122.41, {
    name: 'GOLDEN BEAR',
    imo: '9123456',
    type: 'Passenger',
  }),
  vessel('538001234', 37.75, -122.3, {
    name: 'PACIFIC TRADER',
    imo: 'IMO7654321',
    type: 'Tanker',
    destination: 'OAKLAND',
  }),
  vessel('235000001', 51.5, 1.5),
];
const vessels = (extra = {}) => ({
  async getSnapshot() {
    return {
      records,
      source: 'AISStream',
      coverage: 'received AIS positions',
      observedAtMs: Date.UTC(2026, 0, 1),
      freshness: 'current',
      ...extra,
    };
  },
  async getTrack(mmsi) {
    return {
      records: [
        {
          latitude: 37.8,
          longitude: -122.4,
          observedAtMs: Date.UTC(2026, 0, 1, 1),
        },
        {
          latitude: 37.7,
          longitude: -122.5,
          observedAtMs: Date.UTC(2026, 0, 1, 0),
        },
        { latitude: 37.6, longitude: -122.6, observedAtMs: null },
      ].filter(() => mmsi === '366999712'),
      complete: false,
    };
  },
});
const bay = { lat: 37.78, lon: -122.4, radius_km: 20 };

test('vessels in an area are nearest first and filterable by type', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { vessels: vessels() },
  });
  const all = await catalog.call('vessels_in_area', { area: bay });
  assert.equal(all.summary, '2 vessels in 20 km around 37.780, -122.400.');
  assert.deepEqual(
    all.data.rows.map((row) => row.mmsi),
    ['366999712', '538001234'],
  );
  assert.deepEqual(all.data.rows[0], {
    mmsi: '366999712',
    name: 'GOLDEN BEAR',
    imo: '9123456',
    type: 'Passenger',
    destination: null,
    lat: 37.81,
    lon: -122.41,
    speed_mps: 6.2,
    course_deg: 181,
    heading_deg: 180,
    observed_at: '2026-01-01T00:00:00.000Z',
    distance_km: 3.4,
  });
  assert.equal(all.data.source, 'AISStream');
  const tankers = await catalog.call('vessels_in_area', {
    area: bay,
    type: 'tanker',
  });
  assert.equal(
    tankers.summary,
    '1 tanker vessel in 20 km around 37.780, -122.400.',
  );
  const stale = composeCatalog({
    tools: coreTools,
    services: { vessels: vessels({ freshness: 'stale' }) },
  });
  assert.match(
    (await stale.call('vessels_in_area', { area: bay })).summary,
    /\(data may be stale\)\.$/,
  );
});

test('vessels are found by exactly one identifier', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { vessels: vessels() },
  });
  assert.deepEqual(
    (await catalog.call('find_vessel', { mmsi: '366999712' })).data.rows.map(
      (row) => row.name,
    ),
    ['GOLDEN BEAR'],
  );
  assert.deepEqual(
    (await catalog.call('find_vessel', { imo: '7654321' })).data.rows.map(
      (row) => row.mmsi,
    ),
    ['538001234'],
  );
  const byName = await catalog.call('find_vessel', { name: 'trader' });
  assert.equal(byName.summary, 'Found 1 vessel with name trader.');
  assert.equal(
    (await catalog.call('find_vessel', { mmsi: '99999' })).summary,
    'No vessel with mmsi 99999 is currently reported.',
  );
  await assert.rejects(
    catalog.call('find_vessel', { mmsi: '366999712', name: 'xy' }),
    /exactly one/,
  );
  await assert.rejects(
    catalog.call('find_vessel', { mmsi: 'abc' }),
    /must match/,
  );
});

test('vessel tracks are ordered and drop untimed positions', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { vessels: vessels() },
  });
  const track = await catalog.call('get_vessel_track', { mmsi: '366999712' });
  assert.equal(
    track.summary,
    '2 positions for 366999712 from 2026-01-01T00:00:00.000Z to 2026-01-01T01:00:00.000Z.',
  );
  assert.deepEqual(
    track.data.points.map((point) => point.lat),
    [37.7, 37.8],
  );
  assert.equal(
    (await catalog.call('get_vessel_track', { mmsi: '235000001' })).summary,
    'No recent track is available for 235000001.',
  );
});

test('a missing AIS key surfaces as an unavailable feed', async () => {
  const keyless = {
    getSnapshot: async () => {
      throw new LiveSourceError('unavailable', 'AISSTREAM_API_KEY not set');
    },
  };
  const catalog = composeCatalog({
    tools: coreTools,
    services: { vessels: keyless },
  });
  await assert.rejects(
    catalog.call('vessels_in_area', { area: bay }),
    (error) =>
      error.code === 'unavailable' &&
      error.message === 'AISSTREAM_API_KEY not set',
  );
});

test('vessel searches ask for every vessel the server retains', async () => {
  const requested = [];
  const source = createVesselSource({
    origin: () => 'http://localhost',
    fetchImpl: async (url) => {
      requested.push(new URL(url).searchParams.get('maxRows'));
      return Response.json({ rows: [], source: 'AISStream', status: 'live' });
    },
  });
  const catalog = composeCatalog({
    tools: coreTools,
    services: { vessels: source },
  });
  await catalog.call('find_vessel', { mmsi: '366999712' });
  await catalog.call('vessels_in_area', { area: bay });
  assert.equal(requested.length, 2);
  for (const maxRows of requested)
    assert.ok(Number(maxRows) >= AISSTREAM_CACHE_MAX, maxRows);
});

test('an area search names its area to the server; a vessel lookup asks for every vessel', async () => {
  const requested = [];
  const source = createVesselSource({
    origin: () => 'http://localhost',
    fetchImpl: async (url) => {
      requested.push(new URL(url).searchParams);
      return Response.json({ rows: [], source: 'AISStream', status: 'live' });
    },
  });
  const catalog = composeCatalog({
    tools: coreTools,
    services: { vessels: source },
  });
  await catalog.call('vessels_in_area', { area: bay });
  await catalog.call('find_vessel', { mmsi: '366999712' });
  const [area, lookup] = requested;
  assert.equal(area.get('lat'), '37.78000');
  assert.equal(area.get('lon'), '-122.40000');
  assert.equal(area.get('radius_km'), '20.0');
  assert.equal(lookup.has('lat'), false);
  assert.equal(lookup.has('radius_km'), false);
});
