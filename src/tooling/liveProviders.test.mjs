import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import * as providers from '../../server/providers/live.js';
import * as portable from '../../src/data/adsbLolFallback.js';

function install(plugin, preview = false) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (route, url = '/', method = 'GET') => {
    assert.ok(routes.has(route), `registered route: ${route}`);
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value;
      },
      writeHead(status, headers = {}) {
        this.statusCode = status;
        for (const [key, value] of Object.entries(headers))
          this.setHeader(key, value);
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get(route)({ url, method }, response);
    return response;
  };
}

function environment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const original = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }
}

/** A private OpenSky module instance: breaker, cooldown and caches start cold. */
let freshOpenSkyModules = 0;
const freshOpenSky = () =>
  import(
    `../../server/providers/aircraft/opensky.js?fresh=${++freshOpenSkyModules}-${Date.now()}`
  );
const callsTo = (calls, host) =>
  calls.filter((call) => String(call.url ?? call).includes(host)).length;
const connectTimeout = () =>
  Object.assign(new Error('fetch failed'), {
    cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
  });
const regionalRow = { hex: 'abc123', lat: 30, lon: -97, alt_baro: 10000 };
const silence = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
};

test('live entry resolves in Node and aircraft normalization stays independently portable', async () => {
  const entry = await import('ondemand-spatial/server/providers/live');
  assert.equal(entry.openSkyProxy, providers.openSkyProxy);
  assert.equal(entry.aisLiveProxy, providers.aisLiveProxy);
  const normalizer = await import('ondemand-spatial/sources/adsb-lol');
  assert.equal(
    normalizer.normalizeAdsbLolAircraftState,
    portable.normalizeAdsbLolAircraftState,
  );
});

test('OpenSky state and track routes share tokens, retain cache and use regional fallback', async (t) => {
  environment(t, {
    OPENSKY_CLIENT_ID: 'fixture-client',
    OPENSKY_CLIENT_SECRET: 'fixture-secret',
    OPENSKY_AUTH_MODE: 'oauth',
    OPENSKY_USERNAME: undefined,
    OPENSKY_PASSWORD: undefined,
  });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'log', () => {});
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/token'))
      return Response.json({ access_token: 'fixture-token', expires_in: 1800 });
    if (url.includes('/states/')) {
      assert.equal(options.headers.Authorization, 'Bearer fixture-token');
      return Response.json({ time: Math.floor(now / 1000), states: [] });
    }
    if (url.includes('/tracks/')) {
      assert.equal(options.headers.Authorization, 'Bearer fixture-token');
      return Response.json({ path: [] });
    }
    if (url.includes('/lat/'))
      return Response.json({
        now: now / 1000,
        ac: [{ hex: 'abc123', lat: 30, lon: -97, alt_baro: 10000 }],
      });
    throw Error(`Unexpected URL: ${url}`);
  });
  const states = install(providers.openSkyProxy());
  const live = await states('/api/opensky', '?lat=30&lon=-97');
  assert.equal(live.statusCode, 200);
  assert.equal(live.headers['x-provider-status'], 'live');
  assert.equal(live.headers['x-flight-source'], 'OpenSky Network');
  assert.match(
    live.headers['x-flight-coverage'],
    /scene box around 30\.00,-97\.00/,
  );
  assert.equal(JSON.parse(live.body).provider.status, 'live');
  // Scene bounding box (OPENSKY_BBOX_DEGREES 1.5 each side), never the whole world.
  assert.match(
    calls.find((call) => call.url.includes('/states/')).url,
    /\/states\/all\?lamin=28\.5&lomin=-98\.5&lamax=31\.5&lomax=-95\.5&extended=1$/,
  );
  assert.equal(
    (await states('/api/opensky', '?lat=30&lon=-97')).headers[
      'x-opensky-cache'
    ],
    'HIT',
  );
  assert.equal(calls.length, 2);
  const tracks = install(providers.trackBackfillProxies(), true);
  assert.equal(
    (await tracks('/api/opensky-track', '?icao24=ABC123')).statusCode,
    200,
  );
  await tracks('/api/opensky-track', '?icao24=abc123');
  assert.equal(calls.filter((call) => call.url.includes('/token')).length, 1);
  assert.equal(calls.filter((call) => call.url.includes('/tracks/')).length, 1);
  assert.equal(
    (await tracks('/api/adsblol/trace', '?hex=invalid')).statusCode,
    400,
  );
  now += 130_000;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/states/')) return new Response('', { status: 503 });
    if (url.includes('/lat/'))
      return Response.json({ now: now / 1000, ac: [regionalRow] });
    throw Error(`Unexpected URL: ${url}`);
  });
  // A fresh request without a usable cached frame should use the regional feed.
  const fresh = await freshOpenSky();
  process.env.OPENSKY_AUTH_MODE = 'anon';
  const fallback = await install(fresh.openSkyProxy())(
    '/api/opensky',
    '?lat=30&lon=-97',
  );
  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.headers['x-flight-source'], 'adsb.lol');
  assert.equal(fallback.headers['x-provider-status'], 'degraded');
  assert.equal(fallback.headers['x-provider-source'], 'adsb.lol');
  assert.match(fallback.headers['x-provider-error'], /^OpenSky HTTP 503/);
  assert.equal(
    fallback.headers['x-opensky-auth-reason'],
    'opensky_http_503_regional_fallback',
  );
  assert.equal(JSON.parse(fallback.body).states[0][0], 'abc123');
  assert.equal(JSON.parse(fallback.body).provider.status, 'degraded');
});

