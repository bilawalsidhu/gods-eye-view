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

/** A response that streams 1 MiB chunks of `text` well past every cap, then ends. */
function oversizedResponse(text, init = {}) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new TextEncoder().encode(
    text.repeat(Math.ceil((1 << 20) / text.length)),
  );
  const response = new Response(
    new ReadableStream(
      {
        pull(controller) {
          if (++state.pulled > 40) controller.close();
          else controller.enqueue(chunk);
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    init,
  );
  return { response, state };
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
    (await states('/api/flights', '?lat=30&lon=-97')).statusCode,
    200,
  );
  assert.equal(
    (await states('/api/flights', '?lat=30&lon=-97')).headers[
      'x-opensky-cache'
    ],
    'HIT',
  );
  assert.equal(calls.length, 2);
  const tracks = install(providers.trackBackfillProxies(), true);
  assert.equal(
    (await tracks('/api/flights/track', '?icao24=ABC123')).statusCode,
    200,
  );
  await tracks('/api/flights/track', '?icao24=abc123');
  assert.equal(calls.filter((call) => call.url.includes('/token')).length, 1);
  assert.equal(calls.filter((call) => call.url.includes('/tracks/')).length, 1);
  assert.equal(
    (await tracks('/api/military/track', '?hex=invalid')).statusCode,
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
    '/api/flights',
    '?lat=30&lon=-97',
  );
  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.headers['x-flight-source'], 'adsb.lol');
  assert.equal(JSON.parse(fallback.body).states[0][0], 'abc123');
});

test('OpenSky global snapshot attempts are time-limited, retried once, then fall back', async (t) => {
  environment(t, {
    OPENSKY_CLIENT_ID: undefined,
    OPENSKY_CLIENT_SECRET: undefined,
    OPENSKY_AUTH_MODE: 'anon',
    OPENSKY_USERNAME: undefined,
    OPENSKY_PASSWORD: undefined,
  });
  t.mock.method(console, 'warn', () => {});
  const timedOut = () =>
    Promise.reject(
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ),
    );
  const load = async (respond) => {
    const attempts = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (url.includes('/states/')) {
        assert.ok(options.signal instanceof AbortSignal);
        attempts.push(url);
        return respond(attempts.length);
      }
      if (url.includes('/lat/'))
        return Response.json({
          now: Date.now() / 1000,
          ac: [{ hex: 'abc123', lat: 30, lon: -97, alt_baro: 10000 }],
        });
      throw Error(`Unexpected URL: ${url}`);
    });
    const fresh = await import(
      `../../server/providers/aircraft/opensky.js?timeout=${Math.random()}`
    );
    const response = await install(fresh.openSkyProxy())(
      '/api/flights',
      '?lat=30&lon=-97',
    );
    return { response, attempts };
  };
  const recovered = await load((attempt) =>
    attempt === 1
      ? timedOut()
      : Response.json({ time: Math.floor(Date.now() / 1000), states: [] }),
  );
  assert.equal(recovered.attempts.length, 2);
  assert.equal(recovered.response.statusCode, 200);
  assert.equal(recovered.response.headers['x-flight-source'], undefined);
  const stalled = await load(() => timedOut());
  assert.equal(stalled.attempts.length, 2);
  assert.equal(stalled.response.statusCode, 200);
  assert.equal(stalled.response.headers['x-flight-source'], 'adsb.lol');
});

const openSkyAnonEnv = {
  OPENSKY_CLIENT_ID: undefined,
  OPENSKY_CLIENT_SECRET: undefined,
  OPENSKY_AUTH_MODE: 'anon',
  OPENSKY_USERNAME: undefined,
  OPENSKY_PASSWORD: undefined,
};
const regionalFallback = () =>
  Response.json({
    now: Date.now() / 1000,
    ac: [{ hex: 'abc123', lat: 30, lon: -97, alt_baro: 10000 }],
  });

