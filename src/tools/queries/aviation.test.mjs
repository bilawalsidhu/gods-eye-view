import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';
import { LiveSourceError } from '../../sources/live/contract.js';

const record = (id, latitude, longitude, extra = {}) => ({
  id,
  reference: id,
  latitude,
  longitude,
  callsign: null,
  originCountry: null,
  positionTimeMs: Date.UTC(2026, 0, 1),
  contactTimeMs: Date.UTC(2026, 0, 1, 0, 0, 5),
  baroAltitudeM: 10000,
  ellipsoidAltitudeM: null,
  onGround: false,
  speedMps: 230.04,
  courseDeg: 90.4,
  verticalRateMps: 0,
  category: null,
  typeCode: null,
  registration: null,
  operator: null,
  ...extra,
});
const snapshot = (records, extra = {}) => ({
  records,
  complete: true,
  source: 'Test feed',
  coverage: 'test coverage',
  observedAtMs: Date.UTC(2026, 0, 1),
  freshness: 'current',
  ...extra,
});
const feed = (records, { track = [], enrichment = {}, ...extra } = {}) => {
  const calls = [];
  return {
    calls,
    async getSnapshot(query) {
      calls.push(query);
      return snapshot(records, extra);
    },
    async getTrack(reference) {
      calls.push(reference);
      return { records: track, complete: false };
    },
    async getEnrichment({ kind, id }) {
      calls.push(`${kind}:${id}`);
      return enrichment[`${kind}:${id}`] ?? { found: false };
    },
  };
};
const civil = [
  record('aaa111', 37.7, -122.4, {
    callsign: 'UAL123',
    originCountry: 'United States',
  }),
  record('bbb222', 37.58, -122.28, { onGround: true, baroAltitudeM: 0 }),
  record('ccc333', 51.5, -0.1, { callsign: 'BAW1' }),
];
const military = [
  record('ae0001', 37.6, -122.3, {
    callsign: 'RCH123',
    registration: '07-7175',
    typeCode: 'C17',
  }),
];
const bay = { lat: 37.6, lon: -122.3, radius_km: 60 };

test('aircraft in an area are filtered, nearest first, with source details', async () => {
  const aircraft = feed(civil);
  const catalog = composeCatalog({ tools: coreTools, services: { aircraft } });
  const result = await catalog.call('aircraft_in_area', { area: bay });
  assert.equal(result.summary, '2 aircraft in 60 km around 37.600, -122.300.');
  assert.deepEqual(
    result.data.rows.map((row) => row.id),
    ['bbb222', 'aaa111'],
  );
  assert.deepEqual(aircraft.calls[0], { latitude: 37.6, longitude: -122.3 });
  assert.deepEqual(result.data.rows[1], {
    id: 'aaa111',
    callsign: 'UAL123',
    lat: 37.7,
    lon: -122.4,
    altitude_m: 10000,
    on_ground: false,
    speed_mps: 230,
    course_deg: 90,
    vertical_rate_mps: 0,
    type_code: null,
    registration: null,
    operator: null,
    origin_country: 'United States',
    last_contact: '2026-01-01T00:00:05.000Z',
    distance_km: 14.2,
  });
  assert.equal(result.data.source, 'Test feed');
  assert.equal(result.data.observed_at, '2026-01-01T00:00:00.000Z');

  const airborne = await catalog.call('aircraft_in_area', {
    area: bay,
    airborne_only: true,
  });
  assert.deepEqual(
    airborne.data.rows.map((row) => row.id),
    ['aaa111'],
  );
  const low = await catalog.call('aircraft_in_area', {
    area: bay,
    max_altitude_m: 100,
  });
  assert.deepEqual(
    low.data.rows.map((row) => row.id),
    ['bbb222'],
  );
});

test('the military feed is used on request and reported when missing', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      aircraft: feed(civil),
      military: feed(military, { freshness: 'stale' }),
    },
  });
  const result = await catalog.call('aircraft_in_area', {
    area: bay,
    military: true,
  });
  assert.equal(
    result.summary,
    '1 military aircraft in 60 km around 37.600, -122.300 (data may be stale).',
  );
  assert.equal(result.data.rows[0].registration, '07-7175');
  const civilOnly = composeCatalog({
    tools: coreTools,
    services: { aircraft: feed(civil) },
  });
  await assert.rejects(
    civilOnly.call('aircraft_in_area', { area: bay, military: true }),
    (error) => error.code === 'unsupported',
  );
});