test('OpenSky connect timeout opens the breaker: adsb.lol answers degraded and OpenSky is not retried inside the window', async (t) => {
  environment(t, {
    OPENSKY_CLIENT_ID: undefined,
    OPENSKY_CLIENT_SECRET: undefined,
    OPENSKY_AUTH_MODE: undefined,
  });
  silence(t);
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  let openSkyUp = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push({ url });
    if (url.includes('/states/')) {
      if (openSkyUp)
        return Response.json({ time: Math.floor(now / 1000), states: [] });
      throw connectTimeout();
    }
    if (url.includes('api.adsb.lol'))
      return Response.json({ now: now / 1000, ac: [regionalRow] });
    throw Error(`Unexpected URL: ${url}`);
  });
  const fresh = await freshOpenSky();
  const request = install(fresh.openSkyProxy());
  const first = await request('/api/opensky', '?lat=30&lon=-97');
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['x-provider-status'], 'degraded');
  assert.equal(first.headers['x-provider-source'], 'adsb.lol');
  assert.equal(first.headers['x-flight-source'], 'adsb.lol');
  assert.match(
    first.headers['x-provider-error'],
    /^OpenSky unreachable from this deployment \(connect timeout\) - adsb\.lol regional feed$/,
  );
  assert.equal(
    first.headers['x-opensky-auth-reason'],
    'opensky_unreachable_regional_fallback',
  );
  assert.equal(first.headers['x-flight-coverage'], '250nm regional fallback');
  const body = JSON.parse(first.body);
  assert.equal(body.states[0][0], 'abc123');
  assert.equal(body.provider.status, 'degraded');
  assert.match(body.provider.error, /OpenSky unreachable/);
  assert.equal(
    callsTo(calls, '/states/'),
    1,
    'a single probe (OPENSKY_RETRIES default 0) before the breaker opens',
  );
  assert.equal(callsTo(calls, 'api.adsb.lol'), 1);
  // Inside the breaker window OpenSky is never contacted again — even for a
  // scene that has no regional cache yet.
  now += 31_000;
  const second = await request('/api/opensky', '?lat=48&lon=2');
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers['x-provider-status'], 'degraded');
  assert.equal(callsTo(calls, '/states/'), 1);
  assert.equal(callsTo(calls, 'api.adsb.lol'), 2);
  assert.match(second.headers['x-provider-error'], /connect timeout/);
  // Once the breaker (default 10 min) elapses OpenSky is tried again.
  now += 10 * 60_000;
  openSkyUp = true;
  const recovered = await request('/api/opensky', '?lat=30&lon=-97');
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.headers['x-provider-status'], 'live');
  assert.equal(recovered.headers['x-flight-source'], 'OpenSky Network');
  assert.equal(callsTo(calls, '/states/'), 2);
});

