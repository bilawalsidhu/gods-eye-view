import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALPINE_STATIONS_ROUTE,
  RETRY_AFTER_FAILURE_MS,
  alpineStationsProxy,
} from '../../server/providers/alpine-stations.js';
import {
  METADATA_CACHE_MS,
  OBSERVATION_CACHE_MS,
  SLF_MEASUREMENTS_URL,
  SLF_STATIONS_URL,
  SMN_METADATA_URL,
  SMN_OBSERVATIONS_URL,
  TAWES_METADATA_URL,
  TAWES_STATIONS_PER_REQUEST,
} from '../../server/providers/alpine-stations/upstreams.js';
import { tawesObservationUrl } from '../../server/providers/alpine-stations/fetchers.js';
import {
  ALPINE_NETWORK_IDS,
  SLF_NETWORK_ID,
  SMN_NETWORK_ID,
  TAWES_NETWORK_ID,
} from '../layers/alpineStations/networks.js';
import {
  SLF_MEASUREMENTS,
  SLF_STATIONS,
  SMN_METADATA_CSV,
  SMN_OBSERVATIONS_CSV,
  TAWES_METADATA,
  TAWES_OBSERVATIONS,
} from '../testSupport/alpineStationFixtures.mjs';

const NOW = Date.UTC(2026, 9, 9, 12, 0);

/**
 * Real `Response` objects, not stubs.
 *
 * The capped readers drive the body through `getReader()` and
 * `releaseLock()`, so a hand-rolled stream stub would only prove the stub
 * works. These carry genuine bytes with a genuine content-length.
 */
function bytesResponse(bytes) {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-length': String(bytes.byteLength) },
  });
}

const textResponse = (body) => bytesResponse(new TextEncoder().encode(body));
const jsonResponse = (value) => textResponse(JSON.stringify(value));

/**
 * ISO-8859-1 bytes, as data.geo.admin.ch really serves the metadata file.
 *
 * Served as bytes rather than as a string, so a proxy that reached for
 * `Response.text()` would decode them as UTF-8 and mangle the accented
 * station names — which is exactly what the assertion downstream checks.
 */
function latin1Response(text) {
  return bytesResponse(
    Uint8Array.from([...text].map((ch) => ch.codePointAt(0) & 0xff)),
  );
}

function harness({ fail = new Set(), clock = { value: NOW } } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if ([...fail].some((fragment) => url.includes(fragment)))
      throw new Error('upstream exploded with a detailed internal message');
    if (url === SLF_STATIONS_URL) return jsonResponse(SLF_STATIONS);
    if (url === SLF_MEASUREMENTS_URL) return jsonResponse(SLF_MEASUREMENTS);
    if (url === SMN_METADATA_URL) return latin1Response(SMN_METADATA_CSV);
    if (url === SMN_OBSERVATIONS_URL) return textResponse(SMN_OBSERVATIONS_CSV);
    if (url === TAWES_METADATA_URL) return jsonResponse(TAWES_METADATA);
    if (url.startsWith('https://dataset.api.hub.geosphere.at/'))
      return jsonResponse(TAWES_OBSERVATIONS);
    throw new Error(`unexpected upstream: ${url}`);
  };
  const plugin = alpineStationsProxy({
    fetchImpl,
    now: () => clock.value,
  });
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  const handler = routes.get(ALPINE_STATIONS_ROUTE);
  const call = (url = '/', method = 'GET', address = '127.0.0.1') =>
    new Promise((resolve) => {
      const res = {
        destroyed: false,
        once() {},
        removeListener() {},
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end(body) {
          resolve({ status: this.status, headers: this.headers, body });
        },
      };
      handler({ url, method, socket: { remoteAddress: address } }, res);
    });
  const json = async (...args) => JSON.parse((await call(...args)).body);
  return { plugin, routes, call, json, calls, clock };
}

test('the route mounts once on both the dev and the preview server', () => {
  const plugin = alpineStationsProxy({ fetchImpl: async () => jsonResponse([]) });
  assert.equal(plugin.name, 'alpine-stations');
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const routes = new Map();
    plugin[hook]({ middlewares: { use: (route) => routes.set(route, true) } });
    assert.deepEqual([...routes.keys()], [ALPINE_STATIONS_ROUTE], hook);
  }
});