test('aircraft are found by exactly one identifier across feeds', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { aircraft: feed(civil), military: feed(military) },
  });
  const byCallsign = await catalog.call('find_aircraft', {
    callsign: 'ual123',
  });
  assert.equal(byCallsign.summary, 'Found 1 aircraft with callsign UAL123.');
  assert.deepEqual(
    byCallsign.data.rows.map((row) => row.id),
    ['aaa111'],
  );
  assert.equal(byCallsign.data.rows[0].distance_km, undefined);
  const byRegistration = await catalog.call('find_aircraft', {
    registration: '07-7175',
  });
  assert.deepEqual(
    byRegistration.data.rows.map((row) => row.id),
    ['ae0001'],
  );
  const none = await catalog.call('find_aircraft', { icao24: 'ABCDEF' });
  assert.equal(
    none.summary,
    'No aircraft with icao24 ABCDEF is currently reported.',
  );
  await assert.rejects(catalog.call('find_aircraft', {}), /exactly one/);
  await assert.rejects(
    catalog.call('find_aircraft', { callsign: 'UAL123', icao24: 'aaa111' }),
    /exactly one/,
  );
  await assert.rejects(
    catalog.call('find_aircraft', { icao24: 'xyz' }),
    /must match/,
  );
});

test('tracks are ordered and thinned to 200 points', async () => {
  const start = Date.UTC(2026, 0, 1);
  const track = Array.from({ length: 450 }, (_, index) => ({
    latitude: 37 + index / 1000,
    longitude: -122,
    observedAtMs: start + (449 - index) * 1000,
    baroAltitudeM: 1000,
    onGround: false,
  }));
  const aircraft = feed(civil, { track });
  const catalog = composeCatalog({ tools: coreTools, services: { aircraft } });
  const result = await catalog.call('get_aircraft_track', { icao24: 'AAA111' });
  assert.equal(aircraft.calls[0], 'aaa111');
  assert.equal(
    result.summary,
    '450 positions for aaa111 from 2026-01-01T00:00:00.000Z to 2026-01-01T00:07:29.000Z.',
  );
  assert.deepEqual(
    {
      total: result.data.total,
      returned: result.data.returned,
      thinned: result.data.thinned,
    },
    { total: 450, returned: 200, thinned: true },
  );
  assert.equal(result.data.points[0].time, '2026-01-01T00:00:00.000Z');
  assert.equal(result.data.points.at(-1).time, '2026-01-01T00:07:29.000Z');
  const empty = composeCatalog({
    tools: coreTools,
    services: { aircraft: feed(civil) },
  });
  assert.equal(
    (await empty.call('get_aircraft_track', { icao24: 'aaa111' })).summary,
    'No recent track is available for aaa111.',
  );
  const failing = (status) => ({
    getSnapshot: async () => snapshot([]),
    getTrack: async () => {
      throw new LiveSourceError('unavailable', `OpenSky HTTP ${status}`, {
        status,
      });
    },
  });
  const unknown = composeCatalog({
    tools: coreTools,
    services: { aircraft: failing(404) },
  });
  assert.equal(
    (await unknown.call('get_aircraft_track', { icao24: 'abcdef' })).summary,
    'No recent track is available for abcdef.',
  );
  const down = composeCatalog({
    tools: coreTools,
    services: { aircraft: failing(502) },
  });
  await assert.rejects(
    down.call('get_aircraft_track', { icao24: 'abcdef' }),
    (error) => error.code === 'unavailable',
  );
});

test('aircraft info combines type and route lookups', async () => {
  const aircraft = feed(civil, {
    enrichment: {
      'type:aaa111': {
        found: true,
        typeCode: 'B738',
        typeName: 'Boeing 737-800',
        registration: 'N12345',
      },
      'route:UAL123': {
        found: true,
        airline: 'United Airlines',
        origin: { code: 'SFO', name: 'San Francisco', lat: 37.6, lon: -122.4 },
        destination: { code: 'EWR', name: 'Newark', lat: 40.7, lon: -74.2 },
      },
    },
  });
  const catalog = composeCatalog({ tools: coreTools, services: { aircraft } });
  const both = await catalog.call('get_aircraft_info', {
    icao24: 'AAA111',
    callsign: 'ual123',
  });
  assert.equal(
    both.summary,
    'Aircraft aaa111 is Boeing 737-800 (N12345); flight UAL123 flies SFO to EWR (United Airlines).',
  );
  assert.equal(both.data.route.destination.name, 'Newark');
  const unknown = await catalog.call('get_aircraft_info', { callsign: 'XYZ9' });
  assert.equal(unknown.summary, 'No route is known for XYZ9.');
  assert.deepEqual(unknown.data, { aircraft: null, route: null });
  await assert.rejects(
    catalog.call('get_aircraft_info', {}),
    /icao24, callsign or both/,
  );
});

