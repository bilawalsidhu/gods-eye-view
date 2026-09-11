import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createGbfsProxyMiddleware } from '../../vite.config.js';

const ALLOWED = 'https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json';
const DISALLOWED = 'https://example.com/station_status.json';

function invoke(middleware, { url, method = 'GET', address = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const result = { status: 0, headers: {}, body: '' };
    const res = {
      writeHead(status, headers = {}) { result.status = status; result.headers = headers; },
      end(body = '') { result.body = String(body); resolve(result); },
    };
    Promise.resolve(middleware({
      url,
      method,
      socket: { remoteAddress: address },
    }, res)).catch(reject);
  });
}

function targetUrl(upstream) {
  return `/${encodeURIComponent(upstream)}`;
}

function jsonBody(result) {
  return JSON.parse(result.body);
}

test('GBFS proxy forwards an allowlisted station_status feed', async () => {
  const calls = [];
  const middleware = createGbfsProxyMiddleware({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response('{"data":{"stations":[]}}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    rateLimiter: () => true,
  });
  const result = await invoke(middleware, { url: targetUrl(ALLOWED) });
  assert.equal(result.status, 200);
  assert.equal(result.headers['X-GBFS-Upstream'], 'gbfs.lyft.com');
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(calls.length, 1);
  assert.equal(calls[0], ALLOWED);
  assert.equal(result.body, '{"data":{"stations":[]}}');
});

test('GBFS proxy throttles repeated GETs before host or path checks', async () => {
  const calls = [];
  let remaining = 3;
  const middleware = createGbfsProxyMiddleware({
    fetchImpl: async () => {
      calls.push('fetch');
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    rateLimiter: () => remaining-- > 0,
  });

  const blocked = await invoke(middleware, { url: targetUrl(DISALLOWED) });
  assert.equal(blocked.status, 403);
  assert.deepEqual(jsonBody(blocked), { error: 'GBFS host not allowed' });

  const missing = await invoke(middleware, { url: '/' });
  assert.equal(missing.status, 400);

  const allowed = await invoke(middleware, { url: targetUrl(ALLOWED) });
  assert.equal(allowed.status, 200);
  assert.equal(calls.length, 1);

  const throttled = await invoke(middleware, { url: targetUrl(ALLOWED) });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers['Retry-After'], '5');
  assert.equal(throttled.headers['Cache-Control'], 'no-store');
  assert.deepEqual(jsonBody(throttled), { error: 'Rate limit exceeded' });
  assert.equal(calls.length, 1, 'throttled requests must not hit upstream');
});

test('GBFS proxy does not spend rate-limit quota on non-GET methods', async () => {
  let allowed = 0;
  const middleware = createGbfsProxyMiddleware({
    fetchImpl: async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
    rateLimiter: () => { allowed += 1; return true; },
  });
  const denied = await invoke(middleware, { url: targetUrl(ALLOWED), method: 'POST' });
  assert.equal(denied.status, 405);
  assert.equal(allowed, 0);
  const ok = await invoke(middleware, { url: targetUrl(ALLOWED) });
  assert.equal(ok.status, 200);
  assert.equal(allowed, 1);
});

test('gbfs plugin wires the shared rate-limited middleware', () => {
  const source = readFileSync(new URL('../../vite.config.js', import.meta.url), 'utf8');
  assert.match(source, /const _gbfsRateLimiter = makeRateLimiter\(\{ windowMs: 60_000, max: 90, globalMax: 300 \}\)/);
  assert.match(source, /server\.middlewares\.use\('\/api\/gbfs', createGbfsProxyMiddleware\(\)\)/);
});
