import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STREET_VIEW_MAX_REQUESTS,
  createStreetViewBudget,
  registeredStreetViewLocation,
} from './streetViewGuard.js';
import { cctvProxy } from '../cctv.js';

test('registered cameras require valid geographic coordinates', () => {
  for (const invalid of [
    null,
    { id: 'x', lat: null, lon: 0 },
    { id: 'x', lat: '', lon: 0 },
    { id: 'x', lat: '  ', lon: 0 },
    { id: 'x', lat: 0, lon: '' },
    { id: 'x', lat: 91, lon: 0 },
    { id: 'x', lat: 0, lon: 181 },
    { id: 'x', lat: 'bad', lon: 0 },
    { id: 'x', lat: Infinity, lon: 0 },
    { lat: 10, lon: 20 },
  ]) {
    assert.equal(registeredStreetViewLocation(invalid), null);
  }
  assert.deepEqual(
    registeredStreetViewLocation({
      id: 'registered',
      lat: 10,
      lon: -20,
      headingDeg: -10,
      fovDeg: 900,
      pitchDeg: -900,
    }),
    { lat: 10, lon: -20, heading: 350, fov: 120, pitch: -40 },
  );
  assert.deepEqual(
    registeredStreetViewLocation({ id: 'zero', lat: 0, lon: 0 }),
    { lat: 0, lon: 0, heading: 0, fov: 80, pitch: 0 },
  );
});

test('a shared budget counts attempts and resets at the window', () => {
  let now = 100;
  const budget = createStreetViewBudget({
    now: () => now,
    maxRequests: 2,
    windowMs: 1000,
  });
  assert.equal(budget.consume(), true);
  assert.equal(budget.consume(), true);
  assert.equal(budget.consume(), false);
  now = 1099;
  assert.equal(budget.consume(), false);
  now = 1100;
  assert.equal(budget.consume(), true);
  now = 0;
  assert.equal(budget.consume(), true);
});

test('invalid budget settings fail closed', () => {
  assert.throws(() => createStreetViewBudget({ maxRequests: 0 }), TypeError);
  assert.throws(() => createStreetViewBudget({ windowMs: 0 }), TypeError);
});

test('frame route pins location and caps billable requests', async (t) => {
  const names = [
    'CCTV_SOURCES_JSON',
    'CCTV_SOURCES_FILE',
    'CCTV_FORCE_AUSTIN',
    'GOOGLE_MAPS_SERVER_API_KEY',
  ];
  const before = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  process.env.CCTV_SOURCES_JSON = JSON.stringify([
    {
      id: 'camera-fixture',
      name: 'Fixture camera',
      lat: 30.2672,
      lon: -97.7431,
      feedType: 'image',
    },
  ]);
  process.env.CCTV_SOURCES_FILE = 'not-a-real-cctv-source.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  process.env.GOOGLE_MAPS_SERVER_API_KEY = 'test-only-street-view-key';

  const originalFetch = globalThis.fetch;
  const streetViewCalls = [];
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    if (
      target.hostname === 'maps.googleapis.com' &&
      target.pathname === '/maps/api/streetview'
    ) {
      streetViewCalls.push(target);
      return new Response(Buffer.from('fake-jpeg'), {
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    return new Response('not found', { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  });

  let handler;
  cctvProxy().configureServer({
    middlewares: {
      use: (_route, middleware) => {
        handler = middleware;
      },
    },
  });
  const frame = (id, query = '') =>
    new Promise((resolve, reject) => {
      let source = null;
      const response = {
        writeHead(_status, headers) {
          source = headers['X-CCTV-Source'];
        },
        end() {
          resolve(source);
        },
      };
      const request = {
        url: `/frame/${id}${query}`,
        method: 'GET',
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
        on() {},
      };
      Promise.resolve(handler(request, response)).catch(reject);
    });

  assert.equal(await frame('unknown', '?lat=48.8584&lon=2.2945'), 'synthetic');
  assert.equal(streetViewCalls.length, 0);
  assert.equal(
    await frame('camera-fixture', '?lat=48.8584&lon=2.2945'),
    'streetview',
  );
  assert.equal(streetViewCalls.length, 1);
  assert.equal(
    streetViewCalls[0].searchParams.get('location'),
    '30.2672,-97.7431',
  );

  for (let i = 1; i < STREET_VIEW_MAX_REQUESTS; i += 1) {
    assert.equal(await frame('camera-fixture'), 'streetview');
  }
  assert.equal(await frame('camera-fixture'), 'synthetic');
  assert.equal(streetViewCalls.length, STREET_VIEW_MAX_REQUESTS);
});
