import assert from 'node:assert/strict';
import test from 'node:test';
import {
  googlePlacesContextProxy,
  validateGeocodeAddress,
  geocodeBounds,
} from '../vite.config.js';

const UPSTREAM = 'https://geocode.test/json';

function installRoutes({ apiKey = 'server-secret', fetchImpl } = {}) {
  const routes = new Map();
  googlePlacesContextProxy({
    resolveApiKey: () => apiKey,
    fetchImpl,
    endpoints: { geocode: UPSTREAM },
  }).configureServer({
    middlewares: { use: (name, handler) => routes.set(name, handler) },
  });
  return routes;
}

function invokeRoute(handler, { method = 'GET', url = '/' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = new Map();
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
    Promise.resolve(
      handler(
        { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
        res,
      ),
    ).catch(reject);
  });
}

test('geocoder query and viewport bias are validated before Google is paid', () => {
  assert.deepEqual(validateGeocodeAddress(new URLSearchParams()), {
    ok: false,
    error: 'address is required',
  });
  assert.deepEqual(validateGeocodeAddress(new URLSearchParams({ address: '  ' })), {
    ok: false,
    error: 'address is required',
  });
  assert.deepEqual(
    validateGeocodeAddress(new URLSearchParams({ address: 'x'.repeat(201) })),
    { ok: false, error: 'address is too long' },
  );
  assert.deepEqual(
    validateGeocodeAddress(new URLSearchParams({ address: ' Austin ' })),
    { ok: true, address: 'Austin' },
  );

  // A bias only ranks results, so an unusable one is dropped, not refused.
  const bias = '30.1,-97.9|30.4,-97.6';
  assert.equal(geocodeBounds(new URLSearchParams({ bounds: bias })), bias);
  for (const bounds of [
    '',
    '30.1,-97.9',
    '30.1,-97.9|30.4',
    'north,-97.9|30.4,-97.6',
    '91,-97.9|30.4,-97.6',
    '30.1,-181|30.4,-97.6',
    // A blank component must not read as 0 — that is the equator, not a corner.
    '30.1,-97.9|30.4,',
    '30.1,|30.4,-97.6',
    '30.1,-97.9| ,-97.6',
  ])
    assert.equal(geocodeBounds(new URLSearchParams({ bounds })), null);
});

test('the geocode routes keep the key server-side and answer in Google shape', async () => {
  const upstream = [];
  const routes = installRoutes({
    fetchImpl: async (url) => {
      upstream.push(new URL(String(url)));
      return Response.json({ status: 'OK', results: [{ place_id: 'fixture' }] });
    },
  });
  const forward = routes.get('/api/google/geocode');
  const reverse = routes.get('/api/google/reverse-geocode');
  assert.equal(typeof forward, 'function');
  assert.equal(typeof reverse, 'function');

  const forwarded = await invokeRoute(forward, {
    url: '/?address=Austin&bounds=30.1,-97.9|30.4,-97.6',
  });
  assert.equal(forwarded.statusCode, 200);
  assert.deepEqual(forwarded.body, {
    status: 'OK',
    results: [{ place_id: 'fixture' }],
  });
  assert.equal(upstream.at(-1).searchParams.get('address'), 'Austin');
  assert.equal(upstream.at(-1).searchParams.get('bounds'), '30.1,-97.9|30.4,-97.6');
  assert.equal(upstream.at(-1).searchParams.get('key'), 'server-secret');

  const reversed = await invokeRoute(reverse, { url: '/?lat=30.27&lon=-97.74' });
  assert.equal(reversed.statusCode, 200);
  assert.equal(upstream.at(-1).searchParams.get('latlng'), '30.27,-97.74');
  assert.equal(upstream.at(-1).searchParams.get('key'), 'server-secret');

  // The key travels to Google, never back to the page that asked.
  assert.ok(!JSON.stringify(forwarded.body).includes('server-secret'));
  assert.ok(!JSON.stringify(reversed.body).includes('server-secret'));

  // A malformed bias is dropped rather than forwarded.
  await invokeRoute(forward, { url: '/?address=Austin&bounds=north' });
  assert.equal(upstream.at(-1).searchParams.has('bounds'), false);
});

test('a bad or keyless geocode request never reaches Google', async () => {
  const upstream = [];
  const fetchImpl = async (url) => {
    upstream.push(String(url));
    return Response.json({ status: 'OK', results: [] });
  };

  const routes = installRoutes({ fetchImpl });
  for (const [path, url] of [
    ['/api/google/geocode', '/?address='],
    ['/api/google/reverse-geocode', '/?lat=91&lon=-97.74'],
  ]) {
    const response = await invokeRoute(routes.get(path), { url });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body.results, []);
    assert.equal(response.body.status, 'REQUEST_DENIED');
  }

  for (const path of ['/api/google/geocode', '/api/google/reverse-geocode']) {
    const rejected = await invokeRoute(routes.get(path), {
      method: 'POST',
      url: '/?address=Austin&lat=30&lon=-97',
    });
    assert.equal(rejected.statusCode, 405);
  }

  // Keyless is an empty capability, not an outage: a 200 the browser adapters
  // read as "this provider did not answer", so the chain moves on. It resolves
  // ahead of validation, like the Places routes: with nothing configured there
  // is no request to validate and no quota to protect.
  const keyless = installRoutes({ apiKey: '  ', fetchImpl });
  for (const path of ['/api/google/geocode', '/api/google/reverse-geocode'])
    for (const url of ['/?address=Austin&lat=30&lon=-97', '/?address=&lat=91']) {
      const response = await invokeRoute(keyless.get(path), { url });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.body, {
        configured: false,
        status: 'REQUEST_DENIED',
        results: [],
        error: null,
      });
    }

  assert.deepEqual(upstream, []);
});

test('an upstream failure reaches the browser as fixed public text', async () => {
  const routes = installRoutes({
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.7:443');
    },
  });
  for (const path of ['/api/google/geocode', '/api/google/reverse-geocode']) {
    const response = await invokeRoute(routes.get(path), {
      url: '/?address=Austin&lat=30&lon=-97',
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.body, {
      status: 'UNKNOWN_ERROR',
      results: [],
      error: 'Google Geocoding request failed',
    });
  }
});

test('an oversized upstream body is dropped rather than buffered', async () => {
  const routes = installRoutes({
    // Two hundred times the 256 KiB ceiling, declared honestly.
    fetchImpl: async () =>
      Response.json({ status: 'OK', results: [{ pad: 'x'.repeat(52_428_800) }] }),
  });
  const response = await invokeRoute(routes.get('/api/google/geocode'), {
    url: '/?address=Austin',
  });
  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.body, {
    status: 'UNKNOWN_ERROR',
    results: [],
    error: 'Google Geocoding request failed',
  });
});
