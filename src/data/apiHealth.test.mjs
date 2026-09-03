// Startup API health probes run offline against a scripted fetch so every
// state (ok / configured / degraded / key-missing / key-invalid / down) and
// the no-billable-Google rule are pinned without touching the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_HEALTH_SERVICES,
  apiHealthManifest,
  healthStateMap,
  runApiHealthProbes,
  summarizeApiHealth,
} from './apiHealth.js';

/** Scripted fetch: `routes` maps a URL substring to a response recipe. */
function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {} });
    const hit = Object.entries(routes).find(([needle]) => String(url).includes(needle));
    if (!hit) throw new TypeError(`fetch failed: ${url}`);
    const recipe = typeof hit[1] === 'function' ? hit[1](url, init) : hit[1];
    if (recipe instanceof Error) throw recipe;
    const { status = 200, body = '' } = recipe;
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
}

const ALL_OK_ROUTES = {
  'tile.googleapis.com': { status: 403 },
  'api.cesium.com/v1/me': { body: { username: 'gev' } },
  'api.openai.com': { body: { data: [] } },
  'api.adsb.lol': { body: {} },
  'api.adsbdb.com': { body: {} },
  'celestrak.org': { body: [{ OBJECT_NAME: 'ISS (ZARYA)' }] },
  'll.thespacedevs.com': { status: 200 },
  'earthquake.usgs.gov': { body: '1.13.6' },
  'firms.modaps.eosdis.nasa.gov': { body: { current_transactions: 3, transaction_limit: 5000 } },
  'api.tomtom.com': { body: { flowSegmentData: {} } },
  'overpass-api.de': { body: 'ok' },
  'nominatim.openstreetmap.org': { body: { status: 'OK' } },
  'routing.openstreetmap.de': { body: {} },
  'api.open-meteo.com': { body: {} },
  'news.google.com': { status: 200 },
  'terrain.reearth.land': { body: {} },
  'data.austintexas.gov': { body: [] },
  'cwwp2.dot.ca.gov': { status: 200 },
  'api.tfl.gov.uk': { body: [] },
  'gbfs.lyft.com': { body: {} },
  'radio-browser.info': { body: {} },
};

const FULL_ENV = {
  GOOGLE_MAPS_API_KEY: 'g', CESIUM_ION_TOKEN: 'c', OPENAI_API_KEY: 'o',
  OPENSKY_AUTH_MODE: 'oauth', OPENSKY_CLIENT_ID: 'id', OPENSKY_CLIENT_SECRET: 'sec',
  AISSTREAM_API_KEY: 'a', FIRMS_MAP_KEY: 'f', TOMTOM_API_KEY: 't',
};

const liveAis = async () => ({ status: 200, ok: true, text: '', json: { status: 'live', rows: [] } });

test('manifest exposes id/label/tier only and covers every catalog row', () => {
  const manifest = apiHealthManifest();
  assert.equal(manifest.length, API_HEALTH_SERVICES.length);
  for (const row of manifest) assert.deepEqual(Object.keys(row).sort(), ['id', 'label', 'tier']);
  assert.equal(new Set(manifest.map((r) => r.id)).size, manifest.length, 'ids unique');
});

test('fully configured environment reports every service live', async () => {
  const calls = [];
  const results = await runApiHealthProbes({
    fetchImpl: fakeFetch(ALL_OK_ROUTES, calls),
    env: FULL_ENV,
    localFetch: liveAis,
    getOpenSkyToken: async () => 'token',
    timeoutMs: 500,
  });
  const states = healthStateMap(results);
  for (const [id, state] of Object.entries(states)) {
    assert.ok(state === 'ok' || (id === 'google-places' && state === 'configured'), `${id} -> ${state}`);
  }
  assert.equal(results.length, API_HEALTH_SERVICES.length);
  assert.deepEqual(results.map((r) => r.id), API_HEALTH_SERVICES.map((s) => s.id), 'catalog order');
  const summary = summarizeApiHealth(results);
  assert.equal(summary.live, results.length);
  assert.equal(summary.failed, 0);
  assert.equal(summary.requiredFailed, false);
});

test('Google probes never send the Maps key upstream', async () => {
  const calls = [];
  await runApiHealthProbes({
    fetchImpl: fakeFetch(ALL_OK_ROUTES, calls),
    env: { ...FULL_ENV, GOOGLE_MAPS_API_KEY: 'SECRET-MAPS-KEY' },
    localFetch: liveAis,
    getOpenSkyToken: async () => 'token',
    timeoutMs: 500,
  });
  const google = calls.filter((c) => c.url.includes('googleapis.com'));
  assert.equal(google.length, 1, 'only the tile host HEAD');
  assert.equal(google[0].method, 'HEAD');
  assert.ok(!google[0].url.includes('SECRET-MAPS-KEY'));
  assert.ok(!calls.some((c) => c.url.includes('places.googleapis.com')), 'Places is never probed');
});

