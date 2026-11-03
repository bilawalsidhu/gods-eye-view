import assert from 'node:assert/strict';
import test from 'node:test';
import { createEcccAirQualitySource } from './source.js';

const NOW = Date.parse('2026-09-24T18:30:00Z');
const HOUR = 60 * 60 * 1000;
const station = (id) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-79.38, 43.65] },
  properties: { location_id: id, location_name_en: id },
});
const observation = (id, at = NOW, aqhi = 3) => ({
  type: 'Feature',
  properties: {
    location_id: id,
    aqhi,
    observation_datetime: new Date(at - 10 * 60_000).toISOString(),
  },
});
const json = (body, init) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });

/** A fetch that serves the station catalog and observations from mutable state. */
function feed() {
  const state = {
    clock: NOW,
    stations: [station('A')],
    stationIds: null,
    urls: [],
  };
  state.source = createEcccAirQualitySource({
    now: () => state.clock,
    fetchImpl: async (url) => {
      state.urls.push(url);
      return json({
        type: 'FeatureCollection',
        // Every known station reports ten minutes before the current clock.
        features: url.includes('aqhi-stations')
          ? state.stations
          : (state.stationIds || ['A']).map((id) =>
              observation(id, state.clock),
            ),
      });
    },
  });
  state.stationRequests = () =>
    state.urls.filter((url) => url.includes('aqhi-stations')).length;
  return state;
}

test('the station catalog is cached for twelve hours, then refetched', async () => {
  const state = feed();
  await state.source.getSnapshot();
  state.clock = NOW + 12 * HOUR;
  await state.source.getSnapshot();
  assert.equal(state.stationRequests(), 1, 'within the TTL the cache serves');
  state.clock = NOW + 12 * HOUR + 1;
  await state.source.getSnapshot();
  assert.equal(
    state.stationRequests(),
    2,
    'past the TTL the catalog refreshes',
  );
});

test('an empty catalog refresh keeps the previous catalog', async () => {
  const state = feed();
  await state.source.getSnapshot();
  state.stations = [];
  state.clock = NOW + 13 * HOUR;
  const readings = await state.source.getSnapshot();
  assert.deepEqual(
    readings.map((reading) => reading.stationId),
    ['A'],
  );
  // The empty refresh did not count as fresh, so the next call retries it.
  await state.source.getSnapshot();
  assert.equal(state.stationRequests(), 3);
});

test('an empty first catalog is an error, not an empty layer', async () => {
  const state = feed();
  state.stations = [];
  await assert.rejects(state.source.getSnapshot(), /No AQHI stations/);
});

test('requests ask for JSON, the latest observations only, and a bounded page', async () => {
  const state = feed();
  await state.source.getSnapshot();
  const [stations, observations] = state.urls.map((url) => new URL(url));
  assert.equal(stations.pathname, '/collections/aqhi-stations/items');
  assert.equal(stations.searchParams.get('f'), 'json');
  assert.equal(stations.searchParams.get('limit'), '500');
  assert.equal(
    observations.pathname,
    '/collections/aqhi-observations-realtime/items',
  );
  // Without latest=true the collection returns the full history (~2,000 rows).
  assert.equal(observations.searchParams.get('latest'), 'true');
  assert.equal(observations.searchParams.get('limit'), '500');
});

test('rows past the requested limit are ignored', async () => {
  const state = feed();
  state.stations = Array.from({ length: 600 }, (_, index) =>
    station(`S${String(index).padStart(3, '0')}`),
  );
  state.stationIds = state.stations.map((row) => row.properties.location_id);
  const readings = await state.source.getSnapshot();
  assert.equal(readings.length, 500);
});

test('a malformed catalog and HTTP errors reject', async () => {
  await assert.rejects(
    createEcccAirQualitySource({
      fetchImpl: async () => json({ features: 'no' }),
    }).getSnapshot(),
    /Malformed AQHI station/,
  );
  await assert.rejects(
    createEcccAirQualitySource({
      fetchImpl: async () => json({}, { status: 503 }),
    }).getSnapshot(),
    /ECCC HTTP 503/,
  );
});

test('an oversized response is refused before it is parsed', async () => {
  const big = 'x'.repeat(4 * 1024 * 1024 + 1);
  await assert.rejects(
    createEcccAirQualitySource({
      fetchImpl: async () =>
        new Response(new Blob([big]).stream(), {
          headers: { 'content-type': 'application/json' },
        }),
    }).getSnapshot(),
    (error) => error.code === 'RESPONSE_TOO_LARGE',
  );
  await assert.rejects(
    createEcccAirQualitySource({
      fetchImpl: async () =>
        json({}, { headers: { 'content-length': String(5 * 1024 * 1024) } }),
    }).getSnapshot(),
    (error) => error.code === 'RESPONSE_TOO_LARGE',
  );
});

test('a caller abort cancels the request and detaches its listener', async () => {
  const caller = new AbortController();
  let requestSignal = null;
  const source = createEcccAirQualitySource({
    fetchImpl: (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  const pending = source.getSnapshot({ signal: caller.signal });
  caller.abort(new Error('layer disabled'));
  await assert.rejects(pending, /layer disabled/);
  assert.equal(requestSignal.aborted, true);
  const already = new AbortController();
  already.abort(new Error('before start'));
  let calls = 0;
  await assert.rejects(
    createEcccAirQualitySource({
      fetchImpl: async () => {
        calls += 1;
        return json({ features: [] });
      },
    }).getSnapshot({ signal: already.signal }),
    /before start/,
  );
  assert.equal(calls, 0);
});

test('a request that outlives its deadline is aborted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = createEcccAirQualitySource({
    timeoutMs: 1_000,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      ),
  });
  const pending = source.getSnapshot();
  t.mock.timers.tick(1_000);
  await assert.rejects(pending, /ECCC request timed out/);
});