test('OpenSky 429 starts the cooldown from headers and cancels the body unread', async (t) => {
  environment(t, openSkyAnonEnv);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  let states = 0;
  let limited;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/states/')) {
      states++;
      limited = oversizedResponse('x', {
        status: 429,
        headers: { 'x-rate-limit-retry-after-seconds': '600' },
      });
      return limited.response;
    }
    if (url.includes('/lat/')) return regionalFallback();
    throw Error(`Unexpected URL: ${url}`);
  });
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?ratelimit=${Math.random()}`
  );
  const request = install(fresh.openSkyProxy());
  const first = await request('/api/flights', '?lat=30&lon=-97');
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['x-flight-source'], 'adsb.lol');
  assert.equal(states, 1, 'a rate-limited snapshot is not retried');
  assert.equal(limited.state.cancelled, true);
  assert.ok(limited.state.pulled <= 1, 'the 429 body is not read');
  const cooling = await request('/api/flights', '?lat=30&lon=-97');
  assert.equal(cooling.statusCode, 200);
  assert.equal(
    cooling.headers['x-opensky-auth-reason'],
    'opensky_cooldown_regional_fallback',
  );
  assert.equal(states, 1, 'the cooldown holds off the next upstream attempt');
});

test('OpenSky 429 without retry-after cools down for the 2 minute default', async (t) => {
  environment(t, openSkyAnonEnv);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const start = Date.now();
  let now = start;
  t.mock.method(Date, 'now', () => now);
  let states = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/states/')) {
      states++;
      return new Response('{}', { status: 429 });
    }
    if (url.includes('/lat/')) return regionalFallback();
    throw Error(`Unexpected URL: ${url}`);
  });
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?ratelimit-default=${Math.random()}`
  );
  const request = install(fresh.openSkyProxy());
  await request('/api/flights', '?lat=30&lon=-97');
  assert.equal(states, 1);
  // Past the 30 s floor but inside the 2 minute default.
  now = start + 90_000;
  await request('/api/flights', '?lat=30&lon=-97');
  assert.equal(states, 1, 'a missing header is not read as a zero wait');
});

