import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGeospatialServices,
  createHttpGeospatialProvider,
  createDefaultPlaceSearch,
} from './index.js';
import { installRouteMiddleware } from '../../server/providers/places/routes.js';
import { createRegionalPlaceProvider } from '../../server/providers/regional/place.js';

const point = { latitude: 30, longitude: -97, radiusM: 250 };
const coordinates = [
  [-97, 30],
  [-97.001, 30.001],
];
const route = { geometry: coordinates, distanceM: 120, durationS: 90 };
const json = (data) =>
  new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });

test('each operation can use an independent provider without coupling forward search', async () => {
  const calls = [];
  const service = createDefaultPlaceSearch({
    providers: {
      geocode: [
        {
          geocode: async () => ({
            place: { lat: 30, lng: -97 },
            answered: true,
          }),
        },
      ],
      reverseGeocode: async (lat, lon) => {
        calls.push([lat, lon]);
        return { locality: 'Town' };
      },
      textSearch: async (q) => [{ name: q, ...point }],
      nearby: async (p) => [p],
      route: async () => route,
      routeProfiles: ['foot'],
    },
  });
  assert.equal((await service.geocode('Town')).place.lat, 30);
  assert.equal((await service.reverseGeocode(30, -97)).locality, 'Town');
  assert.equal((await service.textSearch('Library', point))[0].name, 'Library');
  assert.deepEqual(await service.nearby(point), [point]);
  assert.deepEqual(await service.route(coordinates), {
    ...route,
    ok: true,
    profile: 'foot',
  });
  assert.equal(await service.route(coordinates, 'car'), null);
  assert.deepEqual(calls, [[30, -97]]);
});

test('unsupported operations and invalid coordinates never initiate a request', async () => {
  let calls = 0;
  const service = createGeospatialServices({
    providers: {
      route: () => {
        calls++;
      },
    },
  });
  assert.equal(service.capabilities.reverseGeocode, false);
  assert.equal(await service.reverseGeocode(30, -97), null);
  assert.equal(
    await service.route([
      [999, 30],
      [-97, 30],
    ]),
    null,
  );
  assert.equal(await service.route(coordinates, 'spaceship'), null);
  assert.equal(calls, 0);
  const invalid = createGeospatialServices({
    providers: { route: async () => ({ ...route, durationS: NaN }) },
  });
  assert.equal(await invalid.route(coordinates), null);
});

test('application or caller cancellation rejects late provider and body results', async () => {
  for (const lifetimeAbort of [true, false]) {
    const lifetime = new AbortController();
    const caller = new AbortController();
    const service = createGeospatialServices({
      signal: lifetime.signal,
      providers: createHttpGeospatialProvider({
        endpoints: { route: '/custom/route' },
        fetchImpl: async (_url, { signal }) => ({
          ok: true,
          async json() {
            (lifetimeAbort ? lifetime : caller).abort();
            assert.equal(signal.aborted, true);
            return { ...route, ok: true };
          },
        }),
      }),
    });
    await assert.rejects(
      service.route(coordinates, 'foot', { signal: caller.signal }),
      { name: 'AbortError' },
    );
  }
});

test('compatible HTTP endpoints retain units and never place a server credential in browser requests', async () => {
  const urls = [];
  const service = createGeospatialServices({
    providers: createHttpGeospatialProvider({
      endpoints: {
        reverse: '/geo/reverse',
        textSearch: '/geo/search',
        nearby: '/geo/nearby',
        route: '/geo/route',
      },
      fetchImpl: async (url) => {
        urls.push(new URL(url, 'https://example.test'));
        if (url.startsWith('/geo/reverse'))
          return json({
            status: 'OK',
            results: [{ formatted_address: 'Town', address_components: [] }],
          });
        if (url.startsWith('/geo/route')) return json({ ok: true, ...route });
        return json({ places: [{ name: 'Library', ...point }] });
      },
    }),
  });
  assert.equal(
    (await service.reverseGeocode(30, -97)).formattedAddress,
    'Town',
  );
  await service.textSearch('Library', point);
  await service.nearby(point);
  assert.equal((await service.route(coordinates)).distanceM, 120);
  assert.deepEqual(
    urls.map((url) => url.pathname),
    ['/geo/reverse', '/geo/search', '/geo/nearby', '/geo/route'],
  );
  assert.ok(urls.every((url) => !url.searchParams.has('key')));
});

test('HTTP refusal cancels its response and does not retry another destination', async () => {
  let cancelled = 0,
    calls = 0;
  const provider = createHttpGeospatialProvider({
    fetchImpl: async () => {
      calls++;
      return {
        ok: false,
        body: {
          async cancel() {
            cancelled++;
          },
        },
      };
    },
  });
  await assert.rejects(provider.nearby(point), /unavailable/);
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
});

test('Photon configuration changes its endpoint without changing its normalized result', async () => {
  const service = createDefaultPlaceSearch({
    endpoints: { photon: 'https://search.example/api/' },
    fetchImpl: async (url) => {
      assert.equal(new URL(url).origin, 'https://search.example');
      return json({
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-97, 30] },
            properties: { name: 'Town' },
          },
        ],
      });
    },
  });
  assert.equal((await service.geocode('Town')).place.lat, 30);
});

test('routing middleware uses configured OSRM servers while retaining request bounds and profile', async () => {
  let handler,
    calls = 0;
  installRouteMiddleware(
    {
      use(_path, fn) {
        handler = fn;
      },
    },
    {
      endpoints: { foot: 'https://routes.example/walking' },
      fetchImpl: async (url, options) => {
        calls++;
        assert.match(
          url,
          /^https:\/\/routes\.example\/walking\/route\/v1\/foot\//,
        );
        assert.equal(options.redirect, 'error');
        return json({
          code: 'Ok',
          routes: [{ geometry: { coordinates }, distance: 120, duration: 90 }],
        });
      },
    },
  );
  const request = async (query) => {
    let payload;
    await handler(
      { url: `/?${query}`, socket: { remoteAddress: '127.0.0.1' } },
      {
        writeHead() {},
        end(body) {
          payload = JSON.parse(body);
        },
      },
    );
    return payload;
  };
  assert.equal(
    (await request('profile=foot&coords=-97,30;-97.001,30.001')).distanceM,
    120,
  );
  assert.equal((await request('profile=foot&coords=-97,30;97,-30')).ok, false);
  assert.equal(calls, 1);
});

test('regional reverse geocoding uses the configured Nominatim endpoint and projection', async () => {
  const lookup = createRegionalPlaceProvider({
    endpoint: 'https://places.example/reverse',
    requestJson: async (url) => {
      assert.equal(new URL(url).origin, 'https://places.example');
      return { address: { city: 'Town', country: 'Country' } };
    },
  });
  assert.equal((await lookup(point)).locality, 'Town');
});