test('missing optional keys are key-missing, missing required key fails the summary', async () => {
  const results = await runApiHealthProbes({
    fetchImpl: fakeFetch(ALL_OK_ROUTES),
    env: { OPENSKY_AUTH_MODE: 'oauth' },
    localFetch: async () => ({ status: 503, ok: false, text: '', json: { status: 'idle', rows: [] } }),
    timeoutMs: 500,
  });
  const states = healthStateMap(results);
  assert.equal(states['google-maps'], 'key-missing');
  assert.equal(states['google-places'], 'key-missing');
  assert.equal(states['cesium-ion'], 'key-missing');
  assert.equal(states.openai, 'key-missing');
  assert.equal(states.opensky, 'key-missing');
  assert.equal(states.aisstream, 'key-missing');
  assert.equal(states.firms, 'key-missing');
  assert.equal(states.tomtom, 'key-missing');
  assert.equal(states.usgs, 'ok', 'keyless feeds still probe');
  const summary = summarizeApiHealth(results);
  assert.equal(summary.requiredFailed, true);
  assert.equal(summary.unconfigured, 8);
});

test('rejected credentials map to key-invalid, not down', async () => {
  const results = await runApiHealthProbes({
    fetchImpl: fakeFetch({
      ...ALL_OK_ROUTES,
      'api.cesium.com/v1/me': { status: 401 },
      'api.openai.com': { status: 401 },
      'api.tomtom.com': { status: 403 },
      'firms.modaps.eosdis.nasa.gov': { body: 'Invalid MAP_KEY.' },
    }),
    env: FULL_ENV,
    localFetch: liveAis,
    getOpenSkyToken: async () => null,
    timeoutMs: 500,
  });
  const states = healthStateMap(results);
  assert.equal(states['cesium-ion'], 'key-invalid');
  assert.equal(states.openai, 'key-invalid');
  assert.equal(states.tomtom, 'key-invalid');
  assert.equal(states.firms, 'key-invalid');
  assert.equal(states.opensky, 'key-invalid', 'OAuth refused with credentials set');
  assert.equal(summarizeApiHealth(results).failed, 5);
});

test('network failures and timeouts are down; 429 is degraded', async () => {
  const hang = () => new Promise(() => {});
  const fetchImpl = fakeFetch({
    ...ALL_OK_ROUTES,
    'api.adsbdb.com': new TypeError('fetch failed'),
    'earthquake.usgs.gov': { status: 429 },
  });
  const slowFetch = async (url, init) => (String(url).includes('radio-browser') ? hang() : fetchImpl(url, init));
  const results = await runApiHealthProbes({
    fetchImpl: slowFetch,
    env: FULL_ENV,
    localFetch: liveAis,
    getOpenSkyToken: async () => 'token',
    timeoutMs: 40,
  });
  const states = healthStateMap(results);
  assert.equal(states.adsbdb, 'down');
  assert.equal(states.usgs, 'degraded');
  assert.equal(states['radio-browser'], 'down');
  assert.match(results.find((r) => r.id === 'radio-browser').detail, /timed out/);
});

test('OpenSky anonymous mode probes a tiny bounding box without auth', async () => {
  const calls = [];
  const results = await runApiHealthProbes({
    fetchImpl: fakeFetch({ ...ALL_OK_ROUTES, 'opensky-network.org/api/states/all': { body: { states: [] } } }, calls),
    env: { ...FULL_ENV, OPENSKY_AUTH_MODE: 'anon' },
    localFetch: liveAis,
    getOpenSkyToken: async () => { throw new Error('must not be called in anon mode'); },
    timeoutMs: 500,
  });
  assert.equal(healthStateMap(results).opensky, 'ok');
  const call = calls.find((c) => c.url.includes('opensky-network.org'));
  assert.ok(call && !call.headers.Authorization);
  assert.match(call.url, /lamin=37\.7&lomin=-122\.5&lamax=37\.8&lomax=-122\.4/);
});

test('AISStream reads the local feed snapshot instead of opening a second socket', async () => {
  const calls = [];
  const results = await runApiHealthProbes({
    fetchImpl: fakeFetch(ALL_OK_ROUTES, calls),
    env: FULL_ENV,
    localFetch: async (p) => {
      assert.equal(p, '/api/ais-live?maxRows=1');
      return { status: 200, ok: true, text: '', json: { status: 'connecting', rows: [] } };
    },
    getOpenSkyToken: async () => 'token',
    timeoutMs: 500,
  });
  assert.equal(healthStateMap(results).aisstream, 'degraded');
  assert.ok(!calls.some((c) => c.url.includes('aisstream')), 'no upstream AISStream call');
});

test('onResult streams each service exactly once', async () => {
  const seen = [];
  await runApiHealthProbes({
    fetchImpl: fakeFetch(ALL_OK_ROUTES),
    env: FULL_ENV,
    localFetch: liveAis,
    getOpenSkyToken: async () => 'token',
    timeoutMs: 500,
    onResult: (r) => seen.push(r.id),
  });
  assert.deepEqual([...seen].sort(), API_HEALTH_SERVICES.map((s) => s.id).sort());
});
