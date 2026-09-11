import test from 'node:test';
import assert from 'node:assert/strict';
import { trafficSignalsProxy } from './trafficSignalsProxy.js';

function harness(env, fetchImpl) {
  let handler;
  const result = trafficSignalsProxy(env, fetchImpl).configureServer({ middlewares: { use(path, callback) { handler = callback; return () => {}; } } });
  assert.equal(result, undefined, 'middleware registration must not return a Vite post-install hook');
  return async (url, method = 'GET') => {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { this.body = JSON.parse(body); } };
    await handler({ method, url }, res);
    return res;
  };
}
const bounds = '/snapshot?south=49&west=-123&north=49.02&east=-122.98';

test('keyless status lists regional public coverage and does not fetch outside it', async () => {
  const call = harness({}, () => { throw new Error('must not fetch'); });
  const status = (await call('/status')).body;
  assert.equal(status.configured, true);
  assert.equal(status.customFeedConfigured, false);
  assert.equal(status.worldwideLiveCoverage, false);
  assert.equal(status.providers[0].id, 'hamburg');
  const uncovered = await call(bounds);
  assert.equal(uncovered.status, 200);
  assert.deepEqual(uncovered.body.signals, []);
  assert.match(uncovered.body.coverage, /No connected live provider/);
  assert.equal((await call('/status', 'POST')).status, 405);
  assert.equal((await call('/unknown')).status, 404);
});

test('rejects missing, nonnumeric, oversized and reversed bounds before fetching', async () => {
  const call = harness({ TRAFFIC_SIGNALS_FEED_URL: 'https://example.test' }, () => { throw new Error('must not fetch'); });
  for (const url of ['/snapshot', '/snapshot?south=&north=49.01&west=-123&east=-122.99',
    '/snapshot?south=49&north=50&west=-123&east=-122', '/snapshot?south=49&north=48&west=-123&east=-122.99',
    '/snapshot?south=NaN&north=49.01&west=-123&east=-122.99']) {
    assert.equal((await call(url)).status, 400);
  }
});

test('server forwards credentials privately and returns only bounded, validated contract fields', async () => {
  const timestamp = Date.now();
  const record = { id: 'city:1', lat: 49.01, lon: -122.99, movement: 'North', source: 'City', state: 'red',
    observedAtEpochMs: timestamp - 500, validUntilEpochMs: timestamp + 5000, resolutionMs: 1000, uncertaintyMs: 500,
    secret: 'must-not-return' };
  const call = harness({ TRAFFIC_SIGNALS_FEED_URL: 'https://example.test/feed', TRAFFIC_SIGNALS_FEED_TOKEN: 'private' }, async (url, options) => {
    assert.equal(url.hostname, 'example.test');
    assert.equal(url.searchParams.get('north'), '49.02');
    assert.equal(options.headers.Authorization, 'Bearer private');
    assert.equal(options.redirect, 'error');
    return Response.json({ serverTimeEpochMs: timestamp, clockUncertaintyMs: 10,
      signals: [record, { ...record, id: 'outside', lat: 50 }], token: 'private' });
  });
  const result = await call(bounds + '&url=https://attacker.test');
  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.body.signals.length, 1);
  assert.equal(result.body.signals[0].secret, undefined);
  assert.equal(result.body.token, undefined);
});

test('upstream errors, oversize bodies and invalid timing fail closed without leaking secrets', async () => {
  for (const fetcher of [async () => { throw new Error('SECRET upstream URL'); },
    async () => new Response('upstream secret', { status: 401 }),
    async () => Response.json({ signals: [] }),
    async () => new Response('x'.repeat(4 * 1024 * 1024 + 1))]) {
    const result = await harness({ TRAFFIC_SIGNALS_FEED_URL: 'https://example.test' }, fetcher)(bounds);
    assert.equal(result.status, 502);
    assert.equal(result.body.error, 'Live signal feed unavailable or invalid');
  }
});
