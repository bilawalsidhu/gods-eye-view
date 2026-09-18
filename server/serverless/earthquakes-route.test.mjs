import test from 'node:test';
import assert from 'node:assert/strict';
import { createEarthquakesHandler } from './earthquakes-route.js';

/** Minimal Connect-shaped mock response: enough for the handler + assertions (mirrors router.test.mjs). */
function mockRes() {
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
    end(chunk) {
      this.headersSent = true;
      this.writableEnded = true;
      if (chunk !== undefined) this.body += chunk;
    },
  };
}

// Requests are built already-mounted (see server/serverless/router.js's
// Connect mount semantics: req.url inside a '/api/sources/earthquakes'
// mount is the remainder, e.g. '/' or '/?minmagnitude=5').
function mockReq(url, { method = 'GET' } = {}) {
  return { url, method, headers: {} };
}

test('GET ?foo=bar: 400 invalid_query listing the unknown param (real default adapter, no network call)', async () => {
  // No override: exercises the real adapter's validateQuery(), which
  // rejects before ever calling fetch — safe to run without mocking.
  const handler = createEarthquakesHandler();
  const res = mockRes();
  await handler(mockReq('/?foo=bar'), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'invalid_query');
  assert.deepEqual(body.unknown, ['foo']);
  assert.match(body.message, /foo/);
});

test('POST: 405 with an Allow header, using the real default adapter', async () => {
  const handler = createEarthquakesHandler();
  const res = mockRes();
  await handler(mockReq('/', { method: 'POST' }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'GET, HEAD');
  assert.deepEqual(JSON.parse(res.body), { error: 'method_not_allowed' });
});

test('DELETE: also 405 (GET/HEAD only)', async () => {
  const handler = createEarthquakesHandler();
  const res = mockRes();
  await handler(mockReq('/', { method: 'DELETE' }), res);
  assert.equal(res.statusCode, 405);
});

test('GET: 200 body shape with an injected fake adapter', async () => {
  const fakeProvenance = {
    source: 'USGS FDSN Event Web Service',
    url: 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson',
    generated: '2024-06-01T00:00:00.000Z',
    api: '1.10.3',
    title: 'USGS Earthquakes',
    retrieved_at_utc: '2024-06-01T00:00:00.000Z',
    license: 'USGS data are in the public domain',
  };
  const fakeEvents = [
    {
      id: 'us1000abcd',
      time_utc: '2024-06-01T00:00:00.000Z',
      magnitude: 5.2,
      mag_type: 'mww',
      depth_km: 12.3,
      lat: 10,
      lon: 20,
      place: 'Somewhere',
      tsunami: 0,
      alert: null,
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us1000abcd',
      source: 'USGS',
      coverage: 'observed',
      retrieved_at_utc: '2024-06-01T00:00:00.000Z',
    },
  ];
  let seenParams = null;
  const handler = createEarthquakesHandler({
    fetchEarthquakes: async (params) => {
      seenParams = params;
      return {
        ok: true,
        status: 200,
        count: fakeEvents.length,
        events: fakeEvents,
        provenance: fakeProvenance,
      };
    },
  });
  const res = mockRes();
  await handler(mockReq('/?minmagnitude=5&limit=10'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['Cache-Control'], 'public, max-age=60');
  assert.deepEqual(seenParams, { minmagnitude: '5', limit: '10' });
  assert.deepEqual(JSON.parse(res.body), {
    source: 'USGS',
    coverage: 'observed',
    count: 1,
    events: fakeEvents,
    provenance: fakeProvenance,
    query: { minmagnitude: '5', limit: '10' },
  });
});

test('HEAD: 200 with headers set but an empty body', async () => {
  const handler = createEarthquakesHandler({
    fetchEarthquakes: async () => ({
      ok: true,
      status: 200,
      count: 0,
      events: [],
      provenance: {},
    }),
  });
  const res = mockRes();
  await handler(mockReq('/', { method: 'HEAD' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '');
});

test('adapter error passthrough: a 503 from the adapter is forwarded as-is', async () => {
  const handler = createEarthquakesHandler({
    fetchEarthquakes: async () => ({
      ok: false,
      status: 503,
      error: 'usgs_unavailable',
      detail: 'USGS did not respond',
    }),
  });
  const res = mockRes();
  await handler(mockReq('/?minmagnitude=5'), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(res.body), {
    error: 'usgs_unavailable',
    detail: 'USGS did not respond',
  });
});

test('adapter error passthrough: usgs_rejected (400 from USGS itself) keeps its detail, not the invalid_query shape', async () => {
  const handler = createEarthquakesHandler({
    fetchEarthquakes: async () => ({
      ok: false,
      status: 400,
      error: 'usgs_rejected',
      detail: 'Bad Request: incorrect parameter combination.',
    }),
  });
  const res = mockRes();
  await handler(mockReq('/?minmagnitude=5'), res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'usgs_rejected',
    detail: 'Bad Request: incorrect parameter combination.',
  });
});

test('never throws out of the handler: an adapter rejection becomes a 502 sources_error', async () => {
  const handler = createEarthquakesHandler({
    fetchEarthquakes: async () => {
      throw new Error('boom');
    },
  });
  const res = mockRes();
  await handler(mockReq('/'), res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), { error: 'sources_error' });
});
