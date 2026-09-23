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
  return async (route, url = '/', method = 'GET', remoteAddress = 'local') => {
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
    await routes.get(route)(
      { url, method, socket: { remoteAddress } },
      response,
    );
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

test('live entry resolves in Node and aircraft normalization stays independently portable', async () => {
  const entry = await import('gods-eye-view/server/providers/live');
  assert.equal(entry.openSkyProxy, providers.openSkyProxy);
  assert.equal(entry.aisLiveProxy, providers.aisLiveProxy);
  const normalizer = await import('gods-eye-view/sources/adsb-lol');
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
  assert.equal(
    (await states('/api/opensky', '?lat=30&lon=-97')).statusCode,
    200,
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
      return Response.json({
        now: now / 1000,
        ac: [{ hex: 'abc123', lat: 30, lon: -97, alt_baro: 10000 }],
      });
    throw Error(`Unexpected URL: ${url}`);
  });
  // A fresh request without a usable cached worldwide frame should use the regional feed.
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?fallback=${now}`
  );
  process.env.OPENSKY_AUTH_MODE = 'anon';
  const fallback = await install(fresh.openSkyProxy())(
    '/api/opensky',
    '?lat=30&lon=-97',
  );
  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.headers['x-flight-source'], 'adsb.lol');
  assert.equal(JSON.parse(fallback.body).states[0][0], 'abc123');
});

test('military aircraft route preserves fresh cache and stale response after upstream failure', async (t) => {
  let now = Date.now();
  let calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls > 1) throw Error('offline');
    return Response.json({ ac: [{ hex: 'abc123' }] });
  });
  const request = install(providers.adsbLolProxy());
  const first = await request('/api/adsblol/mil');
  assert.equal((await request('/api/adsblol/mil')).body, first.body);
  assert.equal(calls, 1);
  now += 13_000;
  assert.equal((await request('/api/adsblol/mil')).body, first.body);
  assert.equal(calls, 2);
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
  let calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls === 1) return Response.json({ ac: [{ hex: 'abc123' }] });
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
  assert.equal(calls, 2);
  assert.equal(
    limited.statusCode,
    200,
    'a 429 with a cached body is never relayed',
  );
  assert.equal(limited.body, first.body);
  assert.equal(limited.headers['x-ads-b-cache'], 'STALE');
  assert.equal(limited.headers['x-ads-b-upstream-status'], '429');
  assert.equal(limited.headers['x-ads-b-cache-age-ms'], '13000');
  now += 5_000;
  const cooling = await request('/api/adsblol/mil');
  assert.equal(calls, 2, 'no upstream call inside the Retry-After window');
  assert.equal(cooling.headers['x-ads-b-cache'], 'STALE');
  assert.equal(cooling.headers['x-ads-b-cache-age-ms'], '18000');
  now += 16_000;
  await request('/api/adsblol/mil');
  assert.equal(calls, 3, 'upstream is retried once Retry-After elapses');
});

test('military aircraft route relays an upstream 429 when nothing is cached', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('{"error":"rate limited"}', { status: 429 });
  });
  const request = install(providers.adsbLolProxy());
  const limited = await request('/api/adsblol/mil');
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers['retry-after']);
  const again = await request('/api/adsblol/mil');
  assert.equal(again.statusCode, 429);
  assert.equal(
    calls,
    1,
    'the cooldown still protects upstream with nothing cached',
  );
  assert.ok(
    again.headers['retry-after'],
    'a cooling-down miss carries Retry-After',
  );
});

test('military fallback cancels a stalled 5xx body and starts cooldown at receipt', async (t) => {
  let now = 1_800_000_000_000;
  let calls = 0;
  let cancelled = false;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return Response.json({ ac: [] });
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
  assert.equal(calls, 2);
  now += 2000;
  await request('/api/adsblol/mil');
  assert.equal(calls, 3);
});

test('military cooldown bounds untrusted Retry-After and defaults server errors', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const [status, raw, seconds] of [
    [429, '1', 5],
    [429, '99999', 120],
    [503, 'invalid', 15],
  ]) {
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response('{}', {
          status,
          headers: { 'Retry-After': raw },
        }),
    );
    const result = await install(providers.adsbLolProxy())('/api/adsblol/mil');
    assert.equal(Number(result.headers['retry-after']), seconds);
  }
});

test('track backfill proxies return 502 on oversized upstream responses without caching failure', async (t) => {
  environment(t, {
    OPENSKY_AUTH_MODE: 'anon',
    OPENSKY_CLIENT_ID: undefined,
    OPENSKY_CLIENT_SECRET: undefined,
  });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let streamCancelled = false;
  let openSkyCalls = 0;
  let adsbLolCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('ffffff')) {
      openSkyCalls += 1;
      return new Response('Not Found', { status: 404 });
    }
    if (url.includes('/tracks/')) {
      openSkyCalls += 1;
      if (openSkyCalls === 1) {
        return new Response('{"oversized":true}', {
          status: 200,
          headers: { 'content-length': String(6 * 1024 * 1024) },
        });
      }
      return Response.json({ path: [[1, 2, 3]] });
    }
    if (url.includes('/traces/')) {
      adsbLolCalls += 1;
      if (adsbLolCalls === 1) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(3 * 1024 * 1024));
              controller.enqueue(new Uint8Array(3 * 1024 * 1024));
            },
            cancel() {
              streamCancelled = true;
            },
          }),
          { status: 200 },
        );
      }
      return Response.json({ trace: [{ hex: 'c0ffee' }] });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });

  const tracks = install(providers.trackBackfillProxies());

  // 1. OpenSky track route: >5 MiB upstream response
  const oskyOversized = await tracks('/api/opensky-track', '?icao24=a1b2c3');
  assert.equal(
    oskyOversized.statusCode,
    502,
    'oversized OpenSky track response yields 502',
  );
  assert.deepEqual(JSON.parse(oskyOversized.body), {
    error: 'Upstream track response too large',
  });
  assert.equal(openSkyCalls, 1);

  // A short cooldown blocks repeated oversized downloads, not a later valid response.
  const oskyCooldown = await tracks('/api/opensky-track', '?icao24=a1b2c3');
  assert.equal(oskyCooldown.statusCode, 429);
  assert.equal(openSkyCalls, 1);
  now += 5_001;
  const oskyRefetch = await tracks('/api/opensky-track', '?icao24=a1b2c3');
  assert.equal(oskyRefetch.statusCode, 200);
  assert.deepEqual(JSON.parse(oskyRefetch.body), { path: [[1, 2, 3]] });
  assert.equal(openSkyCalls, 2);

  // Valid response should be cached
  const oskyCached = await tracks('/api/opensky-track', '?icao24=a1b2c3');
  assert.equal(oskyCached.statusCode, 200);
  assert.equal(openSkyCalls, 2, 'valid OpenSky response was cached');

  // 2. adsb.lol trace route: >5 MiB upstream response
  const lolOversized = await Promise.race([
    tracks('/api/adsblol/trace', '?hex=c0ffee'),
    delay(1_000).then(() => {
      throw new Error('oversized live stream did not terminate promptly');
    }),
  ]);
  assert.equal(
    lolOversized.statusCode,
    502,
    'oversized adsb.lol trace response yields 502',
  );
  assert.deepEqual(JSON.parse(lolOversized.body), {
    error: 'Upstream track response too large',
  });
  assert.equal(adsbLolCalls, 1);
  assert.equal(streamCancelled, true, 'oversized live stream is cancelled');

  const lolCooldown = await tracks('/api/adsblol/trace', '?hex=c0ffee');
  assert.equal(lolCooldown.statusCode, 429);
  assert.equal(adsbLolCalls, 1);
  now += 5_001;
  const lolRefetch = await tracks('/api/adsblol/trace', '?hex=c0ffee');
  assert.equal(lolRefetch.statusCode, 200);
  assert.deepEqual(JSON.parse(lolRefetch.body), { trace: [{ hex: 'c0ffee' }] });
  assert.equal(adsbLolCalls, 2);

  // Valid response should be cached
  const lolCached = await tracks('/api/adsblol/trace', '?hex=c0ffee');
  assert.equal(lolCached.statusCode, 200);
  assert.equal(adsbLolCalls, 2, 'valid adsb.lol response was cached');

  // 3. Existing upstream HTTP statuses (e.g. 404) keep established semantics (forwarded and cached)
  const osky404First = await tracks('/api/opensky-track', '?icao24=ffffff');
  assert.equal(osky404First.statusCode, 404);
  assert.deepEqual(JSON.parse(osky404First.body), {
    error: 'Track source HTTP 404',
  });
  const callsBeforeCached404 = openSkyCalls;
  const osky404Second = await tracks('/api/opensky-track', '?icao24=ffffff');
  assert.equal(osky404Second.statusCode, 404);
  assert.deepEqual(JSON.parse(osky404Second.body), {
    error: 'Track source HTTP 404',
  });
  assert.equal(openSkyCalls, callsBeforeCached404, 'upstream 404 was cached');
});

test('OpenSky track respects configured auth mode after an OAuth token was cached', async (t) => {
  environment(t, {
    OPENSKY_AUTH_MODE: 'oauth',
    OPENSKY_CLIENT_ID: 'fixture-client',
    OPENSKY_CLIENT_SECRET: 'fixture-secret',
    OPENSKY_USERNAME: 'pilot',
    OPENSKY_PASSWORD: 'secret',
  });
  const headers = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/token'))
      return Response.json({ access_token: 'fixture-token', expires_in: 1800 });
    headers.push(options.headers);
    return Response.json({ path: [] });
  });
  const tracks = install(providers.trackBackfillProxies());
  assert.equal(
    (await tracks('/api/opensky-track', '?icao24=abc123')).statusCode,
    200,
  );
  process.env.OPENSKY_AUTH_MODE = 'anon';
  assert.equal(
    (await tracks('/api/opensky-track', '?icao24=abc124')).statusCode,
    200,
  );
  assert.equal(headers[0].Authorization, 'Bearer fixture-token');
  assert.equal(headers[1].Authorization, undefined);
  process.env.OPENSKY_AUTH_MODE = 'basic';
  assert.equal(
    (await tracks('/api/opensky-track', '?icao24=abc125')).statusCode,
    200,
  );
  assert.equal(
    headers[2].Authorization,
    `Basic ${Buffer.from('pilot:secret').toString('base64')}`,
  );
});

test('track backfill coalesces requests and bounds concurrent and per-client misses', async (t) => {
  environment(t, { OPENSKY_AUTH_MODE: 'anon' });
  let release;
  let gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let pending = 0;
  let peak = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    pending++;
    peak = Math.max(peak, pending);
    await gate;
    pending--;
    return Response.json({ path: [] });
  });
  const tracks = install(providers.trackBackfillProxies());
  const sameKey = Array.from({ length: 6 }, () =>
    tracks('/api/opensky-track', '?icao24=abc123'),
  );
  release();
  assert.deepEqual(
    (await Promise.all(sameKey)).map((response) => response.statusCode),
    [200, 200, 200, 200, 200, 200],
  );
  assert.equal(calls, 1, 'simultaneous same-key requests share one fetch');

  gate = new Promise((resolve) => {
    release = resolve;
  });
  const differentKeys = Array.from({ length: 5 }, (_, index) =>
    tracks(
      '/api/opensky-track',
      `?icao24=${(index + 1).toString(16).padStart(6, '0')}`,
    ),
  );
  await delay(0);
  assert.equal(peak, 3, 'a slot remains available for adsb.lol');
  release();
  assert.deepEqual(
    (await Promise.all(differentKeys))
      .map((response) => response.statusCode)
      .sort(),
    [200, 200, 200, 429, 429],
  );
  for (let index = 0; index < 26; index++) {
    const response = await tracks(
      '/api/opensky-track',
      `?icao24=${(index + 100).toString(16).padStart(6, '0')}`,
    );
    assert.equal(response.statusCode, 200);
  }
  assert.equal(
    (await tracks('/api/opensky-track', '?icao24=0000ff')).statusCode,
    429,
  );
  assert.equal(calls, 30);
  for (let index = 0; index < 30; index++) {
    const response = await tracks(
      '/api/adsblol/trace',
      `?hex=${(index + 300).toString(16).padStart(6, '0')}`,
      'GET',
      '192.0.2.2',
    );
    assert.equal(response.statusCode, 200);
  }
  assert.equal(
    (await tracks('/api/adsblol/trace', '?hex=00cafe', 'GET', '192.0.2.3'))
      .statusCode,
    429,
    'global minute limit applies across separate clients',
  );
  assert.equal(calls, 60);
});

test('track cache evicts large responses before aggregate memory grows without bound', async (t) => {
  environment(t, { OPENSKY_AUTH_MODE: 'anon' });
  const body = JSON.stringify({ path: 'x'.repeat(4 * 1024 * 1024) });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(body, {
      headers: { 'content-type': 'application/json' },
    });
  });
  const tracks = install(providers.trackBackfillProxies());
  for (let index = 0; index < 7; index++) {
    assert.equal(
      (
        await tracks(
          '/api/opensky-track',
          `?icao24=${index.toString(16).padStart(6, '0')}`,
        )
      ).statusCode,
      200,
    );
  }
  await tracks('/api/opensky-track', '?icao24=000006');
  assert.equal(calls, 7, 'recent large response remains cached');
  await tracks('/api/opensky-track', '?icao24=000000');
  assert.equal(calls, 8, 'old large response was evicted');
});

test('OpenSky track budget bounds daily quota independently of the minute window', async (t) => {
  environment(t, { OPENSKY_AUTH_MODE: 'anon' });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ path: [] });
  });
  const tracks = install(providers.trackBackfillProxies());
  for (let index = 0; index < 250; index++) {
    assert.equal(
      (
        await tracks(
          '/api/opensky-track',
          `?icao24=${index.toString(16).padStart(6, '0')}`,
        )
      ).statusCode,
      200,
    );
    now += 60_001;
  }
  const denied = await tracks('/api/opensky-track', '?icao24=0000fa');
  assert.equal(denied.statusCode, 429);
  assert.equal(
    Number(denied.headers['retry-after']),
    Math.ceil((86_400_000 - 250 * 60_001) / 1000),
  );
  assert.equal(calls, 250);
  for (let index = 0; index < 60; index++) {
    const response = await tracks(
      '/api/opensky-track',
      `?icao24=${(index + 1_000).toString(16).padStart(6, '0')}`,
      'GET',
      index < 30 ? '192.0.2.1' : '192.0.2.2',
    );
    assert.equal(response.statusCode, 429);
  }
  assert.equal(
    (await tracks('/api/adsblol/trace', '?hex=c0ffee', 'GET', '192.0.2.3'))
      .statusCode,
    200,
    'daily OpenSky denials cannot consume adsb.lol admission',
  );
  assert.equal(calls, 251);
  now += 86_400_001;
  assert.equal(
    (await tracks('/api/opensky-track', '?icao24=0000fa')).statusCode,
    200,
  );
});

test('OpenSky track auto mode retries Basic after a rejected bearer token', async (t) => {
  environment(t, {
    OPENSKY_AUTH_MODE: 'auto',
    OPENSKY_CLIENT_ID: 'fixture-client',
    OPENSKY_CLIENT_SECRET: 'fixture-secret',
    OPENSKY_USERNAME: 'pilot',
    OPENSKY_PASSWORD: 'secret',
  });
  const authorizations = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/token'))
      return Response.json({ access_token: 'fixture-token', expires_in: 1800 });
    authorizations.push(options.headers.Authorization);
    if (options.headers.Authorization.startsWith('Bearer '))
      return new Response('{}', { status: 401 });
    return Response.json({ path: [[1, 2, 3]] });
  });
  const tracks = install(providers.trackBackfillProxies());
  const first = await tracks('/api/opensky-track', '?icao24=abc123');
  assert.equal(first.statusCode, 200);
  assert.deepEqual(JSON.parse(first.body), { path: [[1, 2, 3]] });
  await tracks('/api/opensky-track', '?icao24=abc123');
  assert.equal(authorizations.length, 2, 'the valid fallback is cached');
  assert.match(authorizations[0], /^Bearer /);
  assert.equal(
    authorizations[1],
    `Basic ${Buffer.from('pilot:secret').toString('base64')}`,
  );
});

test('stalled OpenSky token acquisition cannot starve adsb.lol tracks', async (t) => {
  environment(t, {
    OPENSKY_AUTH_MODE: 'oauth',
    OPENSKY_CLIENT_ID: 'fixture-client',
    OPENSKY_CLIENT_SECRET: 'fixture-secret',
  });
  const now = Date.now() + 3_600_000;
  t.mock.method(Date, 'now', () => now);
  let releaseAuth;
  const authGate = new Promise((resolve) => {
    releaseAuth = resolve;
  });
  let tokenSignal;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/token')) {
      tokenSignal = options.signal;
      await authGate;
      return Response.json({ access_token: 'fixture-token', expires_in: 1800 });
    }
    if (url.includes('/traces/')) return Response.json({ trace: [] });
    if (url.includes('/tracks/')) return Response.json({ path: [] });
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  const tracks = install(providers.trackBackfillProxies());
  const openSky = Array.from({ length: 4 }, (_, index) =>
    tracks(
      '/api/opensky-track',
      `?icao24=${(index + 1).toString(16).padStart(6, '0')}`,
    ),
  );
  await delay(0);
  const adsb = tracks('/api/adsblol/trace', '?hex=c0ffee');
  releaseAuth();
  assert.ok(tokenSignal instanceof AbortSignal, 'OAuth fetch has a deadline');
  assert.equal((await adsb).statusCode, 200);
  assert.deepEqual(
    (await Promise.all(openSky)).map((response) => response.statusCode).sort(),
    [200, 200, 200, 429],
  );
});

test('coalesced OpenSky state auto mode still retries Basic on bearer rejection', async (t) => {
  environment(t, {
    OPENSKY_AUTH_MODE: 'auto',
    OPENSKY_CLIENT_ID: 'fixture-client',
    OPENSKY_CLIENT_SECRET: 'fixture-secret',
    OPENSKY_USERNAME: 'pilot',
    OPENSKY_PASSWORD: 'secret',
  });
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'log', () => {});
  const authorizations = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/token'))
      return Response.json({ access_token: 'fixture-token', expires_in: 1800 });
    authorizations.push(options.headers.Authorization);
    if (options.headers.Authorization.startsWith('Bearer '))
      return new Response('{}', { status: 401 });
    return Response.json({ time: Math.floor(now / 1000), states: [] });
  });
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?state-basic=${now}`
  );
  const states = install(fresh.openSkyProxy());
  const simultaneous = await Promise.all(
    Array.from({ length: 3 }, () => states('/api/opensky', '/')),
  );
  assert.deepEqual(
    simultaneous.map((response) => response.statusCode),
    [200, 200, 200],
  );
  assert.equal(simultaneous[0].headers['x-opensky-auth-mode-used'], 'basic');
  assert.equal(authorizations.length, 2, 'one bearer and one Basic request');
  assert.match(authorizations[0], /^Bearer /);
  assert.equal(
    authorizations[1],
    `Basic ${Buffer.from('pilot:secret').toString('base64')}`,
  );
});

