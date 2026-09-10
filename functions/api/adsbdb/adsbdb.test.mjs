import test from 'node:test';
import assert from 'node:assert/strict';

// The Function file is `[[path]].js` (Pages optional catch-all). This test file
// deliberately does NOT mirror that name: `node --test` treats `[[...]]` in a
// filename argument as a glob, matches nothing, and reports "0 tests, 0
// failures" — every assertion below would be silently skipped.
import { onRequest } from './[[path]].js';

const url = (path) => `https://example.com/api/adsbdb${path}`;
const ctx = (request) => ({ request, env: {} });

const FLIGHTROUTE = {
  response: {
    flightroute: {
      airline: { name: 'United Airlines' },
      origin: {
        iata_code: 'SFO', icao_code: 'KSFO',
        municipality: 'San Francisco', name: 'San Francisco Intl',
        latitude: 37.6188, longitude: -122.375,
      },
      destination: {
        iata_code: 'EWR', icao_code: 'KEWR',
        municipality: 'Newark', name: 'Newark Liberty Intl',
        latitude: 40.6895, longitude: -74.1745,
      },
    },
  },
};

test('unknown kinds answer the dev 404 shape', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('no'); };
  try {
    for (const path of ['/', '/blurb/UAL123', '/routes/UAL123']) {
      const res = await onRequest(ctx(new Request(url(path))));
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { error: 'unknown endpoint' }, path);
      assert.equal(res.headers.get('content-type'), 'application/json');
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('bad route keys get the dev 400 shape, still percent-encoded like the client sends them', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('no'); };
  try {
    for (const path of ['/route', '/route/U', '/route/UAL-1234', '/route/UAL%20123', '/route/']) {
      const res = await onRequest(ctx(new Request(url(path))));
      assert.equal(res.status, 400, path);
      assert.deepEqual(await res.json(), { error: 'invalid callsign' }, path);
    }
    assert.equal(calls, 0, 'a rejected callsign never reaches adsbdb');
  } finally {
    globalThis.fetch = original;
  }
});

test('bad hex keys get the dev 400 shape', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('no'); };
  try {
    for (const path of ['/type', '/type/abc12', '/type/abc1234', '/type/zzzzzz', '/type/abc12g']) {
      const res = await onRequest(ctx(new Request(url(path))));
      assert.equal(res.status, 400, path);
      assert.deepEqual(await res.json(), { error: 'invalid hex' }, path);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('a route lookup is normalized into the shape flights.js consumes', async () => {
  let captured;
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl, init) => {
    captured = { fetchUrl, init };
    return new Response(JSON.stringify(FLIGHTROUTE), { status: 200 });
  };
  try {
    const res = await onRequest(ctx(new Request(url('/route/UAL123'))));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.deepEqual(await res.json(), {
      found: true,
      airline: 'United Airlines',
      origin: { code: 'SFO', name: 'San Francisco', lat: 37.6188, lon: -122.375 },
      destination: { code: 'EWR', name: 'Newark', lat: 40.6895, lon: -74.1745 },
    });

    assert.equal(captured.fetchUrl, 'https://api.adsbdb.com/v0/callsign/UAL123');
    assert.ok(captured.init.signal instanceof AbortSignal, 'the upstream call is time-bounded');
  } finally {
    globalThis.fetch = original;
  }
});

test('an aircraft lookup resolves the type designation and registration', async () => {
  let captured;
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl) => {
    captured = { fetchUrl };
    return new Response(JSON.stringify({
      response: { aircraft: { icao_type: 'B738', manufacturer: 'Boeing', type: '737-800', registration: 'N123UA' } },
    }), { status: 200 });
  };
  try {
    const res = await onRequest(ctx(new Request(url('/type/ABC123'))));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      found: true,
      typeCode: 'B738',
      typeName: 'Boeing 737-800',
      registration: 'N123UA',
    });
    assert.equal(captured.fetchUrl, 'https://api.adsbdb.com/v0/aircraft/abc123', 'hex is lowercased');
  } finally {
    globalThis.fetch = original;
  }
});

test('a type with no manufacturer falls back to the bare type string', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    response: { aircraft: { icao_type: 'C172', type: '172', registration: 'N5)?' } },
  }), { status: 200 });
  try {
    const res = await onRequest(ctx(new Request(url('/type/def234'))));
    const body = await res.json();
    assert.equal(body.found, true);
    assert.equal(body.typeName, '172', 'no "undefined undefined" concatenation');
    assert.equal(body.typeCode, 'C172');
  } finally {
    globalThis.fetch = original;
  }
});

test('a known-missing callsign is negative-cached, so a repeat costs no upstream call', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 404 }); };
  try {
    for (let i = 0; i < 2; i += 1) {
      const res = await onRequest(ctx(new Request(url('/route/BAW1'))));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { found: false }, 'a miss is a 200, not a 404');
    }
    assert.equal(calls, 1, 'the 404 is cached for the 24h TTL');
  } finally {
    globalThis.fetch = original;
  }
});

test('a flightroute without both endpoints is a cached negative result', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      response: { flightroute: { airline: { name: 'Air Nowhere' }, origin: { iata_code: 'XXX' } } },
    }), { status: 200 });
  };
  try {
    const res = await onRequest(ctx(new Request(url('/route/ZZZ1'))));
    assert.deepEqual(await res.json(), { found: false }, 'a one-legged route is useless to the client');
    await onRequest(ctx(new Request(url('/route/ZZZ1'))));
    assert.equal(calls, 1, 'cached like a miss, not retried per request');
  } finally {
    globalThis.fetch = original;
  }
});

test('a transient upstream 5xx is answered found:false and NOT cached', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('upstream exploded', { status: 500 });
  };
  try {
    for (let i = 0; i < 2; i += 1) {
      const res = await onRequest(ctx(new Request(url('/route/AWQ2'))));
      assert.deepEqual(await res.json(), { found: false }, `attempt ${i}`);
    }
    assert.equal(calls, 2, 'a 5xx is retried on the next request, unlike a 404');
  } finally {
    globalThis.fetch = original;
  }
});

test('a network failure falls back to a still-fresh entry', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(FLIGHTROUTE), { status: 200 });
  try {
    const good = await onRequest(ctx(new Request(url('/route/DLH3'))));
    assert.equal((await good.json()).airline, 'United Airlines');

    globalThis.fetch = async () => { throw new Error('getaddrinfo EAI_AGAIN'); };
    const degraded = await onRequest(ctx(new Request(url('/route/DLH3'))));
    assert.equal(degraded.status, 200);
    assert.deepEqual(await degraded.json(), {
      found: true,
      airline: 'United Airlines',
      origin: { code: 'SFO', name: 'San Francisco', lat: 37.6188, lon: -122.375 },
      destination: { code: 'EWR', name: 'Newark', lat: 40.6895, lon: -74.1745 },
    }, 'stale enrichment beats dropping the route line');
  } finally {
    globalThis.fetch = original;
  }
});

test('concurrent lookups for one key share a single upstream request', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify(FLIGHTROUTE), { status: 200 });
  };
  try {
    const [a, b] = await Promise.all([
      onRequest(ctx(new Request(url('/route/UAL9')))),
      onRequest(ctx(new Request(url('/route/UAL9')))),
    ]);
    assert.equal(calls, 1, 'the enrichment drip fires bursts — one request per key');
    assert.deepEqual(await a.json(), await b.json());
  } finally {
    globalThis.fetch = original;
  }
});
