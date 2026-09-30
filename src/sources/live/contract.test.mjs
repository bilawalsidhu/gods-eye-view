import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenSkySource,
  createAdsbLolSource,
  createAeroApiSource,
  createAisStreamSource,
  normalizeReadsbAircraft,
  normalizeVesselObservation,
  normalizeAeroApiTrack,
  openSkySnapshot,
  readsbSnapshot,
} from './index.js';
import { composeSource } from './contract.js';

const now = 1800000000000;
const aircraft = [
  'AbC123',
  'TEST',
  'Example',
  now / 1000 - 15,
  now / 1000 - 2,
  -97,
  30,
  1000,
  false,
  100,
  250,
  -2,
  null,
  1040,
];
const response = (payload, headers = {}, status = 200) =>
  Response.json(payload, { headers, status });

test('civil observations retain identity, separate altitude datums and source epochs', () => {
  const snapshot = openSkySnapshot(
    { time: now / 1000 - 130, states: [aircraft] },
    { now, source: 'Test source', coverage: 'regional' },
  );
  const row = snapshot.records[0];
  assert.equal(row.id, 'abc123');
  assert.equal(row.baroAltitudeM, 1000);
  assert.equal(row.ellipsoidAltitudeM, 1040);
  assert.equal(row.positionTimeMs, now - 15000);
  assert.equal(row.contactTimeMs, now - 2000);
  assert.equal(snapshot.ageMs, 130000);
  assert.equal(snapshot.freshness, 'stale');
  assert.equal(snapshot.coverage, 'regional');
  const missing = openSkySnapshot(
    { states: [[...aircraft.slice(0, 3), null, null, ...aircraft.slice(5)]] },
    { now },
  );
  assert.equal(missing.observedAtMs, null);
  assert.equal(missing.freshness, 'unknown');
  assert.equal(missing.records[0].positionTimeMs, null);
});

test('mixed-invalid and duplicate admissions are explicitly incomplete; all-invalid rejects', () => {
  const invalid = [...aircraft];
  invalid[5] = 181;
  const partial = openSkySnapshot({ states: [aircraft, invalid, aircraft] });
  assert.equal(partial.records.length, 1);
  assert.equal(partial.complete, false);
  assert.equal(partial.rejectedCount, 2);
  assert.throws(() => openSkySnapshot({ states: [invalid] }), {
    code: 'malformed',
  });
  assert.throws(() => openSkySnapshot({}), { code: 'malformed' });
  assert.equal(openSkySnapshot({ states: [] }).complete, true);
});

test('readsb units and position/contact ages are normalized once against the source epoch', () => {
  const row = normalizeReadsbAircraft(
    {
      hex: 'abc123',
      lat: '30',
      lon: '-97',
      alt_baro: 10000,
      alt_geom: 10100,
      gs: 120,
      baro_rate: -600,
      seen: 2,
      seen_pos: 12,
    },
    now,
  );
  assert.equal(row.baroAltitudeM, 3048);
  assert.equal(row.ellipsoidAltitudeM, 3078.48);
  assert.equal(row.speedMps, 120 * 0.514444);
  assert.equal(row.verticalRateMps, -600 * 0.00508);
  assert.equal(row.positionTimeMs, now - 12000);
  assert.equal(row.contactTimeMs, now - 2000);
  const ground = normalizeReadsbAircraft(
    { hex: 'abc123', lat: 30, lon: -97, alt_baro: 'ground' },
    null,
  );
  assert.equal(ground.onGround, true);
  assert.equal(ground.baroAltitudeM, null);
  assert.equal(ground.positionTimeMs, null);
  assert.equal(
    readsbSnapshot({ ac: [] }, { observedAtMs: null }).freshness,
    'unknown',
  );
});

