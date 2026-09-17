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

// A single serverless-mode instance is reused across these tests (matches
// how a warm Vercel function instance behaves via getServerlessApi()), and
// keeps us from repeatedly importing server/providers/local.js.
const apiPromise = createServerlessApi({ serverlessMode: true });

test('serverless guard: /api/ais-live answers 501 unavailable_in_serverless without mounting the real proxy', async () => {
  const api = await apiPromise;
  const res = mockRes();
  await api.handle(mockReq('/api/ais-live?maxRows=10'), res);
  assert.equal(res.statusCode, 501);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'unavailable_in_serverless',
    feature: 'ais-live',
    message:
      'Live vessel relay (AISStream WebSocket) is unavailable in the serverless deployment',
  });
});

test('serverless guard: /api/ais-live/track also hits the guard (sub-path mount)', async () => {
  const api = await apiPromise;
  const res = mockRes();
  await api.handle(mockReq('/api/ais-live/track?mmsi=123456789'), res);
  assert.equal(res.statusCode, 501);
  assert.equal(JSON.parse(res.body).feature, 'ais-live');
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
