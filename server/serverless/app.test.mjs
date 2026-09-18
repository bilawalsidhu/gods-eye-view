import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerlessApi } from './app.js';

/** Minimal http.ServerResponse-shaped mock: enough for router + createServerlessApi().handle(). */
function mockRes() {
  const listeners = { finish: [], close: [] };
  return {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    getHeader(name) {
      return this.headers[name];
    },
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    once(event, fn) {
      (listeners[event] ||= []).push(fn);
    },
    end(chunk) {
      this.headersSent = true;
      this.writableEnded = true;
      if (chunk !== undefined) this.body += chunk;
      queueMicrotask(() => {
        for (const fn of listeners.finish.splice(0)) fn();
      });
    },
  };
}

function mockReq(url, { method = 'GET' } = {}) {
  return { url, method, headers: {} };
}

// The serverless AIS route reads its credentials per request; these tests
// exercise the keyless path (demo replay), which is entirely offline.
const AIS_ENV_KEYS = [
  'AISSTREAM_API_KEY',
  'AISHUB_USERNAME',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
];
const savedAisEnv = Object.fromEntries(
  AIS_ENV_KEYS.map((key) => [key, process.env[key]]),
);
for (const key of AIS_ENV_KEYS) delete process.env[key];
test.after(() => {
  for (const key of AIS_ENV_KEYS) {
    if (savedAisEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedAisEnv[key];
  }
});

// A single serverless-mode instance is reused across these tests (matches
// how a warm Vercel function instance behaves via getServerlessApi()), and
// keeps us from repeatedly importing server/providers/local.js.
const apiPromise = createServerlessApi({ serverlessMode: true });

test('serverless /api/ais-live is served by the bounded collector: keyless Galveston scene answers 200 demo replay (degraded), not 501', async () => {
  const api = await apiPromise;
  const res = mockRes();
  await api.handle(
    mockReq('/api/ais-live?bbox=28.9,-95.5,29.9,-94&maxRows=10'),
    res,
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'degraded');
  assert.equal(body.source, 'Demo replay');
  assert.equal(
    body.error,
    'AISSTREAM_API_KEY not set - demo replay, not live AIS',
  );
  assert.ok(body.rows.length > 0 && body.rows.length <= 10);
  assert.match(body.rows[0].name, /^DEMO REPLAY \d+$/);
  assert.equal(body.collector.mode, 'demo');
  assert.equal(res.headers['X-Provider-Status'], 'degraded');
  assert.equal(res.headers['X-Provider-Source'], 'Demo replay');
  assert.equal(
    res.headers['Cache-Control'],
    'public, max-age=0, s-maxage=30, stale-while-revalidate=60',
  );
});

test('serverless /api/ais-live: an inland (Austin) scene is a legitimate empty scene with guidance, not a fault', async () => {
  const api = await apiPromise;
  const res = mockRes();
  await api.handle(
    mockReq('/api/ais-live?bbox=28.77,-99.24,31.77,-96.24&maxRows=10'),
    res,
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'empty');
  assert.deepEqual(body.rows, []);
  assert.equal(
    body.statusMessage,
    'No vessels in scene (demo replay covers the Texas Gulf coast)',
  );
  assert.equal(body.error, null);
});

test('serverless /api/ais-live without any scene hint answers idle (never 501); /track sub-path is mounted', async () => {
  const api = await apiPromise;
  const idle = mockRes();
  await api.handle(mockReq('/api/ais-live?maxRows=10'), idle);
  assert.equal(idle.statusCode, 200);
  assert.equal(JSON.parse(idle.body).status, 'idle');

  const track = mockRes();
  await api.handle(mockReq('/api/ais-live/track?mmsi=123456789'), track);
  assert.equal(track.statusCode, 200);
  assert.deepEqual(JSON.parse(track.body).samples, []);

  const demoTrack = mockRes();
  await api.handle(mockReq('/api/ais-live/track?mmsi=999000001'), demoTrack);
  assert.equal(demoTrack.statusCode, 200);
  assert.ok(JSON.parse(demoTrack.body).samples.length > 10);

  const bad = mockRes();
  await api.handle(mockReq('/api/ais-live/track?mmsi=nope'), bad);
  assert.equal(bad.statusCode, 400);
});

test('serverless guard: /api/realtime/token answers 501 unavailable_in_serverless', async () => {
  const api = await apiPromise;
  const res = mockRes();
  await api.handle(mockReq('/api/realtime/token'), res);
  assert.equal(res.statusCode, 501);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'unavailable_in_serverless',
    feature: 'voice-realtime',
    message:
      'Voice control (OpenAI Realtime ephemeral session) is unavailable in the serverless deployment',
  });
});

test('serverless guard: /api/realtime/debug-log is a silent 204 no-op', async () => {
  const api = await apiPromise;
  const res = mockRes();
  await api.handle(mockReq('/api/realtime/debug-log', { method: 'POST' }), res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, '');
});

test('/api/openai/hud-summary is left mounted (only token + debug-log are guarded)', async () => {
  const api = await apiPromise;
  const res = mockRes();
  // GET is rejected by the real handler (it only accepts POST) — reaching
  // THAT 405 (not our 501 guard, and not the 404 not-found layer) proves the
  // real openai-realtime-proxy handler is still mounted for this sub-route.
  await api.handle(mockReq('/api/openai/hud-summary'), res);
  assert.equal(res.statusCode, 405);
});

test('key setup is never mounted: /api/setup/status falls through to the not-found layer', async () => {
  const api = await apiPromise;
  const res = mockRes();
  await api.handle(mockReq('/api/setup/status'), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'Unknown API route' });
});

test('an unknown /api route gets the same 404 JSON as the Vite dev server', async () => {
  const api = await apiPromise;
  const res = mockRes();
  await api.handle(mockReq('/api/does-not-exist'), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'Unknown API route' });
});

test('getServerlessApi() memoises: two calls return the same instance', async () => {
  const { getServerlessApi } = await import('./app.js');
  const first = await getServerlessApi();
  const second = await getServerlessApi();
  assert.equal(first, second);
});