test('OpenSky and adsb.lol both failing falls through to adsb.fi, then to last-good, then to a structured 503', async (t) => {
  environment(t, {
    OPENSKY_CLIENT_ID: undefined,
    OPENSKY_CLIENT_SECRET: undefined,
    OPENSKY_AUTH_MODE: 'anon',
    AIRPLANES_LIVE_ENABLED: undefined,
  });
  silence(t);
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  let allDown = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push({ url });
    if (allDown) throw Error('offline');
    if (url.includes('/states/'))
      throw Object.assign(new Error('fetch failed'), {
        cause: { code: 'ECONNRESET' },
      });
    if (url.includes('api.adsb.lol')) return new Response('', { status: 503 });
    if (url.includes('opendata.adsb.fi'))
      return Response.json({
        now: now / 1000,
        aircraft: [{ hex: 'def456', lat: 30.1, lon: -97.1, alt_baro: 20000 }],
      });
    throw Error(`Unexpected URL: ${url}`);
  });
  const fresh = await freshOpenSky();
  const request = install(fresh.openSkyProxy());
  const degraded = await request('/api/opensky', '?lat=30&lon=-97');
  assert.equal(degraded.statusCode, 200);
  assert.equal(degraded.headers['x-provider-status'], 'degraded');
  assert.equal(degraded.headers['x-flight-source'], 'adsb.fi');
  assert.equal(degraded.headers['x-provider-source'], 'adsb.fi');
  assert.match(
    degraded.headers['x-provider-error'],
    /^OpenSky unreachable from this deployment \(network error\) - adsb\.fi regional feed$/,
  );
  assert.equal(JSON.parse(degraded.body).states[0][0], 'def456');
  assert.match(
    calls.find((call) => call.url.includes('adsb.fi')).url,
    /^https:\/\/opendata\.adsb\.fi\/api\/v2\/lat\/30\/lon\/-97\/dist\/250$/,
  );
  assert.equal(callsTo(calls, 'airplanes.live'), 0, 'opt-in only');
  // Every feed down: the last-good regional snapshot is served STALE.
  allDown = true;
  now += 31_000;
  const stale = await request('/api/opensky', '?lat=30&lon=-97');
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.headers['x-provider-status'], 'stale');
  assert.equal(stale.headers['x-flight-source'], 'adsb.fi');
  assert.equal(stale.headers['x-opensky-cache'], 'STALE');
  assert.equal(stale.headers['x-provider-age-sec'], '31');
  assert.equal(JSON.parse(stale.body).states[0][0], 'def456');
  // Last-good expired and nothing answers: HTTP 503 with the reason, never 502.
  now += 31 * 60_000;
  const unavailable = await request('/api/opensky', '?lat=30&lon=-97');
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.headers['x-provider-status'], 'unavailable');
  assert.ok(unavailable.headers['retry-after']);
  const payload = JSON.parse(unavailable.body);
  assert.equal(payload.provider.status, 'unavailable');
  assert.match(payload.error, /^OpenSky unreachable from this deployment/);
  assert.equal(payload.error, payload.provider.error);
});

test('OpenSky cold start with every upstream failing and no anchor answers 503 immediately', async (t) => {
  environment(t, { OPENSKY_AUTH_MODE: 'anon' });
  silence(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push({ url });
    throw connectTimeout();
  });
  const fresh = await freshOpenSky();
  const response = await install(fresh.openSkyProxy())('/api/opensky', '/');
  assert.equal(response.statusCode, 503);
  assert.notEqual(response.statusCode, 502);
  assert.equal(response.headers['x-provider-status'], 'unavailable');
  assert.equal(response.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(response.body).provider.status, 'unavailable');
  assert.equal(
    callsTo(calls, 'adsb'),
    0,
    'no regional query without an anchor',
  );
  assert.match(
    calls[0].url,
    /\/states\/all\?extended=1$/,
    'no anchor → worldwide request',
  );
});

