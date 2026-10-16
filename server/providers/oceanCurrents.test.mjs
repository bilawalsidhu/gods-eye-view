import test from 'node:test';
import assert from 'node:assert/strict';
import {
  oceanCurrentsProxy,
  GLOBAL_SPAN_KM,
  REGIONAL_TARGET_CELLS,
  quantizeBox,
  gridId,
} from './oceanCurrents.js';
import { NO_DATA } from '../ocean/packField.js';

function okPayload(grid, { tier = 'global', validAtMs = 1_759_990_000_000 } = {}) {
  const n = grid.nLat * grid.nLon;
  return {
    status: 'ok',
    format: 'gev-ocean-field',
    version: 1,
    generatedAtMs: 1,
    requestedAtMs: 1,
    box: {
      latMin: grid.lat0,
      lonMin: grid.lon0,
      latMax: grid.lat0 + (grid.nLat - 1) * grid.dLat,
      lonMax: grid.lon0 + (grid.nLon - 1) * grid.dLon,
    },
    grid,
    u: Array.from({ length: n }, (_, k) => (k % 7 === 3 ? null : 0.1 * (k % 5))),
    v: Array.from({ length: n }, (_, k) => (k % 7 === 3 ? null : 0)),
    stats: {},
    provenance: { tier, tierLabel: 'x', validAtMs, stale: false, caveats: [], sources: [] },
    attempts: [],
    reason: null,
  };
}
const GLOBAL = { lat0: -90, lon0: -180, dLat: 1, dLon: 1, nLat: 181, nLon: 360 };
const REGION = { lat0: 30, lon0: -75, dLat: 0.5, dLon: 0.5, nLat: 19, nLon: 19 };

function handlerFor(options = {}) {
  let handler = null;
  oceanCurrentsProxy({
    fetchImpl: async () => {
      throw new Error('no network');
    },
    ...options,
  }).configureServer({
    middlewares: {
      use(mount, fn) {
        assert.equal(mount, '/api/ocean/currents');
        handler = fn;
      },
    },
  });
  return handler;
}
async function call(handler, url, { method = 'GET' } = {}) {
  const res = {
    statusCode: null,
    headers: null,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
    once() {},
    removeListener() {},
  };
  await handler({ method, url, socket: { remoteAddress: '127.0.0.1' }, headers: {} }, res);
  const json = res.headers?.['Content-Type'] === 'application/json' ? JSON.parse(res.body) : null;
  return { status: res.statusCode, headers: res.headers, json, body: res.body };
}
const REGIONAL_QUERY = '?latMin=30&latMax=39&lonMin=-75&lonMax=-66';
const GLOBAL_QUERY = '?latMin=-60&latMax=60&lonMin=-120&lonMax=60';

test('refuses non-GET, unknown paths and malformed boxes with the old 400 shape', async () => {
  const h = handlerFor();
  assert.equal((await call(h, '/manifest', { method: 'POST' })).status, 405);
  assert.equal((await call(h, '/nope')).status, 404);
  for (const query of [
    '',
    '?latMin=abc&latMax=1&lonMin=2&lonMax=3',
    '?latMin=40&latMax=30&lonMin=2&lonMax=3',
    '?latMin=30&latMax=40&lonMin=2&lonMax=2',
    '?latMin=-100&latMax=40&lonMin=2&lonMax=3',
  ]) {
    const { status, json } = await call(h, `/manifest${query}`);
    assert.equal(status, 400, query);
    assert.match(json.error, /latMin\/latMax\/lonMin\/lonMax/);
    assert.equal(typeof json.detail, 'string');
  }
  const omitted = await call(h, '/manifest?latMax=1&lonMin=2&lonMax=3');
  assert.match(omitted.json.detail, /latMin is not a finite number/);
});

test('span above GLOBAL_SPAN_KM serves the cached global lattice; below it runs the regional pipeline', async () => {
  const calls = { global: 0, regional: [] };
  const h = handlerFor({
    now: () => 1_760_000_000_000,
    deps: {
      buildGlobalLatticePayload: async () => {
        calls.global += 1;
        return okPayload(GLOBAL);
      },
      buildFieldPayload: async ({ box, targetCells }) => {
        calls.regional.push({ box, targetCells });
        return okPayload(REGION, { tier: 'global' });
      },
    },
  });
  const globe = await call(h, `/manifest${GLOBAL_QUERY}`);
  assert.equal(globe.status, 200);
  assert.equal(globe.json.tier, 'global');
  assert.deepEqual(globe.json.grid, { nx: 360, ny: 181, lo1: -180, la1: 90, dx: 1, dy: 1 });
  assert.deepEqual(globe.json.bbox, { latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 });
  assert.equal(globe.json.noData, NO_DATA);
  assert.equal(
    globe.json.gridUrl,
    `/api/ocean/currents/grid/${gridId({ tier: 'global', validIso: '2025-10-09T06:06:40.000Z', key: 'global', nx: 360, ny: 181 })}.bin`,
  );
  assert.equal(globe.json.speed.totalCells, 360 * 181);
  await call(h, '/manifest?latMin=-80&latMax=80&lonMin=-180&lonMax=180');
  assert.equal(calls.global, 1, 'one global build serves every wide box');
  const region = await call(h, `/manifest${REGIONAL_QUERY}`);
  assert.equal(region.json.tier, 'regional');
  assert.equal(region.json.grid.ny, 19);
  assert.equal(region.json.grid.la1, 39);
  assert.deepEqual(calls.regional[0].box, quantizeBox({ latMin: 30, latMax: 39, lonMin: -75, lonMax: -66 }));
  assert.equal(calls.regional[0].targetCells, REGIONAL_TARGET_CELLS);
  assert.deepEqual(region.json.bbox, { latMin: 30, latMax: 39, lonMin: -75, lonMax: -66 });
  assert.equal(GLOBAL_SPAN_KM, 5000);
});