test('OpenSky does not retry a snapshot body over the cap', async (t) => {
  environment(t, openSkyAnonEnv);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/states/')) {
      const oversized = oversizedResponse(' ');
      bodies.push(oversized.state);
      return oversized.response;
    }
    if (url.includes('/lat/')) return regionalFallback();
    throw Error(`Unexpected URL: ${url}`);
  });
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?oversize=${Math.random()}`
  );
  const response = await install(fresh.openSkyProxy())(
    '/api/flights',
    '?lat=30&lon=-97',
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-flight-source'], 'adsb.lol');
  assert.equal(bodies.length, 1, 'an oversized body is not fetched twice');
  assert.equal(bodies[0].cancelled, true);
  assert.ok(bodies[0].pulled <= 9, 'reading stops at the 8 MiB cap');
});

test('military aircraft route answers 502 to an oversized body without caching it', async (t) => {
  t.mock.method(console, 'error', () => {});
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async () => {
    const oversized = oversizedResponse('{"ac":[]}');
    bodies.push(oversized.state);
    return oversized.response;
  });
  const request = install(providers.adsbLolProxy());
  const first = await request('/api/military');
  assert.equal(first.statusCode, 502);
  assert.equal(bodies[0].cancelled, true);
  assert.ok(bodies[0].pulled <= 9, 'reading stops at the 8 MiB cap');
  const again = await request('/api/military');
  assert.equal(again.statusCode, 502, 'nothing was cached');
  assert.equal(bodies.length, 2);
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
  const first = await request('/api/military');
  assert.equal((await request('/api/military')).body, first.body);
  assert.equal(calls, 1);
  now += 13_000;
  assert.equal((await request('/api/military')).body, first.body);
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
    res = await request('/api/vessels');
    if (JSON.parse(res.body).rows.length) break;
    await delay(10);
  }
  const data = JSON.parse(res.body);
  assert.equal(data.status, 'live');
  assert.equal(data.rows[0].mmsi, '123456789');
  assert.equal(data.rows[0].heading, null);
  const history = await request('/api/vessels', '/track?mmsi=123456789');
  assert.equal(JSON.parse(history.body).samples.length, 2);
  assert.equal(
    (await request('/api/vessels', '/track?mmsi=bad')).statusCode,
    400,
  );
  assert.equal(sockets.length, 1);
  plugin.closeBundle();
  for (let i = 0; i < 100 && sockets[0].readyState !== 3; i++) await delay(10);
  assert.equal(sockets[0].readyState, 3);
  const restarted = install(plugin);
  await restarted('/api/vessels');
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
  const first = await request('/api/military');
  assert.equal(first.statusCode, 200);
  now += 13_000;
  const limited = await request('/api/military');
  assert.equal(calls, 2);
  assert.equal(
    limited.statusCode,
    200,
    'a 429 with a cached body is never relayed',
  );
  assert.equal(limited.body, first.body);
  assert.equal(limited.headers['x-feed-cache'], 'STALE');
  assert.equal(limited.headers['x-ads-b-upstream-status'], '429');
  assert.equal(limited.headers['x-feed-age-ms'], '13000');
  now += 5_000;
  const cooling = await request('/api/military');
  assert.equal(calls, 2, 'no upstream call inside the Retry-After window');
  assert.equal(cooling.headers['x-feed-cache'], 'STALE');
  assert.equal(cooling.headers['x-feed-age-ms'], '18000');
  now += 16_000;
  await request('/api/military');
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
  const limited = await request('/api/military');
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers['retry-after']);
  const again = await request('/api/military');
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
  await request('/api/military');
  now += 1000;
  const hit = await request('/api/military');
  assert.equal(hit.headers['x-feed-age-ms'], '1000');
  now += 12000;
  const fallback = await request('/api/military');
  assert.equal(fallback.statusCode, 200);
  assert.equal(cancelled, true);
  assert.equal(fallback.headers['x-feed-age-ms'], '23000');
  assert.equal(fallback.headers['x-ads-b-retry-after-seconds'], '20');
  now += 19000;
  await request('/api/military');
  assert.equal(calls, 2);
  now += 2000;
  await request('/api/military');
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
    const result = await install(providers.adsbLolProxy())('/api/military');
    assert.equal(Number(result.headers['retry-after']), seconds);
  }
});

test('track backfill proxy returns 502 on an oversized upstream body and caches it as an error', async (t) => {
  const tracks = install(providers.trackBackfillProxies(), true);
  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    callCount++;
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      body: (async function* () {
        yield Buffer.alloc(6 * 1024 * 1024, 'x');
      })(),
    };
  });

  const res1 = await tracks('/api/flights/track', '?icao24=def456');
  assert.equal(res1.statusCode, 502);
  assert.deepEqual(JSON.parse(res1.body), {
    error: 'Upstream track response too large',
  });

  // Cached as a 502 (never a 200): a retry inside the window neither
  // reads as an empty track nor spends OpenSky credits on another download.
  const res2 = await tracks('/api/flights/track', '?icao24=def456');
  assert.equal(res2.statusCode, 502);
  assert.equal(callCount, 1);
});

test('OpenSky Basic mode no longer sends username and password: it asks anonymously and warns once', async (t) => {
  environment(t, {
    OPENSKY_CLIENT_ID: undefined,
    OPENSKY_CLIENT_SECRET: undefined,
    OPENSKY_CREDENTIALS_FILE: undefined,
    OPENSKY_AUTH_MODE: 'basic',
    OPENSKY_USERNAME: 'fixture-user',
    OPENSKY_PASSWORD: 'fixture-password',
  });
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  const authorizations = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/states/')) {
      authorizations.push(options.headers.Authorization);
      return Response.json({ time: Math.floor(Date.now() / 1000), states: [] });
    }
    throw Error(`Unexpected URL: ${url}`);
  });
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?basic=${Math.random()}`
  );
  const flights = install(fresh.openSkyProxy());
  const first = await flights('/api/flights');
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['x-opensky-auth'], 'anon');
  assert.equal(first.headers['x-opensky-auth-reason'], 'basic_retired');
  assert.deepEqual(authorizations, [undefined]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /retired username\/password sign-in/);
  assert.ok(!warnings[0].includes('fixture-password'));
});

