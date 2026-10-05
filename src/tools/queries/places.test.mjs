import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';
import { createPlaceSearchService, createRouteService } from '../places.js';

const place = (id, latitude, longitude, extra = {}) => ({
  id,
  name: `Place ${id}`,
  address: `${id} Main St`,
  latitude,
  longitude,
  distanceM: 120,
  primaryType: 'cafe',
  types: ['cafe'],
  ...extra,
});
const placeSearch = (result) => ({
  calls: [],
  async search(query, near) {
    this.calls.push({ query, ...near });
    return result;
  },
  async nearby(near) {
    this.calls.push(near);
    return result;
  },
});
const places = {
  resolve: async (name) =>
    ({
      Austin: {
        name: 'Austin, Texas',
        bounds: { west: -97.94, south: 30.1, east: -97.56, north: 30.52 },
      },
      Dallas: {
        name: 'Dallas, Texas',
        bounds: { west: -96.99, south: 32.62, east: -96.46, north: 33.02 },
      },
    })[name] ?? null,
};

test('place search is centered on the area, kept inside it, and reports a missing key', async () => {
  const search = placeSearch({
    configured: true,
    places: [place('a', 30.27, -97.74), place('far', 40.7, -74)],
  });
  const catalog = composeCatalog({
    tools: coreTools,
    services: { placeSearch: search, places },
  });
  const result = await catalog.call('search_places', {
    query: 'coffee',
    area: { place: 'Austin' },
  });
  assert.equal(result.summary, '1 place matching "coffee" in Austin, Texas.');
  assert.deepEqual(result.data.rows[0], {
    id: 'a',
    name: 'Place a',
    address: 'a Main St',
    type: 'cafe',
    lat: 30.27,
    lon: -97.74,
    distance_m: 120,
  });
  assert.equal(search.calls[0].query, 'coffee');
  assert.ok(Math.abs(search.calls[0].latitude - 30.31) < 1e-9);
  assert.equal(search.calls[0].radiusM, 29642);

  const unconfigured = composeCatalog({
    tools: coreTools,
    services: {
      placeSearch: placeSearch({ configured: false, places: [] }),
      places,
    },
  });
  await assert.rejects(
    unconfigured.call('search_places', {
      query: 'coffee',
      area: { place: 'Austin' },
    }),
    (error) =>
      error.code === 'unavailable' && /Google Places key/.test(error.message),
  );
});

test('nearby places use the given radius', async () => {
  const search = placeSearch({
    configured: true,
    places: [place('a', 30.27, -97.74)],
  });
  const catalog = composeCatalog({
    tools: coreTools,
    services: { placeSearch: search },
  });
  const result = await catalog.call('places_nearby', {
    location: { lat: 30.27, lon: -97.74 },
    radius_m: 400,
  });
  assert.equal(result.summary, '1 place within 400 m of 30.2700, -97.7400.');
  assert.deepEqual(search.calls[0], {
    latitude: 30.27,
    longitude: -97.74,
    radiusM: 400,
  });
});

test('routes resolve endpoints, map modes and thin long paths', async () => {
  const requests = [];
  const geometry = Array.from({ length: 250 }, (_, index) => [
    -97.74 + index / 1000,
    30.27,
  ]);
  const routing = {
    async route(points, profile) {
      requests.push({ points, profile });
      return {
        ok: true,
        profile,
        distanceM: 312400,
        durationS: 11220,
        geometry,
      };
    },
  };
  const catalog = composeCatalog({
    tools: coreTools,
    services: { routing, places },
  });
  const result = await catalog.call('plan_route', {
    from: { place: 'Austin' },
    to: { lat: 32.78, lon: -96.8 },
    mode: 'drive',
  });
  assert.equal(
    result.summary,
    'Drive from Austin, Texas to 32.7800, -96.8000: 312.4 km, about 187 minutes.',
  );
  assert.equal(requests[0].profile, 'car');
  assert.deepEqual(requests[0].points[1], {
    label: '32.7800, -96.8000',
    lat: 32.78,
    lon: -96.8,
  });
  assert.equal(result.data.path_points, 250);
  assert.equal(result.data.path_lon_lat.length, 100);
  assert.deepEqual(result.data.path_lon_lat.at(-1), [-97.491, 30.27]);

  const failing = composeCatalog({
    tools: coreTools,
    services: {
      routing: {
        route: async () => ({ ok: false, error: 'route leg too long' }),
      },
      places,
    },
  });
  await assert.rejects(
    failing.call('plan_route', {
      from: { place: 'Austin' },
      to: { place: 'Dallas' },
    }),
    /No walk route from Austin, Texas to Dallas, Texas: route leg too long/,
  );
  await assert.rejects(
    catalog.call('plan_route', {
      from: { place: 'Austin', lat: 1 },
      to: { lat: 1, lon: 2 },
    }),
    /either place, or lat and lon/,
  );
});