test('OpenSky state cache misses share one bounded upstream fetch', async (t) => {
  environment(t, { OPENSKY_AUTH_MODE: 'anon' });
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let deadline;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    deadline = options.signal;
    await gate;
    return Response.json({ time: Math.floor(now / 1000), states: [] });
  });
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?state-singleflight=${now}`
  );
  const states = install(fresh.openSkyProxy());
  const simultaneous = Array.from({ length: 5 }, () =>
    states('/api/opensky', '/'),
  );
  await delay(0);
  assert.equal(calls, 1, 'simultaneous state misses share one fetch');
  assert.ok(deadline instanceof AbortSignal, 'upstream fetch has a deadline');
  release();
  assert.deepEqual(
    (await Promise.all(simultaneous)).map((response) => response.statusCode),
    [200, 200, 200, 200, 200],
  );
  assert.equal((await states('/api/opensky', '/')).statusCode, 200);
  assert.equal(calls, 1, 'completed snapshot is cached');
});

test('OpenSky state rejects oversized upstream bodies without caching them', async (t) => {
  environment(t, { OPENSKY_AUTH_MODE: 'anon' });
  t.mock.method(console, 'error', () => {});
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1)
      return new Response('{}', {
        headers: { 'content-length': String(40 * 1024 * 1024) },
      });
    return Response.json({ time: Math.floor(now / 1000), states: [] });
  });
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?state-oversized=${now}`
  );
  const states = install(fresh.openSkyProxy());
  const oversized = await states('/api/opensky', '/');
  assert.equal(oversized.statusCode, 502);
  assert.deepEqual(JSON.parse(oversized.body), {
    error: 'OpenSky proxy error',
  });
  assert.equal((await states('/api/opensky', '/')).statusCode, 200);
  assert.equal(calls, 2, 'oversized error was not cached');
});

