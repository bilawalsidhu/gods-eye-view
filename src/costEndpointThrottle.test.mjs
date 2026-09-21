import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { readPinokioEnvironment } from '../scripts/pinokio-environment.mjs';
import { openAiRealtimeProxy } from 'gods-eye-view/server/providers/openai';
import {
  makeCostRateLimiter,
  resolvePerMinuteCap,
} from '../server/providers/common/rate-limit.js';
import { OPENAI_DEFAULT_PER_MIN } from '../server/providers/openai/rate-limit.js';
import {
  googlePlacesContextProxy,
  GOOGLE_DEFAULT_PER_MIN,
} from '../server/providers/places/google.js';

// Both limiters are cached at module scope on first use, so the env value that
// matters is the one in place when a route is first exercised — restoring the
// variable afterwards does not rebuild the limiter. Each route is therefore
// driven by exactly one test here; a second test wanting a different cap would
// need its own process, not just a different env value.

/** Set an env var for one test and put the old value back afterwards. */
function env(t, name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
    restart: async () => {},
  });
  return routes;
}

function request(handler, { url = '/', method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([]);
    Object.assign(req, {
      method,
      url,
      headers: { host: 'localhost:4173', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      end(body = '') {
        resolve({ status: this.statusCode, headers, body: String(body) });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('an unset throttle resolves to the documented default, not to unlimited', () => {
  // The defect #16 reports: the cap was opt-in, so an unconfigured server let
  // anyone who could reach it mint tokens on the operator's key without bound.
  assert.equal(resolvePerMinuteCap(undefined, 30), 30);
  assert.equal(resolvePerMinuteCap('', 30), 30);
  assert.equal(resolvePerMinuteCap('   ', 30), 30);
  assert.ok(
    typeof makeCostRateLimiter(undefined, 30) === 'function',
    'an unconfigured cost endpoint must still be throttled',
  );
});

test('an explicit 0 is the documented way to run unthrottled', () => {
  assert.equal(resolvePerMinuteCap('0', 30), 0);
  assert.equal(
    makeCostRateLimiter('0', 30),
    null,
    'operators who mean "no throttle" must still be able to say so',
  );
});

test('a configured value wins, and a fractional one floors', () => {
  assert.equal(resolvePerMinuteCap('45', 30), 45);
  assert.equal(resolvePerMinuteCap(45, 30), 45);
  assert.equal(resolvePerMinuteCap('30.7', 30), 30);
});

test('an unreadable value keeps the guard instead of removing it', () => {
  // `3O` (letter O) and `60/min` are the shapes a hand-edited .env produces.
  // Reading either as "unlimited" would disarm the spend guard on a typo —
  // the opposite of what the operator was reaching for when they typed it.
  for (const typo of ['3O', '60/min', 'thirty', '-5', 'NaN']) {
    assert.equal(
      resolvePerMinuteCap(typo, 30),
      30,
      `${typo} must fall back to the default, not to unlimited`,
    );
  }
});

test('the default cap clears the app’s own demand with room to spare', () => {
  // src/hud.js HUD_SUMMARY_INTERVAL_MS = 15000 -> 4 summaries/min per open
  // tab, plus one token mint per voice session. The cap has to sit well above
  // that or it would throttle the app rather than an abuser.
  const hudRequestsPerMinutePerTab = 60_000 / 15_000;
  assert.ok(
    OPENAI_DEFAULT_PER_MIN >= hudRequestsPerMinutePerTab * 4,
    `default ${OPENAI_DEFAULT_PER_MIN}/min leaves too little headroom over ${hudRequestsPerMinutePerTab}/min of ordinary use`,
  );
});

test('the realtime token route throttles by default, and says so in a 429', async (t) => {
  env(t, 'GEV_RATELIMIT_OPENAI_PER_MIN', undefined);
  env(t, 'OPENAI_API_KEY', 'fixture-upstream-secret');
  let upstreamCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    upstreamCalls += 1;
    return Response.json({ value: 'fixture-ephemeral' });
  });

  const handler = install(openAiRealtimeProxy({})).get('/api/realtime/token');
  const statuses = [];
  for (let i = 0; i < OPENAI_DEFAULT_PER_MIN + 1; i += 1) {
    statuses.push((await request(handler)).status);
  }

  assert.deepEqual(
    statuses.slice(0, OPENAI_DEFAULT_PER_MIN),
    Array(OPENAI_DEFAULT_PER_MIN).fill(200),
    'the default must not throttle ordinary use',
  );
  const overLimit = await request(handler);
  assert.equal(overLimit.status, 429);
  assert.equal(overLimit.headers['retry-after'], '5');
  assert.equal(JSON.parse(overLimit.body).error, 'Rate limit exceeded');
  assert.equal(
    overLimit.body.includes('fixture-upstream-secret'),
    false,
    'a throttled reply must not leak the server-held key',
  );
  assert.ok(
    upstreamCalls <= OPENAI_DEFAULT_PER_MIN,
    'a throttled request must be refused before it reaches OpenAI, or it still costs money',
  );
});

test('the Google places route throttles by default and keeps its places[] contract', async (t) => {
  env(t, 'GEV_RATELIMIT_GOOGLE_PER_MIN', undefined);
  let upstreamCalls = 0;
  const handler = install(
    googlePlacesContextProxy({
      resolveApiKey: () => 'fixture-google-server-key',
      fetchImpl: async () => {
        upstreamCalls += 1;
        return Response.json({ places: [] });
      },
    }),
  ).get('/api/google/nearby-places');

  const url = '/?lat=37.77493&lon=-122.41942';
  const statuses = [];
  for (let i = 0; i < GOOGLE_DEFAULT_PER_MIN; i += 1) {
    statuses.push((await request(handler, { url, method: 'GET' })).status);
  }
  assert.ok(
    statuses.every((s) => s === 200),
    'the default must not throttle ordinary use',
  );

  const overLimit = await request(handler, { url, method: 'GET' });
  assert.equal(overLimit.status, 429);
  assert.equal(overLimit.headers['retry-after'], '5');
  // Every error response on this route carries places[]; the client reads it
  // unconditionally, so a throttled reply must not be the one shape that omits it.
  assert.deepEqual(JSON.parse(overLimit.body).places, []);
  assert.equal(
    upstreamCalls,
    GOOGLE_DEFAULT_PER_MIN,
    'a throttled request must be refused before it reaches Google, or it still costs money',
  );
});

test('the code defaults match the caps the Pinokio build ships', () => {
  // These two numbers used to live only in pinokio/_ENVIRONMENT, and the value
  // this repo suggested elsewhere had already drifted away from them. Now that
  // they are the server's defaults, the packaged app and an unconfigured
  // checkout must agree, or a Pinokio user's throttle silently stops matching
  // the one everybody else gets. If you deliberately want them to differ, this
  // assertion is the place to say so.
  const shipped = readPinokioEnvironment(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'pinokio',
      '_ENVIRONMENT',
    ),
  );
  assert.equal(
    Number(shipped.GEV_RATELIMIT_OPENAI_PER_MIN),
    OPENAI_DEFAULT_PER_MIN,
  );
  assert.equal(
    Number(shipped.GEV_RATELIMIT_GOOGLE_PER_MIN),
    GOOGLE_DEFAULT_PER_MIN,
  );
});