test('live source failures become tool errors with retry guidance', async () => {
  const limited = {
    getSnapshot: async () => {
      throw new LiveSourceError('limited', 'OpenSky rate limited', {
        retryAfterMs: 45000,
      });
    },
  };
  const catalog = composeCatalog({
    tools: coreTools,
    services: { aircraft: limited },
  });
  await assert.rejects(
    catalog.call('aircraft_in_area', { area: bay }),
    (error) =>
      error.name === 'ToolError' &&
      error.code === 'retry_later' &&
      error.retryAfterSeconds === 45 &&
      error.message === 'OpenSky rate limited',
  );
});

test('aircraft searches keep the feeds that answered and name the others', async () => {
  const down = {
    getSnapshot: async () => {
      throw new LiveSourceError('unavailable', 'OpenSky HTTP 503');
    },
  };
  const military = feed([
    record('ae1234', 38, -77, { callsign: 'RCH123', registration: '05-5140' }),
  ]);
  const catalog = composeCatalog({
    tools: coreTools,
    services: { aircraft: down, military },
  });
  const byCallsign = await catalog.call('find_aircraft', {
    callsign: 'rch123',
  });
  assert.equal(
    byCallsign.summary,
    'Found 1 aircraft with callsign RCH123. The civil feed did not answer.',
  );
  assert.deepEqual(byCallsign.data.unavailable_feeds, ['civil']);
  const civil = feed([]);
  const byRegistration = await composeCatalog({
    tools: coreTools,
    services: { aircraft: civil, military },
  }).call('find_aircraft', { registration: '05-5140' });
  assert.equal(byRegistration.data.rows[0].id, 'ae1234');
  assert.deepEqual(byRegistration.data.unavailable_feeds, []);
  assert.equal(civil.calls.length, 0);
  await assert.rejects(
    composeCatalog({
      tools: coreTools,
      services: { aircraft: down, military: down },
    }).call('find_aircraft', { callsign: 'RCH123' }),
    (error) =>
      error.code === 'unavailable' && error.message === 'OpenSky HTTP 503',
  );
});

test('a regional fallback feed is named in the answer', async () => {
  const regional = feed([record('abc123', 37.6, -122.3)], {
    source: 'adsb.lol',
    coverage: '250nm regional fallback',
  });
  const result = await composeCatalog({
    tools: coreTools,
    services: { aircraft: regional },
  }).call('aircraft_in_area', {
    area: { lat: 37.6, lon: -122.3, radius_km: 20 },
  });
  assert.match(result.summary, /\(regional feed: 250nm regional fallback\)\.$/);
});

test('aircraft searches say when a feed that answered is stale', async () => {
  const stale = feed([], { freshness: 'stale' });
  const result = await composeCatalog({
    tools: coreTools,
    services: { aircraft: stale, military: feed([]) },
  }).call('find_aircraft', { callsign: 'UAL1' });
  assert.equal(
    result.summary,
    'No aircraft with callsign UAL1 is currently reported. The civil feed data may be stale.',
  );
  assert.deepEqual(result.data.stale_feeds, ['civil']);
  assert.deepEqual(
    result.data.feeds.map((entry) => [entry.feed, entry.freshness]),
    [
      ['civil', 'stale'],
      ['military', 'current'],
    ],
  );
});

test('the real OpenSky source marks an hour-old snapshot stale for searches', async () => {
  const { createFlightSource } =
    await import('../../sources/live/standalone.js');
  const now = Date.UTC(2026, 0, 1, 12);
  const opensky = createFlightSource({
    now: () => now,
    fetchImpl: async () =>
      Response.json({ time: now / 1000 - 3600, states: [] }),
  });
  const result = await composeCatalog({
    tools: coreTools,
    services: { aircraft: opensky },
  }).call('find_aircraft', { callsign: 'UAL1' });
  assert.deepEqual(result.data.stale_feeds, ['civil']);
  assert.match(result.summary, /may be stale\.$/);
});