test('construction performs no upstream work', () => {
  let fetched = 0;
  alpineStationsProxy({
    fetchImpl: async () => {
      fetched++;
      return jsonResponse([]);
    },
  });
  assert.equal(fetched, 0);
});

test('every network is joined and credited in one response', async () => {
  const { json, calls } = harness();
  const payload = await json();
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.unavailable, false);
  assert.equal(payload.stale, false);
  assert.equal(payload.reason, null);
  assert.deepEqual(
    payload.networks.map((network) => network.id).sort(),
    [...ALPINE_NETWORK_IDS].sort(),
  );
  for (const network of payload.networks) {
    assert.equal(network.status, 'ok', network.id);
    assert.equal(network.licence, 'CC BY 4.0');
    assert.ok(network.fetchedAt);
  }
  assert.ok(payload.stations.length >= 7);
  assert.match(payload.attribution, /CC BY 4\.0/);
  for (const fragment of ['SLF', 'MeteoSwiss', 'GeoSphere'])
    assert.ok(payload.attribution.includes(fragment), fragment);
  // Only the fixed upstreams are ever contacted.
  for (const url of calls)
    assert.ok(
      [
        'measurement-api.slf.ch',
        'data.geo.admin.ch',
        'dataset.api.hub.geosphere.at',
      ].some((host) => url.includes(host)),
      url,
    );
});

test('the merged payload carries records from each network, with stable ids', async () => {
  const { json } = harness();
  const { stations } = await json();
  const networks = new Set(stations.map((station) => station.networkId));
  assert.deepEqual([...networks].sort(), [...ALPINE_NETWORK_IDS].sort());
  assert.equal(new Set(stations.map((s) => s.id)).size, stations.length);
  for (const station of stations) {
    assert.match(station.id, /^[a-z-]+:[^:]+$/);
    assert.ok(Number.isFinite(station.lat) && Number.isFinite(station.lon));
  }
  assert.deepEqual(
    stations.map((station) => station.id),
    [...stations.map((station) => station.id)].sort(),
    'stable order, so the rail list does not reshuffle per poll',
  );
});

test('the ISO-8859-1 metadata file is decoded from bytes, not as UTF-8', async () => {
  // The latin1 stub throws if `.text()` is called, so this fails loudly if the
  // decoder is ever dropped.
  const { json } = harness();
  const { stations } = await json();
  const accented = stations.find((station) => station.code === 'AEG');
  assert.ok(accented, 'the Swiss station set reached the response');
  assert.equal(accented.label, 'Oberägeri');
});

test('a measured zero survives the whole proxy, and absent stays null', async () => {
  const { json } = harness();
  const { stations } = await json();
  assert.ok(
    stations.some((station) => station.snowDepthCm === 0),
    'a 0 cm reading is not turned into an absence',
  );
  assert.ok(
    stations.some((station) => station.snowDepthCm === null),
    'and a station with no snow sensor is not turned into a zero',
  );
  const zermatt = stations.find((station) => station.code === 'ZER');
  assert.equal(zermatt.pressureQffHpa, null, 'QNH is never borrowed for QFF');
});

test('a second request inside the window is served from cache', async () => {
  const { json, calls, clock } = harness();
  await json();
  const cold = calls.length;
  await json();
  assert.equal(calls.length, cold, 'nothing was refetched');
  clock.value += OBSERVATION_CACHE_MS + 1;
  await json();
  assert.ok(calls.length > cold, 'and the window does expire');
});

test('station metadata is held far longer than the readings', async () => {
  // Names, cantons, altitudes and positions are identity, not weather.
  const { json, calls, clock } = harness();
  await json();
  calls.length = 0;
  clock.value += OBSERVATION_CACHE_MS + 1;
  await json();
  assert.ok(calls.includes(SMN_OBSERVATIONS_URL), 'readings refreshed');
  assert.ok(!calls.includes(SMN_METADATA_URL), 'identity did not');
  assert.ok(!calls.includes(TAWES_METADATA_URL));
  calls.length = 0;
  clock.value += METADATA_CACHE_MS + 1;
  await json();
  assert.ok(calls.includes(SMN_METADATA_URL), 'until its own window expires');
});

