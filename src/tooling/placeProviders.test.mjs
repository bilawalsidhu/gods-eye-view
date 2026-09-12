import test from 'node:test';
import assert from 'node:assert/strict';
import {
  googlePlacesContextProxy,
  installRouteMiddleware,
} from '../../server/providers/places.js';
import {
  projectNearbyPlaces,
  projectTextSearchPlaces,
} from '../../src/data/placeProviderPayloads.js';

function install(register) {
  const routes = new Map();
  register({
    use(route, handler) {
      routes.set(route, handler);
    },
  });
  return async (route, url, method = 'GET', peer = 'fixture') => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      writeHead(status, headers) {
        this.statusCode = status;
        for (const [key, value] of Object.entries(headers))
          this.setHeader(key, value);
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await routes.get(route)(
      { url, method, socket: { remoteAddress: peer } },
      res,
    );
    return res;
  };
}

test('nearby labels rank landmarks, deduplicate names/addresses and bound the projection', () => {
  const place = (name, types, longitude = 0) => ({
    displayName: { text: name },
    types,
    location: { latitude: 0, longitude },
    formattedAddress: 'Street',
  });
  const result = projectNearbyPlaces(
    {
      places: [
        place('Bathroom', ['public_bathroom']),
        place('Monument', ['monument'], 0.1),
        place('MONUMENT', ['monument']),
        ...Array.from({ length: 25 }, (_, i) =>
          place(`POI ${i}`, ['point_of_interest'], i / 100),
        ),
        { id: 'unnamed' },
      ],
    },
    0,
    0,
  );
  assert.equal(result.length, 20);
  assert.equal(result[0].name, 'Monument');
  assert.equal(result[0].distanceM, 11132);
  assert.equal(
    result.filter((p) => p.name.toLowerCase() === 'monument').length,
    1,
  );
  assert.ok(result.every((p) => !('contextPriority' in p)));
  assert.deepEqual(projectNearbyPlaces({}, 0, 0), []);
});

test('text search preserves bounds, rejects malformed bounds and tolerates absent locations', () => {
  const viewport = {
    low: { latitude: 1, longitude: 2 },
    high: { latitude: 3, longitude: 4 },
  };
  const result = projectTextSearchPlaces(
    {
      places: [
        {
          displayName: { text: 'Museum' },
          viewport,
          types: Array(12).fill('museum'),
        },
        { displayName: { text: 'Park' }, viewport: { low: viewport.low } },
      ],
    },
    0,
    0,
  );
  assert.deepEqual(result[0].viewport, viewport);
  assert.equal(result[0].distanceM, Number.MAX_SAFE_INTEGER);
  assert.equal(result[0].latitude, null);
  assert.equal(result[0].types.length, 8);
  assert.equal(result[1].viewport, null);
});

for (const preview of [false, true]) {
  test(`Google middleware resolves credentials per request and preserves search responses (${preview ? 'preview' : 'dev'})`, async (t) => {
    let key = '';
    const plugin = googlePlacesContextProxy({ resolveApiKey: () => key });
    const request = install((middlewares) =>
      plugin[preview ? 'configurePreviewServer' : 'configureServer']({
        middlewares,
      }),
    );
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.headers['X-Goog-Api-Key'], key);
      return Response.json({
        places: [
          {
            displayName: { text: 'Museum' },
            location: { latitude: 30, longitude: -97 },
          },
        ],
      });
    });
    const nearby = '/api/google/nearby-places';
    const search = '/api/google/text-search';
    assert.equal(
      (await request(nearby, '?lat=30&lon=-97')).body.configured,
      false,
    );
    assert.equal(calls.length, 0);
    key = 'fixture-server-key';
    const result = await request(nearby, '?lat=30&lon=-97&radiusM=9000');
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.places[0].name, 'Museum');
    assert.equal(
      JSON.parse(calls[0].options.body).locationRestriction.circle.radius,
      5000,
    );
    assert.equal(result.headers['cache-control'], 'private, max-age=300');
    key = 'rotated-fixture-key';
    assert.equal(
      (await request(search, '?q=museum&lat=30&lon=-97&radiusM=1')).statusCode,
      200,
    );
    assert.equal(
      JSON.parse(calls[1].options.body).locationBias.circle.radius,
      50,
    );
    assert.equal((await request(search, '?lat=30&lon=-97')).statusCode, 400);
    assert.equal((await request(nearby, '?lat=bad&lon=-97')).statusCode, 400);
    assert.equal((await request(nearby, '', 'POST')).statusCode, 405);
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ error: { message: 'Denied' } }, { status: 403 }),
    );
    assert.deepEqual((await request(search, '?q=museum&lat=30&lon=-97')).body, {
      places: [],
      error: 'Denied',
    });
  });
}

test('OSRM routing preserves aliases, cache, span guards and upstream failure behavior', async (t) => {
  const request = install(installRouteMiddleware);
  let calls = 0;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    assert.match(url, /routed-car\/route\/v1\/driving\//);
    return Response.json({
      code: 'Ok',
      routes: [
        {
          distance: 123.6,
          duration: 80.2,
          geometry: {
            coordinates: [
              [-97, 30],
              [-97.01, 30.01],
            ],
          },
        },
      ],
    });
  });
  const route = '/api/route';
  const query = '?profile=driving&coords=-97,30;-97.01,30.01';
  const result = await request(route, query);
  assert.deepEqual(result.body, {
    ok: true,
    profile: 'car',
    distanceM: 124,
    durationS: 80,
    geometry: [
      [-97, 30],
      [-97.01, 30.01],
    ],
  });
  assert.deepEqual(
    (await request(route, query.replace('driving', 'car'))).body,
    result.body,
  );
  assert.equal(calls, 1);
  for (const [url, error] of [
    ['?profile=plane&coords=0,0;1,1', 'invalid profile'],
    ['?coords=0,91;1,1', 'invalid coordinate'],
    ['?coords=0,0;100,0', 'route leg too long'],
    ['?coords=0,0', 'need 2-12 coordinates'],
  ])
    assert.equal((await request(route, url)).body.error, error);
  assert.equal(calls, 1);
  now += 600001;
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('offline', { status: 503 }),
  );
  assert.deepEqual((await request(route, query)).body, {
    ok: false,
    error: 'no route found',
  });
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('x', { headers: { 'content-type': 'text/html' } }),
  );
  assert.equal((await request(route, query)).body.error, 'no route found');
});
