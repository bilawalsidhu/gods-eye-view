import assert from 'node:assert/strict';
import test from 'node:test';
import { googlePlacesContextProxy } from '../vite.config.js';

function installGeocodeRoute(options) {
  const routes = new Map();
  googlePlacesContextProxy(options).configureServer({
    middlewares: {
      use(path, handler) {
        routes.set(path, handler);
      },
    },
  });
  return routes.get('/api/google/geocode');
}

function invokeRoute(handler, { method = 'GET', url = '/' } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body = '') {
        resolve({
          statusCode: this.statusCode,
          body: body ? JSON.parse(String(body)) : null,
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('geocode proxy answers keyless as an unconfigured provider', async () => {
  let calls = 0;
  const route = installGeocodeRoute({
    resolveApiKey: () => '',
    fetchImpl: async () => {
      calls++;
    },
  });
  const response = await invokeRoute(route, { url: '/?address=Baltimore' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'REQUEST_DENIED');
  assert.deepEqual(response.body.results, []);
  assert.equal(calls, 0);
});

test('geocode proxy forwards address, bounds or latlng with the server key', async () => {
  const urls = [];
  const route = installGeocodeRoute({
    resolveApiKey: () => 'server-key',
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return new Response(
        JSON.stringify({
          status: 'OK',
          results: [{ formatted_address: 'Fort McHenry' }],
        }),
      );
    },
  });

  const forward = await invokeRoute(route, {
    url: '/?address=Fort%20McHenry&bounds=39,-77|40,-76',
  });
  assert.equal(forward.statusCode, 200);
  assert.equal(forward.body.status, 'OK');
  assert.equal(forward.body.results[0].formatted_address, 'Fort McHenry');
  assert.equal(urls[0].searchParams.get('address'), 'Fort McHenry');
  assert.equal(urls[0].searchParams.get('bounds'), '39,-77|40,-76');
  assert.equal(urls[0].searchParams.get('key'), 'server-key');

  await invokeRoute(route, { url: '/?latlng=39.26,-76.58' });
  assert.equal(urls[1].searchParams.get('latlng'), '39.26,-76.58');
  assert.equal(urls[1].searchParams.has('address'), false);
});

test('geocode proxy rejects ambiguous requests before spending quota', async () => {
  let calls = 0;
  const route = installGeocodeRoute({
    resolveApiKey: () => 'server-key',
    fetchImpl: async () => {
      calls++;
    },
  });
  for (const url of ['/', '/?address=a&latlng=1,2']) {
    const response = await invokeRoute(route, { url });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.status, 'INVALID_REQUEST');
  }
  const post = await invokeRoute(route, { method: 'POST', url: '/?address=a' });
  assert.equal(post.statusCode, 405);
  assert.equal(calls, 0);
});