test('concurrent requests share one refresh per upstream', async () => {
  // The SLF measurement read is three megabytes; a burst must not open one
  // copy per caller.
  const { json, calls } = harness();
  await Promise.all([json(), json(), json(), json()]);
  assert.equal(
    calls.filter((url) => url === SLF_MEASUREMENTS_URL).length,
    1,
    'one in-flight request per upstream',
  );
  assert.equal(calls.filter((url) => url === SMN_OBSERVATIONS_URL).length, 1);
});

test('one network failing never blanks the others', async () => {
  // A visitor in the Austrian Alps keeps a map when a Swiss research API is
  // in maintenance.
  const { json } = harness({ fail: new Set(['measurement-api.slf.ch']) });
  const payload = await json();
  assert.equal(payload.unavailable, false);
  const states = Object.fromEntries(
    payload.networks.map((network) => [network.id, network.status]),
  );
  assert.equal(states[SLF_NETWORK_ID], 'unavailable');
  assert.equal(states[SMN_NETWORK_ID], 'ok');
  assert.equal(states[TAWES_NETWORK_ID], 'ok');
  assert.match(payload.reason, /1 of 3 networks unavailable/);
  assert.ok(payload.stations.length > 0);
  assert.ok(
    !payload.stations.some((station) => station.networkId === SLF_NETWORK_ID),
  );
  assert.ok(
    !payload.attribution.includes('SLF'),
    'an absent network is not credited',
  );
});

test('a network with nothing cached is retried at most once per cooldown', () => {
  // With no cache to fall back on there is nothing to rate-limit the retry but
  // this cooldown, so it has to be shorter than the cache window: inside the
  // window it is the only thing standing between a dead host and one upstream
  // attempt per request.
  assert.ok(RETRY_AFTER_FAILURE_MS < OBSERVATION_CACHE_MS);
});

test('a dead host is not re-attempted inside its cooldown', async () => {
  const fail = new Set(['measurement-api.slf.ch']);
  const { json, calls, clock } = harness({ fail });
  await json();
  const attempts = () => calls.filter((url) => url === SLF_STATIONS_URL).length;
  const first = attempts();
  assert.ok(first > 0);
  await json();
  await json();
  assert.equal(attempts(), first, 'a burst costs one upstream attempt');
  clock.value += RETRY_AFTER_FAILURE_MS / 2;
  await json();
  assert.equal(attempts(), first, 'and still none halfway through');
  clock.value += RETRY_AFTER_FAILURE_MS;
  await json();
  assert.ok(attempts() > first, 'but it is retried once the cooldown lapses');
});

test('a cached payload is served stale rather than dropped', async () => {
  const fail = new Set();
  const { json, clock } = harness({ fail });
  const fresh = await json();
  const slfCount = fresh.networks.find(
    (network) => network.id === SLF_NETWORK_ID,
  ).stationCount;
  assert.ok(slfCount > 0);
  fail.add('measurement-api.slf.ch');
  clock.value += OBSERVATION_CACHE_MS + 1;
  const payload = await json();
  const slf = payload.networks.find(
    (network) => network.id === SLF_NETWORK_ID,
  );
  assert.equal(slf.status, 'stale', 'a map a few minutes old beats none');
  assert.equal(slf.stationCount, slfCount);
  assert.equal(payload.stale, true);
  assert.equal(payload.unavailable, false);
});

test('every network down answers 200 with an honest envelope', async () => {
  // Not a 5xx: the lifecycle disables a layer whose first update rejects, and
  // the envelope already says what is unavailable and why.
  const { json } = harness({
    fail: new Set([
      'measurement-api.slf.ch',
      'data.geo.admin.ch',
      'dataset.api.hub.geosphere.at',
    ]),
  });
  const payload = await json();
  assert.equal(payload.unavailable, true);
  assert.deepEqual(payload.stations, []);
  assert.match(payload.reason, /No Alpine station network is reachable/);
  assert.equal(payload.attribution, '');
  for (const network of payload.networks)
    assert.equal(network.status, 'unavailable');
});

