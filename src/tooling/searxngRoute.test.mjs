// THE SEARXNG PLACE ROUTES — the operator's own instance stays server-side.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSearxngSearch,
  normalizeSearxngHit,
  searxngBaseUrl,
  searxngPlacesProxy,
} from '../../server/providers/places/searxng.js';
import { localProviderPlugins } from '../../server/providers/local.js';

const RIJKSMUSEUM = {
  title: 'Rijksmuseum',
  latitude: 52.3598431,
  longitude: 4.8850395,
  boundingbox: [52.3589151, 52.3608067, 4.8834356, 4.8865559],
  address: {
    road: 'Paulus Potterstraat',
    locality: 'Amsterdam',
    country: 'Netherlands',
  },
  engine: 'photon',
};
const ELSEWHERE = {
  title: 'Rijksmuseum Twenthe',
  latitude: 52.2236,
  longitude: 6.8937,
  boundingbox: null,
  address: null,
};

let clientCounter = 0;

function mount(plugin) {
  clientCounter += 1;
  const remoteAddress = `10.1.0.${clientCounter % 250}`;
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  return async function request(route, search = '') {
    const handler = routes.get(route);
    assert.ok(handler, `missing ${route}`);
    const req = {
      method: 'GET',
      url: `/${search}`,
      headers: {},
      socket: { remoteAddress },
      on() {},
    };
    return await new Promise((resolve, reject) => {
      const res = {
        writableEnded: false,
        on() {},
        writeHead(status, headers) {
          res.status = status;
          res.headers = headers;
        },
        end(body) {
          res.writableEnded = true;
          resolve({ status: res.status, body: JSON.parse(body) });
        },
      };
      Promise.resolve(handler(req, res)).catch(reject);
    });
  };
}

function upstream(results, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    return Response.json({ query: 'q', results });
  };
}

test('SEARXNG_URL keeps only the instance root and refuses non-http values', () => {
  assert.equal(
    searxngBaseUrl({
      SEARXNG_URL: 'https://searx.example/preferences?preferences=abc',
    }),
    'https://searx.example',
  );
  assert.equal(
    searxngBaseUrl({ SEARXNG_URL: 'https://example.test/searx/search?q=x' }),
    'https://example.test/searx',
  );
  assert.equal(searxngBaseUrl({}), null);
  assert.equal(searxngBaseUrl({ SEARXNG_URL: 'file:///etc/passwd' }), null);
  assert.equal(searxngBaseUrl({ SEARXNG_URL: 'https://u:p@x.test' }), null);
});

test('map results become Nominatim-shaped hits; unusable rows are dropped', () => {
  assert.deepEqual(normalizeSearxngHit(RIJKSMUSEUM), {
    lat: 52.3598431,
    lon: 4.8850395,
    name: 'Rijksmuseum',
    display_name: 'Rijksmuseum, Paulus Potterstraat, Amsterdam, Netherlands',
    boundingbox: RIJKSMUSEUM.boundingbox,
  });
  assert.equal(normalizeSearxngHit({ title: 'x', latitude: null }), null);
  assert.equal(
    normalizeSearxngHit({ title: '', latitude: 1, longitude: 1 }),
    null,
  );
  assert.equal(
    normalizeSearxngHit({ title: 'x', latitude: 91, longitude: 1 }),
    null,
  );
});

test('an unconfigured instance answers as an empty capability without a request', async () => {
  const calls = [];
  const request = mount(
    searxngPlacesProxy({
      search: createSearxngSearch({
        resolveBaseUrl: () => null,
        fetchImpl: upstream([], calls),
      }),
    }),
  );
  const geocode = await request('/api/searxng/geocode', '?q=Rijksmuseum');
  assert.equal(geocode.status, 200);
  assert.deepEqual(geocode.body, {
    status: 'ZERO_RESULTS',
    results: [],
    configured: false,
  });
  const text = await request('/api/searxng/text-search', '?q=x&lat=1&lon=1');
  assert.deepEqual(text.body, { places: [], configured: false });
  assert.equal(calls.length, 0);
});

test('geocode asks the map category once, refuses redirects and caches the answer', async () => {
  const calls = [];
  const request = mount(
    searxngPlacesProxy({
      search: createSearxngSearch({
        resolveBaseUrl: () => 'https://searx.example',
        fetchImpl: upstream([RIJKSMUSEUM], calls),
      }),
    }),
  );
  const first = await request('/api/searxng/geocode', '?q=Rijksmuseum');
  await request('/api/searxng/geocode', '?q=rijksmuseum');
  assert.equal(first.body.status, 'OK');
  assert.deepEqual(first.body.results[0].geometry.location, {
    lat: 52.3598431,
    lng: 4.8850395,
  });
  assert.equal(calls.length, 1);
  const sent = new URL(calls[0].url);
  assert.equal(sent.origin + sent.pathname, 'https://searx.example/search');
  assert.equal(sent.searchParams.get('format'), 'json');
  assert.equal(sent.searchParams.get('categories'), 'map');
  assert.equal(calls[0].options.redirect, 'error');
});

test('geocode prefers a hit inside the bias bounds', async () => {
  const request = mount(
    searxngPlacesProxy({
      search: createSearxngSearch({
        resolveBaseUrl: () => 'https://searx.example',
        fetchImpl: upstream([RIJKSMUSEUM, ELSEWHERE]),
      }),
    }),
  );
  const biased = await request(
    '/api/searxng/geocode',
    `?q=Rijksmuseum&bounds=${encodeURIComponent('52,6.5|52.5,7')}`,
  );
  assert.equal(biased.body.results[0].geometry.location.lng, 6.8937);
});

test('text search keeps nearby places only, in SearXNG relevance order', async () => {
  const request = mount(
    searxngPlacesProxy({
      search: createSearxngSearch({
        resolveBaseUrl: () => 'https://searx.example',
        fetchImpl: upstream([ELSEWHERE, RIJKSMUSEUM]),
      }),
    }),
  );
  const result = await request(
    '/api/searxng/text-search',
    '?q=Rijksmuseum&lat=52.36&lon=4.88&radiusM=6000',
  );
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.places.map((place) => place.name),
    ['Rijksmuseum'],
  );
  assert.ok(result.body.places[0].viewport.low.latitude < 52.36);
});

test('upstream failures are sanitized and the query is bounded', async () => {
  const request = mount(
    searxngPlacesProxy({
      search: createSearxngSearch({
        resolveBaseUrl: () => 'https://searx.example',
        fetchImpl: async () => new Response('forbidden', { status: 403 }),
      }),
    }),
  );
  const failed = await request('/api/searxng/geocode', '?q=Paris');
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error, 'SearXNG search is temporarily unavailable');
  const long = await request('/api/searxng/geocode', `?q=${'x'.repeat(201)}`);
  assert.equal(long.status, 400);
  // `/api/searxng/geocode//?q=a` reaches the handler as `//?q=a`, which is
  // not a URL; it must be refused, not thrown out of the middleware.
  const malformed = await request('/api/searxng/geocode', '/?q=a');
  assert.equal(malformed.status, 400);
});

test('the local server mounts SearXNG before the Google place routes', () => {
  const names = localProviderPlugins().map((plugin) => plugin.name);
  const searxng = names.indexOf('searxng-places-proxy');
  assert.ok(searxng >= 0);
  assert.ok(searxng < names.findIndex((name) => /google/i.test(name)));
});