test('vessel identity, opaque reference and heading/course remain distinct, unknowns stay null', () => {
  const row = normalizeVesselObservation(
    {
      mmsi: '123456789',
      lat: 30,
      lon: -97,
      speed: 10,
      heading: 45,
      course: 60,
      last_position_epoch: now / 1000,
      extra: 'discard',
    },
    'opaque-reference',
  );
  assert.equal(row.id, '123456789');
  assert.equal(row.reference, 'opaque-reference');
  assert.equal(row.headingDeg, 45);
  assert.equal(row.courseDeg, 60);
  assert.equal(row.speedMps, 10 * 0.514444);
  assert.equal(row.altitudeDatum, 'sea-surface');
  assert.equal(row.observedAtMs, now);
  assert.equal('extra' in row, false);
  assert.equal(
    normalizeVesselObservation({ mmsi: 'x', lat: null, lon: null }),
    null,
  );
});

test('construction is inert; adapters preserve routes, viewport query, cache epoch and history datum', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.startsWith('/api/opensky?'))
      return response(
        { time: now / 1000, states: [aircraft] },
        {
          'x-flight-source': 'adsb.lol',
          'x-flight-coverage': '250 nm regional',
        },
      );
    if (url.startsWith('/api/opensky-track'))
      return response({ path: [[now / 1000 - 30, 30, -97, 1000, 45, false]] });
    if (url === '/api/adsblol/mil')
      return response(
        { ac: [{ hex: 'abc123', lat: 30, lon: -97, seen_pos: 15 }] },
        { 'x-ads-b-cache-age-ms': '60000', 'x-ads-b-cache': 'STALE' },
      );
    return response({
      timestamp: now / 1000 - 60,
      trace: [[10, 30, -97, 1000]],
    });
  };
  const civil = createOpenSkySource({ fetchImpl, now: () => now });
  const military = createAdsbLolSource({ fetchImpl, now: () => now });
  assert.equal(requests.length, 0);
  const signal = new AbortController().signal;
  const snapshot = await civil.getSnapshot(
    { latitude: 30.123456, longitude: -97 },
    { signal },
  );
  assert.equal(requests[0].url, '/api/opensky?lat=30.1235&lon=-97.0000');
  assert.equal(requests[0].init.signal, signal);
  assert.equal(snapshot.source, 'adsb.lol');
  assert.equal(snapshot.coverage, '250 nm regional');
  assert.equal((await civil.getTrack('abc123')).records[0].baroAltitudeM, 1000);
  const mil = await military.getSnapshot();
  assert.equal(mil.observedAtMs, now - 60000);
  assert.equal(mil.records[0].positionTimeMs, now - 75000);
  assert.equal(mil.stale, true);
  const track = await military.getTrack('abc123');
  assert.equal(track.complete, false);
  assert.equal(track.records[0].observedAtMs, now - 50000);
  assert.equal(track.records[0].baroAltitudeM, 304.8);
  assert.equal(track.records[0].ellipsoidAltitudeM, null);
});