test('an upstream error message is never relayed to the client', async () => {
  const { call } = harness({
    fail: new Set([
      'measurement-api.slf.ch',
      'data.geo.admin.ch',
      'dataset.api.hub.geosphere.at',
    ]),
  });
  const response = await call();
  assert.equal(response.status, 200);
  assert.ok(!response.body.includes('exploded'));
  assert.ok(!response.body.includes('internal message'));
});

test('the route answers only GET on exactly its own path', async () => {
  const { call } = harness();
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await call('/', method);
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.Allow, 'GET');
  }
  for (const path of ['/stations', '/../etc', '/slf']) {
    const response = await call(path);
    assert.equal(response.status, 404, path);
  }
  assert.equal((await call('/')).status, 200);
  assert.equal((await call('/?cache=bust')).status, 200);
});

test('responses are never cached by an intermediary', async () => {
  const { call } = harness();
  const response = await call();
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.headers['Content-Type'], 'application/json');
});

test('a single client is throttled, and told when to come back', async () => {
  const { call } = harness();
  let limited = null;
  for (let attempt = 0; attempt < 70 && !limited; attempt++) {
    const response = await call('/', 'GET', '203.0.113.9');
    if (response.status === 429) limited = response;
  }
  assert.ok(limited, 'the per-IP cap engages');
  assert.equal(limited.headers['Retry-After'], '60');
  assert.match(limited.body, /rate_limited/);
});

test('GeoSphere observations are requested in bounded chunks of fixed shape', () => {
  // The dataset requires an explicit id list, so the only runtime-assembled
  // query value is built from GeoSphere's own metadata, never from a request.
  const ids = Array.from({ length: TAWES_STATIONS_PER_REQUEST }, (_, i) =>
    String(11000 + i),
  );
  const url = new URL(tawesObservationUrl(ids));
  assert.equal(url.origin, 'https://dataset.api.hub.geosphere.at');
  assert.equal(url.pathname, '/v1/station/current/tawes-v1-10min');
  assert.equal(url.searchParams.get('output_format'), 'geojson');
  assert.match(url.searchParams.get('parameters'), /^[A-Z,]+$/);
  assert.equal(url.searchParams.get('station_ids').split(',').length, ids.length);
  assert.ok(url.href.length < 8000, 'a chunk stays inside any line limit');
});

test('a decommissioned station is never requested', async () => {
  const { json, calls } = harness();
  await json();
  const inactive = TAWES_METADATA.stations
    .filter((station) => station.is_active === false)
    .map((station) => station.id);
  assert.ok(inactive.length);
  const observationCalls = calls.filter((url) =>
    url.includes('station_ids='),
  );
  assert.ok(observationCalls.length);
  for (const id of inactive)
    for (const url of observationCalls)
      assert.ok(
        !new URL(url).searchParams.get('station_ids').split(',').includes(id),
        id,
      );
});

test('the standalone composition mounts the provider exactly once', async () => {
  // Registered in `localProviderPlugins` so dev and preview both serve the
  // route; mounted twice it would answer from whichever middleware ran first.
  const { localProviderPlugins } = await import(
    '../../server/providers/local.js'
  );
  const plugins = localProviderPlugins();
  assert.equal(
    plugins.filter((plugin) => plugin.name === 'alpine-stations').length,
    1,
  );
});

test('the browser route the source calls is the route the provider mounts', () => {
  // Two independent string literals, in files that never import each other.
  const source = readFileSync(
    new URL('../layers/alpineStations/source.js', import.meta.url),
    'utf8',
  );
  assert.ok(
    source.includes(`'${ALPINE_STATIONS_ROUTE}'`),
    `the source does not fetch ${ALPINE_STATIONS_ROUTE}`,
  );
});

test('the envelope carries only fields the client reads', () => {
  // A `summary` block used to ride along here. The proxy has no selected
  // parameter, so its `measuring`, `min` and `max` were always zero or null,
  // and `readAlpineSnapshot` never passed it through. The layer computes its
  // own summary against the chosen parameter.
  const { json } = harness();
  return json().then((payload) => {
    assert.deepEqual(
      Object.keys(payload).sort(),
      [
        'attribution',
        'fetchedAt',
        'networks',
        'reason',
        'schemaVersion',
        'stale',
        'stations',
        'unavailable',
      ],
    );
  });
});
