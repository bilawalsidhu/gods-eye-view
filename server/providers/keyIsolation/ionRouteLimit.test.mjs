// The ion route's per-client limit protects ion, so it is spent only by a
// request that would call ion. An answer served from memory costs ion nothing
// and must not count: behind a reverse proxy every visitor shares one socket
// peer, so one busy visitor would otherwise lock all the others out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRateLimiter } from '../common/rate-limit.js';
import {
  createIonEndpointFetcher,
  createIonRouteHandler,
  ION_ROUTE_MAX_PER_MIN,
} from './ionEndpoint.js';

const TOKEN = `eyJ${'x'.repeat(30)}.${'y'.repeat(30)}.sig`;

function jwt(expSeconds) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ exp: expSeconds })}.sig`;
}

const response = (body, status = 200, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Drive a (req,res) handler like connect would; resolves with the response. */
function call(handler, { url, remote = '203.0.113.9' }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers[name.toLowerCase()] = String(value);
      },
      end(body) {
        resolve({ status: this.statusCode, headers, text: body ?? '' });
      },
    };
    Promise.resolve(
      handler(
        { method: 'GET', url, headers: {}, socket: { remoteAddress: remote } },
        res,
      ),
    ).catch(reject);
  });
}

const ENDPOINT = '/v1/assets/1/endpoint';

test('ion route: answers from memory do not spend the per-client limit', async () => {
  const clock = 1_000_000;
  let upstream = 0;
  const env = { CESIUM_ION_TOKEN: TOKEN };
  const handler = createIonRouteHandler({
    env,
    fetchEndpoint: createIonEndpointFetcher({
      env,
      now: () => clock,
      fetchImpl: async () => {
        upstream += 1;
        return response({
          type: 'TERRAIN',
          accessToken: jwt(clock / 1000 + 3600),
        });
      },
    }),
  });
  assert.equal((await call(handler, { url: ENDPOINT })).status, 200);
  assert.equal(upstream, 1);

  for (let i = 0; i < 1000; i += 1) {
    const res = await call(handler, { url: ENDPOINT });
    assert.equal(res.status, 200, `request ${i + 1} of the busy client`);
  }
  assert.equal(
    (await call(handler, { url: ENDPOINT, remote: '198.51.100.4' })).status,
    200,
    'a second client is not locked out',
  );
  assert.equal(upstream, 1, 'ion was called once');
});

test('ion route: requests that would call ion still hit the limit, and ion is not called for the refused ones', async () => {
  let upstream = 0;
  const env = { CESIUM_ION_TOKEN: TOKEN };
  const handler = createIonRouteHandler({
    env,
    fetchEndpoint: createIonEndpointFetcher({
      env,
      // A rejected token is never kept, so every request needs ion.
      fetchImpl: async () => {
        upstream += 1;
        return response({ message: 'no' }, 401);
      },
    }),
  });
  const statuses = [];
  for (let i = 0; i < ION_ROUTE_MAX_PER_MIN + 5; i += 1)
    statuses.push((await call(handler, { url: ENDPOINT })).status);
  assert.equal(
    statuses.slice(0, ION_ROUTE_MAX_PER_MIN).every((s) => s === 403),
    true,
  );
  assert.deepEqual(
    statuses.slice(ION_ROUTE_MAX_PER_MIN),
    [429, 429, 429, 429, 429],
  );
  assert.equal(upstream, ION_ROUTE_MAX_PER_MIN, 'ion saw no refused request');
  const refused = await call(handler, { url: ENDPOINT });
  assert.equal(refused.headers['retry-after'], '5');
});

test('ion route: a request that joins a call to ion already under way does not spend the per-client limit', async () => {
  let upstream = 0;
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const env = { CESIUM_ION_TOKEN: TOKEN };
  // A bucket of two requests for ion, for one client.
  const handler = createIonRouteHandler({
    env,
    allow: makeRateLimiter({ windowMs: 60_000, max: 2, globalMax: 8 }),
    fetchEndpoint: createIonEndpointFetcher({
      env,
      now: () => 1_000_000,
      fetchImpl: async (url) => {
        upstream += 1;
        await slow;
        return response({
          type: 'TERRAIN',
          url,
          accessToken: jwt(1_000 + 3600),
        });
      },
    }),
  });
  const joined = Array.from({ length: 10 }, () =>
    call(handler, { url: ENDPOINT }),
  );
  release();
  const answers = await Promise.all(joined);
  assert.deepEqual(
    answers.map((answer) => answer.status),
    Array(10).fill(200),
    'every request that joined the one call is answered',
  );
  assert.equal(upstream, 1, 'ion was called once');
  // The ten requests spent one token. Exhaust the bucket: one more request
  // that needs ion is answered, the next is refused.
  assert.equal(
    (await call(handler, { url: '/v1/assets/3/endpoint' })).status,
    200,
    'the second token is still there',
  );
  assert.equal(
    (await call(handler, { url: '/v1/assets/4/endpoint' })).status,
    429,
    'and then the bucket is empty',
  );
  assert.equal(upstream, 2);
});