test('cancellation after slow body parsing rejects even with a transport that ignores abort', async () => {
  let release;
  const controller = new AbortController();
  const source = createOpenSkySource({
    fetchImpl: async () => ({
      ok: true,
      json: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    }),
  });
  const pending = source.getSnapshot({}, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  release({ states: [aircraft] });
  await assert.rejects(pending, { name: 'AbortError' });
});

test('denials and outages never start another source and do not echo arbitrary response bodies', async () => {
  for (const status of [401, 403, 429, 502]) {
    let calls = 0;
    const source = createOpenSkySource({
      fetchImpl: async () => {
        calls++;
        return response({ error: 'sensitive upstream detail' }, {}, status);
      },
    });
    await assert.rejects(source.getSnapshot(), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.message.includes('sensitive'), false);
      assert.ok(error.retryAfterMs >= 20000);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('AIS reports limited received coverage and keeps connection state separate from positions', async () => {
  const source = createAisStreamSource({
    origin: () => 'http://example.test',
    fetchImpl: async (url) => {
      if (url.includes('/track?'))
        return response({ samples: [{ lat: 30, lon: -97, t: now / 1000 }] });
      assert.equal(url, 'http://example.test/api/ais-live?maxRows=500');
      return response({
        status: 'reconnecting',
        refreshing: true,
        rows: [
          {
            mmsi: '123456789',
            lat: 30,
            lon: -97,
            last_position_UTC: new Date(now).toISOString(),
          },
        ],
        newestPositionAt: new Date(now).toISOString(),
      });
    },
  });
  const snapshot = await source.getSnapshot({ maxRows: 500 });
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.observedAtMs, now);
  assert.equal(snapshot.transportStatus, 'reconnecting');
  assert.equal(
    (await source.getTrack('123456789')).records[0].observedAtMs,
    now,
  );
});

test('a malformed vessel row cannot prevent admission of valid positions', async () => {
  const source = createAisStreamSource({
    fetchImpl: async () =>
      response({
        status: 'live',
        rows: [null, { mmsi: '123456789', lat: 30, lon: -97 }],
      }),
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.rejectedCount, 1);
  assert.equal(snapshot.complete, false);
});

test('out-of-range source epochs do not reach Date or globe time constructors', () => {
  const row = [...aircraft];
  row[3] = 1e100;
  row[4] = 1e100;
  const snapshot = openSkySnapshot({ time: 1e100, states: [row] });
  assert.equal(snapshot.observedAtMs, null);
  assert.equal(snapshot.records[0].positionTimeMs, null);
  assert.equal(snapshot.records[0].contactTimeMs, null);
});

test('classification identities include positionless aircraft without admitting them to rendering', async () => {
  const source = createAdsbLolSource({
    fetchImpl: async () =>
      response({
        ac: [
          { hex: ' ABC123 ' },
          { hex: 'abc123' },
          { hex: 'def456', lat: 30, lon: -97 },
        ],
      }),
  });
  assert.deepEqual(await source.getIdentities(), ['abc123', 'def456']);
  const snapshot = await source.getSnapshot();
  assert.deepEqual(
    snapshot.records.map((record) => record.id),
    ['def456'],
  );
  assert.equal(snapshot.complete, false);
});

test('identity lookup validates its response and honors body-parse cancellation', async () => {
  const malformed = createAdsbLolSource({
    fetchImpl: async () => response({ ac: [{}] }),
  });
  await assert.rejects(malformed.getIdentities(), /Malformed/);
  const abort = new AbortController();
  const source = createAdsbLolSource({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      async json() {
        abort.abort();
        return { ac: [{ hex: 'abc123' }] };
      },
    }),
  });
  await assert.rejects(source.getIdentities({}, { signal: abort.signal }), {
    name: 'AbortError',
  });
});

test('AeroAPI track rows normalize to the shared contract with dedupe and delta rejection', () => {
  const payload = {
    positions: [
      {
        timestamp: '2026-09-16T12:00:00Z',
        latitude: 30,
        longitude: -97,
        altitude: 100,
        update_type: 'A',
      },
      // Same 90 s window + same rounded coords: a duplicate receiver report.
      {
        timestamp: '2026-09-16T12:00:30Z',
        latitude: 30.0001,
        longitude: -97.0001,
        altitude: 101,
        update_type: 'A',
      },
      // Delta rows are waypoint summaries, not observations.
      {
        timestamp: '2026-09-16T12:01:00Z',
        latitude: 31,
        longitude: -97,
        delta: true,
      },
      // Surface position: altitude 0, on-ground flagged.
      {
        timestamp: '2026-09-16T12:02:00Z',
        latitude: 31,
        longitude: -98,
        altitude: 0,
        update_type: 'X',
      },
      // Invalid rows never admit.
      { latitude: 31, longitude: -98, altitude: 0 },
      {
        timestamp: '2026-09-16T12:03:00Z',
        latitude: 200,
        longitude: -98,
      },
    ],
  };
  const records = normalizeAeroApiTrack(payload);
  assert.equal(records.length, 2);
  assert.equal(records[0].observedAtMs, Date.parse('2026-09-16T12:00:00Z'));
  assert.ok(Math.abs(records[0].baroAltitudeM - 3048) < 1e-6);
  assert.equal(records[0].onGround, false);
  assert.equal(records[1].onGround, true);
  assert.equal(records[1].baroAltitudeM, 0);
  // Malformed payloads degrade to an empty (never throwing) track.
  assert.deepEqual(normalizeAeroApiTrack({}), []);
  assert.deepEqual(normalizeAeroApiTrack({ positions: 'nope' }), []);
});

test('AeroAPI source resolves ident to flight id, then fetches and normalizes the track', async () => {
  const requests = [];
  const trackResponse = {
    positions: [
      {
        timestamp: '2026-09-16T12:00:00Z',
        latitude: 30,
        longitude: -97,
        altitude: 340,
      },
    ],
  };
  const source = createAeroApiSource({
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.includes('/api/aeroapi/flights/N123AB?'))
        return response({
          flights: [
            { fa_flight_id: 'F-1', scheduled_out: '2026-09-16T11:00:00Z' },
          ],
        });
      if (url.includes('/api/aeroapi/flights/F-1/track'))
        return response(trackResponse);
      return response({ title: 'Not Found' }, {}, 404);
    },
  });
  const track = await source.getTrackByQuery({
    id: 'abc123',
    registration: 'N123AB',
    callsign: 'TEST',
  });
  assert.equal(track.records.length, 1);
  assert.equal(track.complete, false);
  const listCalls = requests.filter((r) =>
    r.url.includes('/api/aeroapi/flights/N123AB?'),
  );
  assert.equal(listCalls.length, 1);
  assert.ok(
    listCalls[0].url.includes('start=') && listCalls[0].url.includes('end='),
    'flight list is windowed',
  );
  // String references satisfy the getTrack contract shape but have no ident.
  await assert.rejects(source.getTrack('abc123'), { code: 'unsupported' });
  // No candidates → unsupported, without any request.
  const before = requests.length;
  await assert.rejects(source.getTrackByQuery({}), { code: 'unsupported' });
  assert.equal(requests.length, before);
});