test('grid route serves the exact Float32 body with immutable caching and 404s unknown ids', async () => {
  const h = handlerFor({
    deps: {
      buildGlobalLatticePayload: async () => okPayload(GLOBAL),
      buildFieldPayload: async () => okPayload(REGION),
    },
  });
  const manifest = (await call(h, `/manifest${REGIONAL_QUERY}`)).json;
  const grid = await call(h, manifest.gridUrl.replace('/api/ocean/currents', ''));
  assert.equal(grid.status, 200);
  assert.equal(grid.headers['Content-Type'], 'application/octet-stream');
  assert.equal(grid.headers['Cache-Control'], 'public, max-age=3600, immutable');
  assert.equal(grid.body.byteLength, 19 * 19 * 8);
  const values = new Float32Array(grid.body.buffer, grid.body.byteOffset, 19 * 19 * 2);
  assert.ok(values.includes(NO_DATA));
  assert.equal((await call(h, '/grid/currents-nope.bin')).status, 404);
  const status = await call(h, `/status${REGIONAL_QUERY}`);
  assert.equal(status.json.gridUrl, undefined);
  assert.equal(status.json.tier, 'regional');
});

test('a quantized box within half a degree reuses the cache; a failed refresh serves stale then unavailable', async () => {
  let clock = 1_760_000_000_000;
  let fail = false;
  let builds = 0;
  const h = handlerFor({
    now: () => clock,
    ttlMs: 1000,
    staleMs: 5000,
    deps: {
      buildFieldPayload: async () => {
        builds += 1;
        if (fail) throw new Error('upstream');
        return okPayload(REGION);
      },
    },
  });
  await call(h, `/manifest${REGIONAL_QUERY}`);
  await call(h, '/manifest?latMin=30.2&latMax=38.9&lonMin=-74.8&lonMax=-66.1');
  assert.equal(builds, 1);
  clock += 2000;
  fail = true;
  const stale = await call(h, `/manifest${REGIONAL_QUERY}`);
  assert.equal(stale.json.stale, true);
  assert.equal(stale.json.unavailable, false);
  assert.equal(builds, 2);
  clock += 10; // inside the 60 s retry backoff: no new build
  await call(h, `/manifest${REGIONAL_QUERY}`);
  assert.equal(builds, 2);
  clock += 61_000;
  const gone = await call(h, `/manifest${REGIONAL_QUERY}`);
  assert.equal(gone.json.unavailable, true);
  assert.equal(gone.json.field, 'ocean-currents');
  assert.match(gone.json.reason, /unavailable/);
});

test('an unavailable payload is a cached answer, not an error', async () => {
  const h = handlerFor({
    deps: {
      buildFieldPayload: async () => ({
        status: 'unavailable',
        reason: 'no ocean-current tier could serve this view',
        grid: null,
        u: null,
        v: null,
      }),
    },
  });
  const { status, json } = await call(h, `/manifest${REGIONAL_QUERY}`);
  assert.equal(status, 200);
  assert.equal(json.unavailable, true);
  assert.match(json.reason, /no ocean-current tier/);
});

test('rate limiting answers 429 with Retry-After', async () => {
  const h = handlerFor({ rateLimiter: () => false, deps: { buildFieldPayload: async () => okPayload(REGION) } });
  const { status, headers } = await call(h, `/manifest${REGIONAL_QUERY}`);
  assert.equal(status, 429);
  assert.equal(headers['Retry-After'], '10');
});

test('antimeridian box is quantized and served as a regional tier', async () => {
  const boxes = [];
  const h = handlerFor({
    deps: {
      buildFieldPayload: async ({ box }) => {
        boxes.push(box);
        return okPayload({ lat0: 30, lon0: 170, dLat: 1, dLon: 1, nLat: 10, nLon: 21 });
      },
    },
  });
  const { json } = await call(h, '/manifest?latMin=30&latMax=39&lonMin=170&lonMax=-170');
  assert.equal(json.tier, 'regional');
  assert.deepEqual(boxes[0], { latMin: 30, latMax: 39, lonMin: 170, lonMax: -170 });
  assert.equal(json.grid.lo1, 170);
  assert.equal(json.grid.nx, 21);
});

test('a build slower than the provider timeout answers unavailable now and fills the cache when it finishes', async () => {
  let builds = 0;
  const h = handlerFor({
    timeoutMs: 30,
    deps: {
      buildFieldPayload: () =>
        new Promise((resolve) => {
          builds += 1;
          setTimeout(() => resolve(okPayload(REGION)), 120);
        }),
    },
  });
  const first = await call(h, `/manifest${REGIONAL_QUERY}`);
  assert.equal(first.json.unavailable, true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const second = await call(h, `/manifest${REGIONAL_QUERY}`);
  assert.equal(second.json.unavailable, false);
  assert.equal(second.json.tier, 'regional');
  assert.equal(builds, 1, 'the finished build was cached, not rebuilt');
});