test('OpenSky state protects quota when the remaining-budget header is absent', async (t) => {
  environment(t, { OPENSKY_AUTH_MODE: 'anon' });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ time: Math.floor(now / 1000), states: [] });
  });
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?state-no-remaining=${now}`
  );
  const states = install(fresh.openSkyProxy());
  assert.equal((await states('/api/opensky', '/')).statusCode, 200);
  now += 10_000;
  assert.equal((await states('/api/opensky', '/')).statusCode, 200);
  assert.equal(calls, 1, 'missing budget uses conservative five-minute TTL');
  now += 290_001;
  assert.equal((await states('/api/opensky', '/')).statusCode, 200);
  assert.equal(calls, 2);
});

test('OpenSky state uses the default cooldown when Retry-After is absent', async (t) => {
  environment(t, { OPENSKY_AUTH_MODE: 'anon' });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('{}', { status: 429 });
  });
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?state-no-retry=${now}`
  );
  const states = install(fresh.openSkyProxy());
  assert.equal((await states('/api/opensky', '/')).statusCode, 429);
  now += 40_000;
  const cooled = await states('/api/opensky', '/');
  assert.equal(cooled.statusCode, 429);
  assert.equal(cooled.headers['x-opensky-cache'], 'COOLDOWN');
  assert.equal(calls, 1, 'missing header must cool down for two minutes');
});

