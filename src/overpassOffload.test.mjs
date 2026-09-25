import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { overpassProxy } from '../server/providers/overpass.js';
import { militaryInstallationsProxy } from '../server/providers/military-installations.js';
import { regionalBriefProxy } from '../server/providers/regional/briefing.js';
import {
  parseOverpassUpstreams,
  resolveOverpassUpstreams,
} from '../server/providers/overpass/constants.js';
import { fetchOverpassPayload } from '../server/providers/overpass/transport.js';
import { _overpassCache } from '../server/providers/overpass/cache.js';
import { _militaryInstallationCache } from '../server/providers/military-installations/cache.js';
import {
  militaryInstallationCacheKey,
  quantizeMilitaryInstallationBox,
} from '../server/providers/military-installations/query.js';
import { createApplicationRequestServices } from './services/requests.js';
import { createInstallationSource } from './layers/installations/source.js';
import {
  resolveOutlineWithRetry,
  createAnnotationEngine,
} from './annotations/annotationEngine.js';
import { buildOverpassQuery } from './layers/alpr/records.js';

function env(t, value) {
  const prior = process.env.OVERPASS_UPSTREAMS;
  if (value === undefined) delete process.env.OVERPASS_UPSTREAMS;
  else process.env.OVERPASS_UPSTREAMS = value;
  t.after(() => {
    if (prior === undefined) delete process.env.OVERPASS_UPSTREAMS;
    else process.env.OVERPASS_UPSTREAMS = prior;
  });
}
function routes(...plugins) {
  const found = new Map();
  for (const plugin of plugins)
    plugin.configureServer({
      middlewares: { use: (path, handler) => found.set(path, handler) },
    });
  return found;
}
async function call(handlers, url, init = {}) {
  const parsed = new URL(url, 'http://localhost');
  const req = Readable.from(init.body ? [Buffer.from(init.body)] : []);
  Object.assign(req, {
    method: init.method || 'GET',
    url: parsed.search || '/',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  });
  let status, headers, body;
  await handlers.get(parsed.pathname)(req, {
    writeHead(s, h) {
      status = s;
      headers = h;
    },
    end(b) {
      body = b;
    },
  });
  return new Response(body, { status, headers });
}

test('lazy configuration validates HTTP(S), allows private hosts, replaces defaults and never exposes bad values', (t) => {
  env(t);
  assert.deepEqual(resolveOverpassUpstreams(), []);
  process.env.OVERPASS_UPSTREAMS =
    'http://localhost:1234/api, https://paid.example/query?key=secret, http://localhost:1234/api';
  assert.deepEqual(resolveOverpassUpstreams(), [
    'http://localhost:1234/api',
    'https://paid.example/query?key=secret',
  ]);
  assert.deepEqual(
    parseOverpassUpstreams(
      'ftp://bad, nonsense, javascript:bad, http://10.0.0.1/query',
    ),
    ['http://10.0.0.1/query'],
  );
});

test('the shared transport refuses an unset chain without calling fetch', async (t) => {
  env(t);
  const payload = await fetchOverpassPayload('data=x', 1024, {
    fetchImpl: () => assert.fail('default transport performed I/O'),
  });
  assert.equal(payload.status, 503);
  assert.deepEqual(JSON.parse(payload.body), {
    error: 'Detailed OpenStreetMap queries are not configured',
    code: 'OVERPASS_NOT_CONFIGURED',
    retryable: false,
  });
});