test('OpenSky 429 with Retry-After starts a cooldown and the last-good scene snapshot is served stale', async (t) => {
  environment(t, { OPENSKY_AUTH_MODE: 'anon' });
  silence(t);
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  const row = [
    'abc123',
    'TEST',
    'X',
    now / 1000,
    now / 1000,
    -97,
    30,
    1000,
    false,
    100,
    90,
    0,
    null,
    1040,
    null,
    false,
    0,
    2,
  ];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push({ url });
    if (!url.includes('/states/')) throw Error(`Unexpected URL: ${url}`);
    if (calls.length === 1)
      return Response.json(
        { time: Math.floor(now / 1000), states: [row] },
        { headers: { 'X-Rate-Limit-Remaining': '3000' } },
      );
    return new Response('', {
      status: 429,
      headers: { 'X-Rate-Limit-Retry-After-Seconds': '90' },
    });
  });
  const fresh = await freshOpenSky();
  const request = install(fresh.openSkyProxy());
  const live = await request('/api/opensky', '?lat=30&lon=-97');
  assert.equal(live.headers['x-provider-status'], 'live');
  assert.equal(live.headers['x-provider-count'], '1');
  now += 10_000;
  const limited = await request('/api/opensky', '?lat=30&lon=-97');
  assert.equal(limited.statusCode, 200);
  assert.equal(limited.headers['x-provider-status'], 'stale');
  assert.equal(limited.headers['x-opensky-cache'], 'STALE');
  assert.equal(
    limited.headers['x-opensky-auth-reason'],
    'rate_limited_serving_stale',
  );
  assert.equal(limited.headers['x-opensky-retry-after-seconds'], '90');
  assert.equal(limited.headers['x-opensky-stale-seconds'], '10');
  assert.match(
    limited.headers['x-provider-error'],
    /^OpenSky rate limited \(retry in 90s\) - last-good OpenSky snapshot$/,
  );
  assert.deepEqual(JSON.parse(limited.body).states, [row]);
  assert.equal(calls.length, 2, 'a long Retry-After is never retried inline');
  now += 10_000;
  const cooling = await request('/api/opensky', '?lat=30&lon=-97');
  assert.equal(calls.length, 2, 'no upstream call inside the cooldown');
  assert.equal(cooling.headers['x-provider-status'], 'stale');
  assert.equal(cooling.headers['x-opensky-retry-after-seconds'], '80');
  assert.match(cooling.headers['x-provider-error'], /retry in 80s/);
});

test('military aircraft route preserves fresh cache and stale response after upstream failure', async (t) => {
  let now = Date.now();
  const calls = [];
  t.mock.method(Date, 'now', () => now);
  silence(t);
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push({ url });
    if (calls.length > 1) throw Error('offline');
    return Response.json({ ac: [{ hex: 'abc123' }] });
  });
  const request = install(providers.adsbLolProxy());
  const first = await request('/api/adsblol/mil');
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['x-provider-status'], 'live');
  assert.equal(first.headers['x-provider-source'], 'adsb.lol');
  assert.deepEqual(JSON.parse(first.body).ac, [{ hex: 'abc123' }]);
  assert.equal(JSON.parse(first.body).provider.status, 'live');
  const hit = await request('/api/adsblol/mil');
  assert.equal(hit.headers['x-ads-b-cache'], 'HIT');
  assert.deepEqual(JSON.parse(hit.body).ac, JSON.parse(first.body).ac);
  assert.equal(calls.length, 1);
  now += 13_000;
  const stale = await request('/api/adsblol/mil');
  assert.equal(stale.statusCode, 200);
  assert.deepEqual(JSON.parse(stale.body).ac, JSON.parse(first.body).ac);
  assert.equal(stale.headers['x-ads-b-cache'], 'STALE');
  assert.equal(stale.headers['x-provider-status'], 'stale');
  assert.match(
    stale.headers['x-provider-error'],
    /^adsb\.lol unreachable \(network error\) - last-good adsb\.lol list$/,
  );
  assert.equal(callsTo(calls, 'api.adsb.lol'), 3, 'one attempt plus one retry');
  assert.equal(
    callsTo(calls, 'opendata.adsb.fi'),
    2,
    'adsb.fi was tried first',
  );
  assert.equal(callsTo(calls, 'airplanes.live'), 0, 'opt-in only');
});