test('OpenSky state honors rate-limit cooldown even when the 429 body is oversized', async (t) => {
  environment(t, { OPENSKY_AUTH_MODE: 'anon' });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('{}', {
      status: 429,
      headers: {
        'x-rate-limit-retry-after-seconds': '120',
        'content-length': String(40 * 1024 * 1024),
      },
    });
  });
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?state-oversized-429=${now}`
  );
  const states = install(fresh.openSkyProxy());
  const limited = await states('/api/opensky', '/');
  assert.equal(limited.statusCode, 429);
  now += 40_000;
  const cooled = await states('/api/opensky', '/');
  assert.equal(cooled.statusCode, 429);
  assert.equal(cooled.headers['x-opensky-cache'], 'COOLDOWN');
  assert.equal(calls, 1, 'oversized 429 must still prevent repeated requests');
});

test('OpenSky state serves last-good cache after a 503 without regional coordinates', async (t) => {
  environment(t, { OPENSKY_AUTH_MODE: 'anon' });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls === 1
      ? Response.json(
          { time: Math.floor(now / 1000), states: [] },
          { headers: { 'x-rate-limit-remaining': '4000' } },
        )
      : new Response('{}', { status: 503 });
  });
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?state-503-stale=${now}`
  );
  const states = install(fresh.openSkyProxy());
  assert.equal((await states('/api/opensky', '/')).statusCode, 200);
  now += 10_000;
  const stale = await states('/api/opensky', '/');
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.headers['x-opensky-cache'], 'STALE');
  assert.equal(calls, 2);
});