test('composeSource prefers primary history and falls back with attribution tagging', async () => {
  const fallbackTrack = {
    records: [{ latitude: 30, longitude: -97 }],
    complete: false,
  };
  const primary = {
    label: 'Primary',
    async getSnapshot() {
      return {};
    },
    async getTrack(reference) {
      if (reference === 'primary-ok')
        return { records: [{ latitude: 1, longitude: 1 }] };
      if (reference === 'primary-error') throw Error('primary down');
      return { records: [] };
    },
  };
  const fallback = {
    label: 'Fallback',
    credit: { key: 'k', html: 'h' },
    async getTrackByQuery(reference) {
      if (reference.id === 'fallback-empty') return { records: [] };
      return fallbackTrack;
    },
  };
  const composed = composeSource(primary, fallback);
  assert.equal(composed.label, 'Primary');
  assert.equal(typeof composed.getSnapshot, 'function');

  const primaryWin = await composed.getTrack('primary-ok');
  assert.equal(primaryWin.records.length, 1);
  assert.equal(primaryWin.historySource, undefined);

  const emptyPrimary = await composed.getTrack('primary-empty');
  assert.deepEqual(emptyPrimary.records, fallbackTrack.records);
  assert.equal(emptyPrimary.historySource, 'Fallback');
  assert.deepEqual(emptyPrimary.credit, { key: 'k', html: 'h' });

  const errorPrimary = await composed.getTrack('primary-error');
  assert.equal(errorPrimary.historySource, 'Fallback');

  const bothEmpty = await composed.getTrack('fallback-empty');
  assert.deepEqual(bothEmpty.records, []);

  // A failing fallback after a failing primary propagates the primary error.
  const failing = composeSource(
    {
      label: 'P',
      async getTrack() {
        throw Error('boom');
      },
    },
    {
      async getTrackByQuery() {
        throw Error('fallback boom');
      },
    },
  );
  await assert.rejects(failing.getTrack('x'), /boom/);
  // No fallback → pass-through.
  assert.equal(composeSource(primary, null), primary);
});