test('military scene filter drops far and positionless aircraft and names its coverage', async (t) => {
  silence(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push({ url });
    return Response.json({
      now: Date.now(),
      total: 3,
      ac: [
        { hex: 'near01', lat: 30.2, lon: -97.1, dbFlags: 1 },
        { hex: 'far001', lat: 48.8, lon: 2.3, dbFlags: 1 },
        { hex: 'nopos1', dbFlags: 1 },
      ],
    });
  });
  const request = install(providers.adsbLolProxy());
  const filtered = await request(
    '/api/adsblol/mil',
    '?lat=30&lon=-97&radiusNm=600',
  );
  assert.equal(filtered.statusCode, 200);
  assert.equal(filtered.headers['x-flight-coverage'], '600nm around 30,-97');
  assert.equal(filtered.headers['x-provider-count'], '1');
  const body = JSON.parse(filtered.body);
  assert.deepEqual(
    body.ac.map((row) => row.hex),
    ['near01'],
  );
  assert.equal(body.total, 3, 'readsb fields are kept');
  assert.equal(body.provider.count, 1);
  // The same cached upstream list serves the unfiltered globe view.
  const full = await request('/api/adsblol/mil');
  assert.equal(full.headers['x-flight-coverage'], undefined);
  assert.equal(JSON.parse(full.body).ac.length, 3);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.adsb\.lol\/v2\/mil$/);
  // point=1 uses the adsb.lol point query filtered to military rows.
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push({ url });
    return Response.json({
      now: Date.now(),
      ac: [
        { hex: 'mil001', lat: 30.1, lon: -97, dbFlags: 1 },
        { hex: 'civ001', lat: 30.1, lon: -97, dbFlags: 0 },
      ],
    });
  });
  const point = await request(
    '/api/adsblol/mil',
    '?lat=30&lon=-97&radiusNm=600&point=1',
  );
  assert.match(
    calls.at(-1).url,
    /^https:\/\/api\.adsb\.lol\/v2\/point\/30\/-97\/250$/,
  );
  assert.deepEqual(
    JSON.parse(point.body).ac.map((row) => row.hex),
    ['mil001'],
  );
  assert.equal(point.headers['x-provider-status'], 'live');
});

test('military adsb.lol 5xx is answered by adsb.fi as degraded with the adsb.lol reason', async (t) => {
  environment(t, { AIRPLANES_LIVE_ENABLED: undefined });
  silence(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push({ url });
    if (url.includes('api.adsb.lol'))
      return new Response('upstream exploded', { status: 502 });
    if (url.includes('opendata.adsb.fi'))
      return Response.json({ ac: [{ hex: 'fi0001', lat: 30, lon: -97 }] });
    throw Error(`Unexpected URL: ${url}`);
  });
  const request = install(providers.adsbLolProxy());
  const degraded = await request('/api/adsblol/mil');
  assert.equal(degraded.statusCode, 200);
  assert.equal(degraded.headers['x-provider-status'], 'degraded');
  assert.equal(degraded.headers['x-provider-source'], 'adsb.fi');
  assert.equal(
    degraded.headers['x-provider-error'],
    'adsb.lol HTTP 502 - adsb.fi feed',
  );
  assert.equal(degraded.headers['x-ads-b-upstream-status'], '502');
  assert.equal(degraded.headers['x-ads-b-cache'], 'MISS');
  const body = JSON.parse(degraded.body);
  assert.equal(body.ac[0].hex, 'fi0001');
  assert.equal(body.provider.source, 'adsb.fi');
  assert.match(
    calls.find((call) => call.url.includes('adsb.fi')).url,
    /^https:\/\/opendata\.adsb\.fi\/api\/v2\/mil$/,
  );
  assert.equal(callsTo(calls, 'airplanes.live'), 0);
  // adsb.lol cools down (15 s for a 5xx) — the next poll goes straight to adsb.fi.
  const again = await request('/api/adsblol/mil');
  assert.equal(again.headers['x-provider-status'], 'degraded');
  assert.equal(
    callsTo(calls, 'api.adsb.lol'),
    2,
    'one attempt plus one retry, then cooling',
  );
});