test('OpenSky auto mode never falls back to Basic, even when OAuth is rejected', async (t) => {
  environment(t, {
    OPENSKY_CLIENT_ID: 'fixture-client',
    OPENSKY_CLIENT_SECRET: 'fixture-secret',
    OPENSKY_CREDENTIALS_FILE: undefined,
    OPENSKY_AUTH_MODE: 'auto',
    OPENSKY_USERNAME: 'fixture-user',
    OPENSKY_PASSWORD: 'fixture-password',
  });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const authorizations = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/token'))
      return Response.json({ access_token: 'fixture-token', expires_in: 1800 });
    if (url.includes('/states/')) {
      authorizations.push(options.headers.Authorization);
      return new Response('', { status: 401 });
    }
    if (url.includes('/lat/')) return regionalFallback();
    throw Error(`Unexpected URL: ${url}`);
  });
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?auto=${Math.random()}`
  );
  await install(fresh.openSkyProxy())('/api/flights', '?lat=30&lon=-97');
  assert.deepEqual(authorizations, ['Bearer fixture-token']);
});

test('retired military history refuses without upstream I/O while validating identifiers', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('retired history must not contact the upstream');
  });
  const route = install(providers.trackBackfillProxies());
  for (const hex of ['abc123', 'abc456']) {
    const response = await route('/api/military/track', '?hex=' + hex);
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.body).code, 'history_unavailable');
    assert.equal(response.headers['retry-after'], '1800');
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(
    (await route('/api/military/track', '?hex=invalid')).statusCode,
    400,
  );
});

test('global aircraft snapshots coalesce cold and expired callers and clear rejected flights', async (t) => {
  environment(t, { OPENSKY_AUTH_MODE: 'anon' });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const kind of ['opensky', 'military']) {
    const module =
      kind === 'opensky'
        ? await import(
            `../../server/providers/aircraft/opensky.js?coalesce=${Math.random()}`
          )
        : await import('../../server/providers/aircraft/adsb-lol.js');
    const request = install(
      kind === 'opensky' ? module.openSkyProxy() : module.adsbLolProxy(),
    );
    const route = kind === 'opensky' ? '/api/flights' : '/api/military';
    let calls = 0;
    let release;
    let blocked;
    let fail = false;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      await blocked;
      if (fail) throw new Error('fixture connection failed');
      return Response.json(
        { time: now / 1000, states: [], ac: [] },
        { headers: { 'x-rate-limit-remaining': '5000' } },
      );
    });
    for (const phase of ['cold', 'expired', 'failed', 'recovered']) {
      now += 13000;
      fail = phase === 'failed';
      blocked = new Promise((resolve) => {
        release = resolve;
      });
      const before = calls;
      const pending = Array.from({ length: 5 }, () => request(route));
      await new Promise(setImmediate);
      assert.equal(calls - before, 1, `${kind} ${phase}: one refresh starts`);
      release();
      const responses = await Promise.all(pending);
      assert.equal(calls - before, fail && kind === 'opensky' ? 2 : 1);
      assert.ok(responses.every((res) => res.statusCode === 200));
      assert.ok(responses.every((res) => res.body === responses[0].body));
    }
  }
});

test('OpenSky 5xx retains dated last-good data, cancels error bodies and cools down before recovery', async (t) => {
  environment(t, { OPENSKY_AUTH_MODE: 'anon' });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const status of [502, 503, 504]) {
    const module = await import(
      `../../server/providers/aircraft/opensky.js?server-error=${status}`
    );
    const request = install(module.openSkyProxy());
    let fail = false;
    let calls = 0;
    let cancelled = false;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      if (fail)
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status },
        );
      return Response.json(
        { time: now / 1000, states: [] },
        { headers: { 'x-rate-limit-remaining': '5000' } },
      );
    });
    const good = await request('/api/flights');
    now += 10000;
    fail = true;
    const stale = await request('/api/flights');
    assert.equal(stale.statusCode, 200);
    assert.equal(stale.body, good.body);
    assert.equal(stale.headers['x-opensky-cache'], 'STALE');
    assert.equal(
      stale.headers['x-opensky-auth-reason'],
      `upstream_http_${status}_serving_stale`,
    );
    assert.equal(stale.headers['x-opensky-stale-seconds'], '10');
    assert.equal(cancelled, true);
    const cooling = await request('/api/flights');
    assert.equal(cooling.body, good.body);
    assert.equal(
      cooling.headers['x-opensky-auth-reason'],
      `upstream_http_${status}_serving_stale`,
    );
    assert.equal(calls, 2);
    now += 16000;
    fail = false;
    assert.equal(
      (await request('/api/flights')).headers['x-opensky-cache'],
      'MISS',
    );
    assert.equal(calls, 3);
  }
  const coldModule =
    await import('../../server/providers/aircraft/opensky.js?cold-server-error');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('<html>failure</html>', { status: 503 });
  });
  const cold = install(coldModule.openSkyProxy());
  for (let i = 0; i < 2; i++) {
    const response = await cold('/api/flights');
    assert.equal(response.statusCode, 503);
    assert.match(JSON.parse(response.body).error, /OpenSky/);
  }
  assert.equal(calls, 1);
});
