import assert from 'node:assert/strict';
import test from 'node:test';
import { googlePlacesContextProxy, validatePlacesCoordinates } from '../server/providers/places/google.js';

function installGooglePlacesRoutes() {
  const routes = new Map();
  googlePlacesContextProxy({ resolveApiKey: () => process.env.GOOGLE_MAPS_API_KEY }).configureServer({
    middlewares: {
      use(path, handler) {
        routes.set(path, handler);
      },
    },
  });
  return routes;
}

function invokeRoute(handler, { method = 'GET', url = '/', remoteAddress = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = new Map();
    const req = { method, url, headers: {}, socket: { remoteAddress } };
    const res = {
      statusCode: 200,
      setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)); },
      end(body = '') {
        resolve({ statusCode: this.statusCode, headers: Object.fromEntries(headers), body: body ? JSON.parse(String(body)) : null });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('validatePlacesCoordinates refuses missing, blank, non-numeric, and out-of-range values', () => {
  const check = (query) => validatePlacesCoordinates(new URLSearchParams(query));
  for (const bad of ['', 'lat=30.27', 'lon=-97.74', 'lat=&lon=', 'lat=%20&lon=-97.74', 'lat=abc&lon=-97.74',
    'lat=Infinity&lon=-97.74', 'lat=NaN&lon=0', 'lat=90.001&lon=0', 'lat=-90.001&lon=0', 'lat=0&lon=180.5', 'lat=0&lon=-180.5']) {
    assert.equal(check(bad).ok, false, `${bad || '(empty)'} must be refused`);
  }
  // Inclusive boundaries are real places (the poles, the antimeridian).
  assert.deepEqual(check('lat=90&lon=-180'), { ok: true, latitude: 90, longitude: -180 });
  assert.deepEqual(check('lat=-90&lon=180'), { ok: true, latitude: -90, longitude: 180 });
  assert.deepEqual(check('lat=30.27&lon=-97.74'), { ok: true, latitude: 30.27, longitude: -97.74 });
});

test('both Places routes answer bad coordinates with a 400 before the limiter and before Google', async () => {
  const previousKey = process.env.GOOGLE_MAPS_API_KEY;
  const previousLimit = process.env.GEV_RATELIMIT_GOOGLE_PER_MIN;
  const originalFetch = globalThis.fetch;
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  process.env.GEV_RATELIMIT_GOOGLE_PER_MIN = '1';
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ places: [] }),
      text: async () => '{"places":[]}',
    };
  };
  try {
    const routes = installGooglePlacesRoutes();
    const nearby = routes.get('/api/google/nearby-places');
    const textSearch = routes.get('/api/google/text-search');
    const badQueries = ['', 'lat=30.27', 'lat=&lon=', 'lat=abc&lon=-97.74', 'lat=999&lon=-200'];
    for (const query of badQueries) {
      const nearbyResponse = await invokeRoute(nearby, { url: `/?${query}` });
      assert.equal(nearbyResponse.statusCode, 400, `nearby-places must refuse ${query || '(empty)'}`);
      assert.deepEqual(nearbyResponse.body.places, []);
      const textResponse = await invokeRoute(textSearch, { url: `/?q=capitol&${query}` });
      assert.equal(textResponse.statusCode, 400, `text-search must refuse ${query || '(empty)'}`);
      assert.deepEqual(textResponse.body.places, []);
    }
    const missingQuery = await invokeRoute(textSearch, { url: '/?lat=30.27&lon=-97.74' });
    assert.equal(missingQuery.statusCode, 400, 'text-search still requires q');
    assert.equal(upstreamCalls, 0, 'invalid input never reaches Google');

    // The limiter allows ONE request per minute per client. None of the
    // rejected requests may have consumed it, so the first valid request
    // still goes upstream instead of meeting a 429.
    const valid = await invokeRoute(nearby, { url: '/?lat=30.27&lon=-97.74' });
    assert.notEqual(valid.statusCode, 429, 'malformed requests must not consume limiter capacity');
    assert.equal(upstreamCalls, 1, 'a valid request reaches Google exactly once');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = previousKey;
    if (previousLimit === undefined) delete process.env.GEV_RATELIMIT_GOOGLE_PER_MIN;
    else process.env.GEV_RATELIMIT_GOOGLE_PER_MIN = previousLimit;
  }
});

test('preview validates both Places routes and keeps the keyless response', async () => {
  for (const key of ['', 'test-key']) {
    const routes = new Map();
    googlePlacesContextProxy({ resolveApiKey: () => key }).configurePreviewServer({
      middlewares: { use: (path, handler) => routes.set(path, handler) },
    });
    for (const name of ['nearby-places', 'text-search']) {
      const result = await invokeRoute(routes.get(`/api/google/${name}`), { url: '/?q=capitol&lat=&lon=', remoteAddress: 'preview-test' });
      assert.equal(result.statusCode, key ? 400 : 200);
      assert.deepEqual(result.body.places, []);
      if (!key) assert.equal(result.body.configured, false);
    }
  }
});