test('zero egress: every Overpass consumer reaches real default handlers, and regional context never calls Nominatim', async (t) => {
  env(t);
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    seen.push(String(url));
    throw new Error('Network unavailable');
  });
  const handlers = routes(
    overpassProxy(),
    militaryInstallationsProxy(),
    regionalBriefProxy(),
  );
  const queries = [
    '[out:json];way["highway"="primary"](30.2,-97.8,30.3,-97.7);out geom;',
    buildOverpassQuery(30.2, -97.8, 30.3, -97.7),
  ];
  for (const q of queries) {
    const response = await call(handlers, '/api/overpass', {
      method: 'POST',
      body: `data=${encodeURIComponent(q)}`,
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'OVERPASS_NOT_CONFIGURED');
  }
  // A fresh source for each operation proves every query crosses the server guard.
  const operations = [
    'getAdministrativeAreas',
    'getAreaGeometry',
    'getNeighborhoodAreas',
    'getStreetAreas',
    'getStreetLines',
    'getFootprints',
    'getEnclosingAreas',
    'getMonuments',
    'getFocusFootprints',
  ];
  for (const operation of operations) {
    const services = createApplicationRequestServices({
      fetchImpl: (url, options) => call(handlers, url, options),
    });
    const result = await services.features[operation](
      operation === 'getAreaGeometry'
        ? 3600012345
        : { lat: 30.2672, lon: -97.7431 },
    );
    assert.equal(result.code, 'OVERPASS_NOT_CONFIGURED', operation);
    assert.equal(result.retryable, false, operation);
  }
  const installations = await call(
    handlers,
    '/api/military-installations?south=30.2&west=-97.8&north=30.3&east=-97.7',
  );
  assert.equal(installations.status, 200);
  assert.equal((await installations.json()).code, 'OVERPASS_NOT_CONFIGURED');
  const regional = await call(
    handlers,
    '/api/regional-brief?latitude=30.2672&longitude=-97.7431',
  );
  assert.equal(regional.status, 200);
  assert.equal((await regional.json()).place.source, 'Natural Earth');
  assert.ok(
    seen.every((url) => !/overpass|nominatim/i.test(new URL(url).hostname)),
    JSON.stringify(seen),
  );
});