test('the place and route services read the app routes and translate failures', async () => {
  const requested = [];
  const respond = (body, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  const search = createPlaceSearchService({
    fetchImpl: async (url) => {
      requested.push(url);
      return url.includes('nearby')
        ? respond({ configured: false, error: null, places: [] })
        : respond({ places: [place('a', 1, 2)] });
    },
  });
  assert.deepEqual(
    await search.search('tea', { latitude: 1, longitude: 2, radiusM: 300 }),
    {
      configured: true,
      places: [place('a', 1, 2)],
    },
  );
  assert.deepEqual(
    await search.nearby({ latitude: 1, longitude: 2, radiusM: 50 }),
    { configured: false, places: [] },
  );
  assert.deepEqual(requested, [
    '/api/google/text-search?q=tea&lat=1&lon=2&radiusM=300',
    '/api/google/nearby-places?lat=1&lon=2&radiusM=50',
  ]);

  const limited = createPlaceSearchService({
    fetchImpl: async () =>
      respond({ error: 'Rate limit exceeded', places: [] }, 429, {
        'Retry-After': '30',
      }),
  });
  await assert.rejects(
    limited.nearby({ latitude: 1, longitude: 2, radiusM: 50 }),
    (error) => error.code === 'retry_later' && error.retryAfterSeconds === 30,
  );

  const routes = [];
  const routing = createRouteService({
    fetchImpl: async (url) => {
      routes.push(url);
      if (routes.length === 1)
        return respond({
          ok: true,
          distanceM: 10,
          durationS: 5,
          geometry: [[2, 1]],
        });
      if (routes.length === 2)
        return respond({ ok: false, error: 'need 2-12 coordinates' }, 400);
      return respond({ ok: false, error: 'rate limited' }, 429, {
        'Retry-After': '5',
      });
    },
  });
  const points = [
    { lat: 1, lon: 2 },
    { lat: 1.5, lon: 2.5 },
  ];
  assert.equal((await routing.route(points, 'foot')).distanceM, 10);
  assert.equal(
    routes[0],
    '/api/route?profile=foot&coords=2.000000%2C1.000000%3B2.500000%2C1.500000',
  );
  assert.deepEqual(await routing.route(points, 'foot'), {
    ok: false,
    error: 'need 2-12 coordinates',
  });
  await assert.rejects(
    routing.route(points, 'foot'),
    (error) => error.code === 'retry_later' && error.retryAfterSeconds === 5,
  );
});

test('place answers say when the search limits may have left places out', async () => {
  const five = Array.from({ length: 5 }, (_, index) =>
    place(`p${index}`, 30.27, -97.74),
  );
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      placeSearch: placeSearch({ configured: true, places: five }),
      places,
    },
  });
  const capped = await catalog.call('search_places', {
    query: 'coffee',
    area: { place: 'Austin' },
    limit: 100,
  });
  assert.equal(capped.data.may_have_more, true);
  assert.match(capped.summary, /the search returns at most 5 matches\)\.$/);
  const wide = await catalog.call('search_places', {
    query: 'coffee',
    area: { lat: 30.27, lon: -97.74, radius_km: 200 },
  });
  assert.equal(wide.data.searched_radius_km, 50);
  assert.match(wide.summary, /searched within 50 km of the center/);
});