test('OpenSky state prefers regional data to an obsolete cache on 429', async (t) => {
  environment(t, { OPENSKY_AUTH_MODE: 'anon' });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/lat/'))
      return Response.json({
        now: now / 1000,
        ac: [{ hex: 'abc123', lat: 30, lon: -97, alt_baro: 10000 }],
      });
    calls++;
    return calls === 1
      ? Response.json(
          { time: Math.floor(now / 1000), states: [] },
          { headers: { 'x-rate-limit-remaining': '4000' } },
        )
      : new Response('{}', { status: 429 });
  });
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?state-429-regional=${now}`
  );
  const states = install(fresh.openSkyProxy());
  assert.equal(
    (await states('/api/opensky', '?lat=30&lon=-97')).statusCode,
    200,
  );
  now += 130_000;
  const regional = await states('/api/opensky', '?lat=30&lon=-97');
  assert.equal(regional.statusCode, 200);
  assert.equal(regional.headers['x-flight-source'], 'adsb.lol');
  assert.equal(calls, 2);
});

test('OpenSky state prefers regional data to an obsolete cache after a fetch failure', async (t) => {
  environment(t, { OPENSKY_AUTH_MODE: 'anon' });
  t.mock.method(console, 'error', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/lat/'))
      return Response.json({
        now: now / 1000,
        ac: [{ hex: 'abc123', lat: 30, lon: -97, alt_baro: 10000 }],
      });
    calls++;
    if (calls === 1)
      return Response.json(
        { time: Math.floor(now / 1000), states: [] },
        { headers: { 'x-rate-limit-remaining': '4000' } },
      );
    throw new Error('upstream offline');
  });
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?state-error-regional=${now}`
  );
  const states = install(fresh.openSkyProxy());
  assert.equal(
    (await states('/api/opensky', '?lat=30&lon=-97')).statusCode,
    200,
  );
  now += 130_000;
  const regional = await states('/api/opensky', '?lat=30&lon=-97');
  assert.equal(regional.statusCode, 200);
  assert.equal(regional.headers['x-flight-source'], 'adsb.lol');
  assert.equal(calls, 2);
});
