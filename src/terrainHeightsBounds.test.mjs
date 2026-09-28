// TERRAIN HEIGHTS — the bounds on a cache keyed by caller-chosen coordinates.
//
// Every distinct 5dp lon/lat is its own cache key, its own permanent line in
// `.gev-cache/terrain-heights.json`, and its own upstream call. Four things
// bound that: WGS-84 range at parse, an entry ceiling on the map, a size
// ceiling on the file that is read back, and a per-client request limiter.
//
// These cases drive the real exported route handler. `fetch` is stubbed per
// test and restored after, so a case that reaches upstream fails loudly.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseTerrainPoints } from './data/terrainHeightsProxy.js';
import { terrainHeightsProxy } from '../server/providers/terrain.js';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(path, handler) {
        routes.set(path, handler);
      },
    },
  });
  return routes;
}

function request(handler, { url = '/', remoteAddress = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = new Map();
    const req = { method: 'GET', url, headers: {}, socket: { remoteAddress } };
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader(name, value) {
        headers.set(String(name).toLowerCase(), String(value));
      },
      writeHead(status, hdrs = {}) {
        this.statusCode = status;
        this.headersSent = true;
        for (const [name, value] of Object.entries(hdrs))
          headers.set(String(name).toLowerCase(), String(value));
      },
      end(body = '') {
        let parsed = null;
        try {
          parsed = body ? JSON.parse(String(body)) : null;
        } catch {
          parsed = String(body);
        }
        resolve({
          statusCode: this.statusCode,
          headers: Object.fromEntries(headers),
          body: parsed,
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function stubFetch(t, impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => {
    globalThis.fetch = original;
  });
}

/**
 * Answer like Re:Earth does: one `{ellipsoid}` per requested point, in order.
 * Records which point strings were actually asked for, so a test can assert on
 * cache misses rather than on internal state.
 */
function stubTerrainUpstream(t) {
  const asked = [];
  stubFetch(t, async (url) => {
    const points = decodeURIComponent(
      new URL(String(url)).searchParams.get('points') || '',
    )
      .split(';')
      .filter(Boolean);
    asked.push(...points);
    return Response.json({ results: points.map(() => ({ ellipsoid: 150 })) });
  });
  return asked;
}

test('a coordinate off the globe is not a cache key', () => {
  // Finite but not on Earth — the old guard accepted every one of these.
  for (const raw of [
    '0,91',
    '0,-91',
    '181,0',
    '-181,0',
    '1e9,1e9',
    '0,90.00001',
  ])
    assert.equal(parseTerrainPoints(raw), null, raw);

  // The poles and the antimeridian are real places and must still parse.
  for (const raw of ['0,90', '0,-90', '180,0', '-180,0', '-97.74,30.26'])
    assert.ok(parseTerrainPoints(raw), raw);
});

test('an out-of-range point is refused before it reaches upstream or the cache', async (t) => {
  let upstreamCalls = 0;
  stubFetch(t, async () => {
    upstreamCalls += 1;
    return new Response('[]', { status: 200 });
  });
  const route = install(terrainHeightsProxy()).get('/api/terrain/heights');

  const refused = await request(route, { url: '/?points=0,91' });
  assert.equal(refused.statusCode, 400);
  assert.equal(
    upstreamCalls,
    0,
    'an impossible coordinate must not cost an upstream call',
  );
});

test('one out-of-range point rejects the batch it is hidden in', async (t) => {
  stubFetch(t, async () => new Response('[]', { status: 200 }));
  const route = install(terrainHeightsProxy()).get('/api/terrain/heights');
  const mixed = await request(route, {
    url: '/?points=-97.74,30.26;0,999;-97.75,30.27',
  });
  assert.equal(mixed.statusCode, 400);
});

test('the point cache stops growing, and an evicted point is simply refetched', async (t) => {
  const asked = stubTerrainUpstream(t);
  // A ceiling of 3 exercises the same code path 50,000 does, in four requests.
  const route = install(terrainHeightsProxy({ cacheMaxEntries: 3 })).get(
    '/api/terrain/heights',
  );

  const point = (i) => `-97.7${i}000,30.26000`;
  for (let i = 1; i <= 4; i += 1)
    await request(route, { url: `/?points=${point(i)}` });
  assert.equal(asked.length, 4, 'four distinct points, four upstream lookups');

  // The newest point is still cached...
  await request(route, { url: `/?points=${point(4)}` });
  assert.equal(asked.length, 4, 'a cached point costs nothing');

  // ...and the oldest was evicted, so it costs one refetch — never a wrong
  // answer, because terrain does not move.
  await request(route, { url: `/?points=${point(1)}` });
  assert.equal(asked.length, 5, 'the evicted point was asked for again');
  assert.equal(asked[4], point(1));
});

test('an over-large cache file is not read back into memory', async (t) => {
  const asked = stubTerrainUpstream(t);
  const point = '-97.74000,30.26000';
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-terrain-'));
  const cachePath = path.join(dir, 'terrain-heights.json');
  t.after(() => rm(dir, { recursive: true, force: true }));

  // A cache file holding the answer, but larger than the ceiling allows.
  const padded = {
    version: 2,
    points: { [point]: { at: Date.now(), result: { ellipsoid: 150 } } },
    _pad: 'x'.repeat(4096),
  };
  await writeFile(cachePath, JSON.stringify(padded), 'utf8');

  const route = install(
    terrainHeightsProxy({ cachePath, cacheMaxDiskBytes: 1024 }),
  ).get('/api/terrain/heights');
  await request(route, { url: `/?points=${point}` });
  assert.deepEqual(
    asked,
    [point],
    'the oversized file was skipped, so the point was a miss',
  );

  // The same file under a ceiling that admits it IS used, which is what proves
  // the previous assertion came from the size guard and not a broken path.
  const admitted = install(
    terrainHeightsProxy({ cachePath, cacheMaxDiskBytes: 1024 * 1024 }),
  ).get('/api/terrain/heights');
  await request(admitted, { url: `/?points=${point}` });
  assert.deepEqual(asked, [point], 'a cache within the ceiling is still read');
});

test('the route refuses a flood of requests from one client', async (t) => {
  stubTerrainUpstream(t);
  const route = install(terrainHeightsProxy()).get('/api/terrain/heights');

  let refusedAt = 0;
  for (let i = 1; i <= 95; i += 1) {
    // A different point each time: distinct keys are the growth path.
    const lon = (-97.7 - i / 1000).toFixed(5);
    const answer = await request(route, { url: `/?points=${lon},30.26` });
    if (answer.statusCode === 429) {
      refusedAt = i;
      break;
    }
  }
  assert.equal(refusedAt, 91, 'the 91st request in a minute is refused');
});

test('a second client keeps its own quota', async (t) => {
  stubFetch(t, async () =>
    Response.json([{ lng: -97.74, lat: 30.26, height: 150 }]),
  );
  const route = install(terrainHeightsProxy()).get('/api/terrain/heights');

  for (let i = 0; i < 90; i += 1)
    await request(route, {
      url: `/?points=${(-98 - i / 1000).toFixed(5)},30.26`,
      remoteAddress: '198.51.100.7',
    });
  const exhausted = await request(route, {
    url: '/?points=-99.5,30.26',
    remoteAddress: '198.51.100.7',
  });
  assert.equal(exhausted.statusCode, 429);

  const neighbour = await request(route, {
    url: '/?points=-99.6,30.26',
    remoteAddress: '198.51.100.8',
  });
  assert.notEqual(neighbour.statusCode, 429);
});
