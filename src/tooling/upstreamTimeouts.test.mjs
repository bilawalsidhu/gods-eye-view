import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

// Node's fetch only gives up on a silent upstream after undici's 300 s header
// and body timeouts. These routes previously passed no signal, so one stalled
// connection held the caller for five minutes — and a stalled OpenSky token
// request held every flight poll that awaited it. Each test makes the route's
// timeout expire immediately against an upstream that never answers, and
// requires the route to answer through its normal failure path.

const UPSTREAM_TIMEOUT_CEILING_MS = 30_000;

/**
 * Replace AbortSignal.timeout with a signal that expires on the next turn,
 * recording each requested budget.
 */
function expireTimeoutsImmediately(t) {
  const budgets = [];
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    budgets.push(ms);
    const controller = new AbortController();
    setImmediate(() =>
      controller.abort(
        new DOMException('The operation timed out.', 'TimeoutError'),
      ),
    );
    return controller.signal;
  });
  return budgets;
}

/** An upstream that never responds; it only settles when its signal aborts. */
function stalledUpstream(url, options) {
  const signal = options?.signal;
  if (!signal)
    return Promise.reject(new Error(`no abort signal for upstream ${url}`));
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason));
  });
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

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return (route, url = '/', req = {}) => invoke(routes.get(route), url, req);
}

async function invoke(handler, url, req = {}) {
  assert.ok(handler, 'route is registered');
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
  // A request body stream must reach the handler as the same object.
  const request =
    req instanceof Readable
      ? Object.assign(req, { url })
      : { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, ...req, url };
  await handler(request, response);
  return response;
}

function assertBounded(budgets, expectedCount) {
  assert.equal(budgets.length, expectedCount);
  for (const ms of budgets)
    assert.ok(
      ms > 0 && ms <= UPSTREAM_TIMEOUT_CEILING_MS,
      `timeout ${ms} ms is bounded`,
    );
}

test('a stalled OpenSky token request times out and the poll still reaches /states/all', async (t) => {
  environment(t, {
    OPENSKY_CLIENT_ID: 'fixture-client',
    OPENSKY_CLIENT_SECRET: 'fixture-secret',
    OPENSKY_AUTH_MODE: 'oauth',
  });
  t.mock.method(console, 'warn', () => {});
  const budgets = expireTimeoutsImmediately(t);
  const now = Date.now();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/token')) return stalledUpstream(url, options);
    if (url.includes('/states/'))
      return Response.json({ time: Math.floor(now / 1000), states: [] });
    throw Error(`Unexpected URL: ${url}`);
  });
  const { openSkyProxy } = await import(
    `../../server/providers/aircraft/opensky.js?token-timeout=${now}`
  );

  const response = await install(openSkyProxy())(
    '/api/flights',
    '?lat=30&lon=-97',
  );

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.headers['x-opensky-auth-reason'],
    'oauth_invalid_or_missing',
  );
  assertBounded(budgets, 2);
});

test('a stalled OpenSky /states/all times out into the regional fallback', async (t) => {
  environment(t, {
    OPENSKY_AUTH_MODE: 'anon',
    OPENSKY_CLIENT_ID: undefined,
    OPENSKY_CLIENT_SECRET: undefined,
  });
  t.mock.method(console, 'error', () => {});
  const budgets = expireTimeoutsImmediately(t);
  const now = Date.now();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/states/')) return stalledUpstream(url, options);
    if (url.includes('/lat/'))
      return Response.json({
        now: now / 1000,
        ac: [{ hex: 'abc123', lat: 30, lon: -97, alt_baro: 10000 }],
      });
    throw Error(`Unexpected URL: ${url}`);
  });
  const { openSkyProxy } = await import(
    `../../server/providers/aircraft/opensky.js?states-timeout=${now}`
  );

  const response = await install(openSkyProxy())(
    '/api/flights',
    '?lat=30&lon=-97',
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-flight-source'], 'adsb.lol');
  // The snapshot fetch retries once after a timeout, so two attempts expire.
  assertBounded(budgets, 2);
});

test('a stalled adsb.lol military request times out into the proxy error', async (t) => {
  t.mock.method(console, 'error', () => {});
  const budgets = expireTimeoutsImmediately(t);
  t.mock.method(globalThis, 'fetch', stalledUpstream);
  const { adsbLolProxy } =
    await import('../../server/providers/aircraft/adsb-lol.js');

  const response = await install(adsbLolProxy())('/api/military');

  assert.equal(response.statusCode, 502);
  assertBounded(budgets, 1);
});

test('stalled Google Places requests time out into the 502 path', async (t) => {
  environment(t, {
    GOOGLE_MAPS_API_KEY: 'fixture-key',
    GEV_RATELIMIT_GOOGLE_PER_MIN: undefined,
  });
  const budgets = expireTimeoutsImmediately(t);
  const { googlePlacesContextProxy } =
    await import('../../server/providers/places/google.js');
  const request = install(
    googlePlacesContextProxy({
      resolveApiKey: () => process.env.GOOGLE_MAPS_API_KEY,
      fetchImpl: stalledUpstream,
    }),
  );

  const nearby = await request(
    '/api/google/nearby-places',
    '/?lat=30.27&lon=-97.74',
  );
  const text = await request(
    '/api/google/text-search',
    '/?q=capitol&lat=30.27&lon=-97.74',
  );

  assert.equal(nearby.statusCode, 502);
  assert.equal(text.statusCode, 502);
  assertBounded(budgets, 2);
});

test('a stalled OpenAI HUD summary request times out into the 502 path', async (t) => {
  environment(t, {
    OPENAI_API_KEY: 'fixture-key',
    GEV_RATELIMIT_OPENAI_PER_MIN: undefined,
  });
  t.mock.method(console, 'warn', () => {});
  const budgets = expireTimeoutsImmediately(t);
  t.mock.method(globalThis, 'fetch', stalledUpstream);
  const { handleHudSummary } =
    await import('../../server/providers/openai/hud-summary.js');
  const req = Object.assign(Readable.from([Buffer.from('{}')]), {
    method: 'POST',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  });

  const response = await invoke(handleHudSummary, '/', req);

  assert.equal(response.statusCode, 502);
  assertBounded(budgets, 1);
});