test('AIS preview route ingests through the socket, returns tracks and disposes before restart', async (t) => {
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(upstream, 'listening');
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => upstream.close(resolve));
  });
  environment(t, {
    AISSTREAM_API_KEY: 'fixture-key',
    AISSTREAM_URL: `ws://127.0.0.1:${upstream.address().port}`,
    AISSTREAM_BOUNDING_BOXES: undefined,
    AISSTREAM_MESSAGE_TYPES: undefined,
    AISSTREAM_SILENCE_TIMEOUT_MS: '0',
  });
  upstream.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (raw) => {
      assert.equal(JSON.parse(raw).APIKey, 'fixture-key');
      for (const [lat, epoch] of [
        [30, Math.floor(Date.now() / 1000) - 120],
        [30.01, Math.floor(Date.now() / 1000) - 60],
      ]) {
        socket.send(
          JSON.stringify({
            MessageType: 'PositionReport',
            MetaData: {
              MMSI: 123456789,
              latitude: lat,
              longitude: -97,
              time_utc: new Date(epoch * 1000).toISOString(),
            },
            Message: {
              PositionReport: {
                UserID: 123456789,
                Sog: 10,
                Cog: 90,
                TrueHeading: 511,
              },
            },
          }),
        );
      }
    });
  });
  const plugin = providers.aisLiveProxy();
  t.after(() => plugin.closeBundle());
  const request = install(plugin, true);
  let res;
  for (let i = 0; i < 100; i++) {
    res = await request('/api/ais-live');
    if (JSON.parse(res.body).rows.length) break;
    await delay(10);
  }
  const data = JSON.parse(res.body);
  assert.equal(data.status, 'live');
  assert.equal(data.rows[0].mmsi, '123456789');
  assert.equal(data.rows[0].heading, null);
  const history = await request('/api/ais-live', '/track?mmsi=123456789');
  assert.equal(JSON.parse(history.body).samples.length, 2);
  assert.equal(
    (await request('/api/ais-live', '/track?mmsi=bad')).statusCode,
    400,
  );
  assert.equal(sockets.length, 1);
  plugin.closeBundle();
  for (let i = 0; i < 100 && sockets[0].readyState !== 3; i++) await delay(10);
  assert.equal(sockets[0].readyState, 3);
  const restarted = install(plugin);
  await restarted('/api/ais-live');
  for (let i = 0; i < 100 && sockets.length < 2; i++) await delay(10);
  assert.equal(sockets.length, 2);
});

test('military aircraft route serves stale cache on an upstream 429 and cools down for Retry-After', async (t) => {
  let now = Date.now();
  const calls = [];
  t.mock.method(Date, 'now', () => now);
  silence(t);
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push({ url });
    if (calls.length === 1) return Response.json({ ac: [{ hex: 'abc123' }] });
    return new Response(JSON.stringify({ error: 'rate limited' }), {
      status: 429,
      headers: { 'Retry-After': '20' },
    });
  });
  const request = install(providers.adsbLolProxy());
  const first = await request('/api/adsblol/mil');
  assert.equal(first.statusCode, 200);
  now += 13_000;
  const limited = await request('/api/adsblol/mil');
  assert.equal(callsTo(calls, 'api.adsb.lol'), 2);
  assert.equal(callsTo(calls, 'opendata.adsb.fi'), 1, 'adsb.fi tried once');
  assert.equal(
    limited.statusCode,
    200,
    'a 429 with a cached body is never relayed',
  );
  assert.deepEqual(JSON.parse(limited.body).ac, JSON.parse(first.body).ac);
  assert.equal(limited.headers['x-ads-b-cache'], 'STALE');
  assert.equal(limited.headers['x-provider-status'], 'stale');
  assert.equal(limited.headers['x-ads-b-upstream-status'], '429');
  assert.equal(limited.headers['x-ads-b-cache-age-ms'], '13000');
  assert.equal(limited.headers['x-ads-b-retry-after-seconds'], '20');
  assert.match(
    limited.headers['x-provider-error'],
    /^adsb\.lol rate limited \(retry in 20s\) - last-good adsb\.lol list$/,
  );
  now += 5_000;
  const cooling = await request('/api/adsblol/mil');
  assert.equal(
    calls.length,
    3,
    'no upstream call inside the Retry-After window',
  );
  assert.equal(cooling.headers['x-ads-b-cache'], 'STALE');
  assert.equal(cooling.headers['x-ads-b-cache-age-ms'], '18000');
  now += 16_000;
  await request('/api/adsblol/mil');
  assert.equal(
    callsTo(calls, 'api.adsb.lol'),
    3,
    'upstream is retried once Retry-After elapses',
  );
});

