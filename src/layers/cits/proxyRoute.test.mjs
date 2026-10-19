import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCitsMiddleware,
  createCitsRelay,
} from '../../../server/providers/cits.js';

function call(middleware, req) {
  return new Promise((resolve) => {
    const res = {
      headers: {},
      writeHead(status, headers = {}) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        resolve({
          status: this.status,
          headers: this.headers,
          body: JSON.parse(body),
        });
      },
    };
    middleware({ socket: { remoteAddress: '127.0.0.1' }, ...req }, res);
  });
}

const QUERY = '/state?west=15.4&south=47.0&east=15.5&north=47.1';

test('only GET is admitted, with an Allow header and a snake_case code', async () => {
  const middleware = createCitsMiddleware({ tiled: null, full: null });
  const response = await call(middleware, { method: 'POST', url: QUERY });
  assert.equal(response.status, 405);
  assert.equal(response.headers.Allow, 'GET');
  assert.deepEqual(response.body, { error: 'method_not_allowed' });
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('unknown routes and malformed boxes answer generic codes', async () => {
  const middleware = createCitsMiddleware({ tiled: null, full: null });
  const unknown = await call(middleware, { method: 'GET', url: '/tracks' });
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { error: 'unknown_route' });
  const invalid = await call(middleware, { method: 'GET', url: '/state' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body, { error: 'invalid_cits_query' });
});

test('the kill switch answers cits_unavailable', async () => {
  const previous = process.env.CITS_OTM_ENABLED;
  process.env.CITS_OTM_ENABLED = '0';
  try {
    const middleware = createCitsMiddleware({ tiled: null, full: null });
    const response = await call(middleware, { method: 'GET', url: QUERY });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'cits_unavailable' });
  } finally {
    if (previous === undefined) delete process.env.CITS_OTM_ENABLED;
    else process.env.CITS_OTM_ENABLED = previous;
  }
});

test('a client over its per-minute budget is refused with Retry-After', async () => {
  const keys = [];
  const middleware = createCitsMiddleware({
    tiled: null,
    full: null,
    allow: (key) => {
      keys.push(key);
      return false;
    },
  });
  const response = await call(middleware, {
    method: 'GET',
    url: QUERY,
    headers: { 'x-forwarded-for': '203.0.113.9' },
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers['Retry-After'], '60');
  assert.deepEqual(response.body, { error: 'rate_limited' });
  // The socket address, never a client-supplied forwarding header.
  assert.deepEqual(keys, ['127.0.0.1']);
});

test('upstream failure detail never reaches the client', async () => {
  class FailingSocket {
    constructor() {
      throw new Error('connect ECONNREFUSED /home/operator/secret');
    }
  }
  const tiled = createCitsRelay({ WebSocketImpl: FailingSocket });
  try {
    const middleware = createCitsMiddleware({ tiled, full: null });
    const response = await call(middleware, { method: 'GET', url: QUERY });
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'connecting');
    assert.equal(response.body.upstream.error, 'upstream_unavailable');
    assert.doesNotMatch(JSON.stringify(response.body), /ECONNREFUSED|secret/);
  } finally {
    tiled.dispose();
  }
});
