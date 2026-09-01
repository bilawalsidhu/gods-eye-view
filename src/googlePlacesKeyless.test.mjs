import assert from 'node:assert/strict';
import test from 'node:test';
import { googlePlacesContextProxy, keylessGooglePlacesResponse } from '../vite.config.js';

const KEYLESS_PAYLOAD = { configured: false, error: null, places: [] };

function installGooglePlacesRoutes() {
  const routes = new Map();
  googlePlacesContextProxy().configureServer({
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
    const req = {
      method,
      url,
      headers: {},
      socket: { remoteAddress },
    };
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers.set(String(name).toLowerCase(), String(value));
      },
      end(body = '') {
        resolve({
          statusCode: this.statusCode,
          headers: Object.fromEntries(headers),
          body: body ? JSON.parse(String(body)) : null,
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('builds the keyless capability response only for a blank key', () => {
  assert.deepEqual(keylessGooglePlacesResponse(undefined), {
    statusCode: 200,
    payload: KEYLESS_PAYLOAD,
  });
  assert.deepEqual(keylessGooglePlacesResponse('  '), {
    statusCode: 200,
    payload: KEYLESS_PAYLOAD,
  });
  assert.equal(keylessGooglePlacesResponse('configured-key'), null);
});

test('keyless Places routes stay successful after the Google quota is exhausted', async () => {
  const previousKey = process.env.GOOGLE_MAPS_API_KEY;
  const previousLimit = process.env.GEV_RATELIMIT_GOOGLE_PER_MIN;
  process.env.GOOGLE_MAPS_API_KEY = '';
  process.env.GEV_RATELIMIT_GOOGLE_PER_MIN = '1';
  try {
    const routes = installGooglePlacesRoutes();
    const nearby = routes.get('/api/google/nearby-places');
    const textSearch = routes.get('/api/google/text-search');
    assert.equal(typeof nearby, 'function');
    assert.equal(typeof textSearch, 'function');

    // The limiter allows one request per minute; a keyless capability response
    // must never consume that quota, so every request on both routes — well
    // past the limit — stays the same deliberate 200.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const nearbyResponse = await invokeRoute(nearby, { url: '/?lat=30.27&lon=-97.74' });
      assert.equal(nearbyResponse.statusCode, 200);
      assert.equal(nearbyResponse.headers['cache-control'], 'no-store');
      assert.deepEqual(nearbyResponse.body, KEYLESS_PAYLOAD);

      const textResponse = await invokeRoute(textSearch, { url: '/?q=capitol&lat=30.27&lon=-97.74' });
      assert.equal(textResponse.statusCode, 200);
      assert.equal(textResponse.headers['cache-control'], 'no-store');
      assert.deepEqual(textResponse.body, KEYLESS_PAYLOAD);
    }
  } finally {
    if (previousKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = previousKey;
    if (previousLimit === undefined) delete process.env.GEV_RATELIMIT_GOOGLE_PER_MIN;
    else process.env.GEV_RATELIMIT_GOOGLE_PER_MIN = previousLimit;
  }
});