test('military aircraft route answers a structured 503 (never 429/502) when nothing is cached', async (t) => {
  silence(t);
  const now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push({ url });
    return new Response('{"error":"rate limited"}', {
      status: 429,
      headers: { 'Retry-After': '20' },
    });
  });
  const request = install(providers.adsbLolProxy());
  const limited = await request('/api/adsblol/mil');
  assert.equal(limited.statusCode, 503);
  assert.equal(limited.headers['retry-after'], '20');
  assert.equal(limited.headers['x-provider-status'], 'unavailable');
  assert.equal(limited.headers['x-ads-b-upstream-status'], '429');
  const body = JSON.parse(limited.body);
  assert.equal(body.error, 'adsb.lol rate limited (retry in 20s)');
  assert.equal(body.provider.status, 'unavailable');
  assert.equal(body.provider.error, body.error);
  const upstreamCalls = calls.length;
  const again = await request('/api/adsblol/mil');
  assert.equal(again.statusCode, 503);
  assert.equal(
    calls.length,
    upstreamCalls,
    'the cooldown still protects every upstream with nothing cached',
  );
  assert.ok(
    again.headers['retry-after'],
    'a cooling-down miss carries Retry-After',
  );
});

test('military fallback cancels a stalled 5xx body and starts cooldown at receipt', async (t) => {
  let now = 1_800_000_000_000;
  const calls = [];
  let cancelled = false;
  t.mock.method(Date, 'now', () => now);
  silence(t);
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push({ url });
    if (!url.includes('api.adsb.lol')) throw Error('offline');
    if (callsTo(calls, 'api.adsb.lol') === 1) return Response.json({ ac: [] });
    now += 10000;
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      {
        status: 503,
        headers: { 'Retry-After': new Date(now + 20000).toUTCString() },
      },
    );
  });
  const request = install(providers.adsbLolProxy());
  await request('/api/adsblol/mil');
  now += 1000;
  const hit = await request('/api/adsblol/mil');
  assert.equal(hit.headers['x-ads-b-cache-age-ms'], '1000');
  now += 12000;
  const fallback = await request('/api/adsblol/mil');
  assert.equal(fallback.statusCode, 200);
  assert.equal(cancelled, true);
  assert.equal(fallback.headers['x-ads-b-cache-age-ms'], '23000');
  assert.equal(fallback.headers['x-ads-b-retry-after-seconds'], '20');
  now += 19000;
  await request('/api/adsblol/mil');
  assert.equal(callsTo(calls, 'api.adsb.lol'), 2);
  now += 2000;
  await request('/api/adsblol/mil');
  assert.equal(callsTo(calls, 'api.adsb.lol'), 3);
});

test('military cooldown bounds untrusted Retry-After and defaults server errors', async (t) => {
  silence(t);
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  for (const [status, raw, seconds] of [
    [429, '1', 5],
    [429, '99999', 120],
    [503, 'invalid', 15],
  ]) {
    now += 60_000;
    t.mock.method(globalThis, 'fetch', async (url) => {
      // Only the primary carries the header under test; the fallback feed is
      // simply down so its own Retry-After cannot leak into the answer.
      if (!url.includes('api.adsb.lol')) throw Error('offline');
      return new Response('{}', {
        status,
        headers: { 'Retry-After': raw },
      });
    });
    const result = await install(providers.adsbLolProxy())('/api/adsblol/mil');
    assert.equal(result.statusCode, 503);
    assert.equal(Number(result.headers['retry-after']), seconds);
    assert.equal(
      JSON.parse(result.body).provider.status,
      'unavailable',
      'a cold failure is a structured 503, never the raw upstream status',
    );
  }
});
