import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cctvProxy } from '../../server/providers/cctv.js';
import { googlePlacesContextProxy } from '../../server/providers/places/google.js';

// T4 (breaker minor): Places and the Street View fallback each built their own
// limiter from GEV_RATELIMIT_GOOGLE_PER_MIN, so a client really got twice the
// documented Google budget. Both must spend ONE per-IP budget.

function setEnv(t, env) {
  for (const name of [
    'GOOGLE_MAPS_SERVER_API_KEY',
    'GOOGLE_MAPS_API_KEY',
    'GEV_RATELIMIT_GOOGLE_PER_MIN',
    'WEBSITE_INSTANCE_ID',
    'GEV_STREETVIEW_CACHE_TTL_MS',
    'CCTV_SOURCES_FILE',
    'CCTV_SOURCES_JSON',
    'CCTV_FORCE_AUSTIN',
  ]) {
    const previous = process.env[name];
    if (name in env) process.env[name] = env[name];
    else delete process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
}

function capture(plugin) {
  const routes = new Map();
  plugin.configurePreviewServer({
    middlewares: {
      use(route, fn) {
        routes.set(route, fn);
      },
    },
  });
  return routes;
}

function call(handler, url, remoteAddress) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers[String(name).toLowerCase()] = String(value);
      },
      writeHead(status, extra = {}) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(extra))
          headers[k.toLowerCase()] = String(v);
      },
      end(body) {
        resolve({ status: this.statusCode, headers, body });
      },
    };
    Promise.resolve(
      handler({ url, method: 'GET', headers: {}, socket: { remoteAddress } }, res),
    ).catch(reject);
  });
}

test('T4: Places and Street View spend one GEV_RATELIMIT_GOOGLE_PER_MIN budget', async (t) => {
  setEnv(t, {
    GOOGLE_MAPS_SERVER_API_KEY: 'server-fixture-key',
    GEV_RATELIMIT_GOOGLE_PER_MIN: '1',
  });
  const root = mkdtempSync(path.join(tmpdir(), 'gev-google-shared-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'config'));
  writeFileSync(
    path.join(root, 'config/cctv_sources.austin.json'),
    JSON.stringify([
      { id: 'cam-1', name: 'Fixture', lat: 30.27, lon: -97.74, feedType: 'image' },
    ]),
  );
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls.push(new URL(String(raw)).hostname);
    if (String(raw).includes('places.googleapis.com'))
      return new Response('{"places":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  });
  const cctv = capture(cctvProxy({ sourceRoot: root })).get('/api/cctv');
  const places = capture(googlePlacesContextProxy()).get(
    '/api/google/nearby-places',
  );
  const ip = '198.51.100.60';

  const frame = await call(cctv, '/frame/cam-1', ip);
  assert.equal(frame.headers['x-cctv-source'], 'streetview');
  const nearby = await call(places, '/?lat=30.27&lon=-97.74', ip);
  assert.equal(nearby.status, 429, 'the Street View call spent the budget');
  assert.deepEqual(calls, ['maps.googleapis.com']);
});