test('default handlers serve expired caches with original dates and no upstream header or refresh', async (t) => {
  env(t);
  t.mock.method(globalThis, 'fetch', () =>
    assert.fail('cached default made network request'),
  );
  const handlers = routes(overpassProxy(), militaryInstallationsProxy());
  const q = `[out:json];node(around:10,30,-97)["name"="${randomUUID()}"];out;`;
  const body = `data=${encodeURIComponent(q)}`;
  const cachedAt = Date.now() - 60 * 86400000;
  _overpassCache.set(body, {
    status: 200,
    body: '{"elements":[]}',
    cachedAt,
    endpoint: 'https://secret.example/private?token=secret',
  });
  t.after(() => _overpassCache.delete(body));
  const response = await call(handlers, '/api/overpass', {
    method: 'POST',
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-overpass-cache'), 'STALE');
  assert.equal(
    response.headers.get('x-overpass-cached-at'),
    new Date(cachedAt).toISOString(),
  );
  assert.equal(response.headers.get('x-overpass-upstream'), null);
  assert.doesNotMatch(JSON.stringify([...response.headers]), /secret/);
  const box = { south: 31.2, west: -97.8, north: 31.3, east: -97.7 };
  const key = militaryInstallationCacheKey(
    quantizeMilitaryInstallationBox(box),
  );
  _militaryInstallationCache.set(key, {
    cachedAt,
    payload: { elements: [], retrievedAt: new Date(cachedAt).toISOString() },
  });
  t.after(() => _militaryInstallationCache.delete(key));
  const sites = await (
    await call(
      handlers,
      '/api/military-installations?' + new URLSearchParams(box),
    )
  ).json();
  assert.equal(sites.status, 'stale');
  assert.equal(sites.retrievedAt, new Date(cachedAt).toISOString());
});

test('configured refusal response has a safe JSON body, Retry-After and no URL header', async (t) => {
  env(t, 'https://configured-redact.example/private?token=secret');
  t.mock.method(
    globalThis,
    'fetch',
    async (url) =>
      new Response(url, { status: 406, headers: { 'Retry-After': '45' } }),
  );
  const handler = routes(overpassProxy());
  const response = await call(handler, '/api/overpass', {
    method: 'POST',
    body:
      'data=' +
      encodeURIComponent(
        `[out:json];node(around:10,33,-97)["name"="${randomUUID()}"];out;`,
      ),
  });
  assert.equal(response.status, 406);
  assert.equal(response.headers.get('retry-after'), '45');
  assert.equal(response.headers.get('x-overpass-upstream'), null);
  assert.doesNotMatch(await response.text(), /secret|https:/);
});

test('feature capability misses stop source calls and deferred outline retry waits', async () => {
  let requests = 0,
    waits = 0;
  const services = createApplicationRequestServices({
    fetchImpl: async () => {
      requests++;
      return Response.json(
        { code: 'OVERPASS_NOT_CONFIGURED', retryable: false },
        { status: 503 },
      );
    },
  });
  const point = { lat: 30, lon: -97 };
  const result = await resolveOutlineWithRetry(
    () => services.features.getFootprints(point),
    {
      waitFn: async () => {
        waits++;
      },
    },
  );
  assert.equal(result.unavailable, true);
  assert.equal(
    (await services.features.getEnclosingAreas(point)).unavailable,
    true,
  );
  assert.equal(
    (await services.features.getFocusFootprints(point)).unavailable,
    true,
  );
  assert.equal(requests, 1);
  assert.equal(waits, 0);
});

test('installation capability miss switches to tiles once, including later viewport loads', async () => {
  let queries = 0,
    tiles = 0;
  const source = createInstallationSource({
    fetchImpl: async () => {
      queries++;
      return Response.json(
        { code: 'OVERPASS_NOT_CONFIGURED', retryable: false },
        { status: 503 },
      );
    },
    mapTiles: {
      async fetchBounds() {
        tiles++;
        return {
          tiles: [
            {
              military: [{ id: 'area', sources: [{ name: 'OpenStreetMap' }] }],
            },
          ],
          partial: false,
        };
      },
      clear() {},
    },
  });
  const box = { south: 30.2, north: 30.3, west: -97.8, east: -97.7 };
  const first = await source.getMappedSites(box);
  await source.getMappedSites(box);
  assert.equal(queries, 1);
  assert.equal(tiles, 2);
  assert.ok(first.records[0].retrievedAt);
  assert.equal(first.tileSource, true);
});

test('annotation capability miss keeps its pin and exposes the unavailable label without a synthetic ring', async (t) => {
  const prior = globalThis.requestAnimationFrame;
  const priorCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const capability = {
    unavailable: true,
    code: 'OVERPASS_NOT_CONFIGURED',
    retryable: false,
  };
  let updated,
    event,
    attempts = 0;
  const engine = createAnnotationEngine({
    viewer: {},
    renderer: {
      add() {},
      update(mark) {
        updated = mark;
      },
      remove() {},
      sync() {},
      destroy() {},
    },
    resolveTarget: async () => ({
      lon: -97.74,
      lat: 30.27,
      height: 0,
      label: 'Local building',
      ring: null,
      resolveOutline: async () => {
        attempts++;
        return capability;
      },
    }),
  });
  t.after(() => engine.destroy());
  t.after(() => {
    globalThis.requestAnimationFrame = prior;
    globalThis.cancelAnimationFrame = priorCancel;
  });
  engine.onOutlineEvent((value) => {
    event = value;
  });
  await engine.annotate([
    { type: 'area', target: 'Local building', footprint: true },
  ]);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(engine.count(), 1);
  assert.equal(attempts, 1);
  assert.equal(updated.outlineUnavailable, true);
  assert.ok(!updated.ring && !updated.synthesized);
  assert.equal(engine.list()[0].outlineUnavailable, true);
  assert.equal(event.message, 'Detailed outline unavailable');
});

test('configured URL credentials stay server-side and never appear in returned metadata', async () => {
  const payload = await fetchOverpassPayload('data=x', 1024, {
    endpoints: [
      'https://operator:private%20key@paid-credentials.example/api?token=secret',
    ],
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://paid-credentials.example/api?token=secret');
      assert.equal(
        options.headers.Authorization,
        'Basic ' + Buffer.from('operator:private key').toString('base64'),
      );
      assert.equal(options.redirect, 'error');
      return Response.json({ elements: [] });
    },
  });
  assert.equal(payload.status, 200);
  assert.doesNotMatch(
    JSON.stringify(payload),
    /private|secret|operator|https:/,
  );
});
