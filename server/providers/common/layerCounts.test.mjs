import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { layerCountsEndpoint } from './layerCounts.js';
import { openSkyProxy, openSkyStateCount } from '../aircraft/opensky.js';
import { celestrakProxy, uniqueNoradCount } from '../space/celestrak.js';
import { createCctvCatalog } from '../cctv/catalog.js';
import {
  AISSTREAM_STALE_MS,
  aisStreamVesselCount,
  ingestAisStreamEnvelope,
} from '../vessels/ais-store.js';
import { firmsProxy } from '../firms.js';
import { aisLiveProxy } from '../vessels/ais-live.js';
import { localProviderPlugins } from '../local.js';

test('layer counts come only from configured cache readers, and empty or failing ones are left out', async () => {
  const handler = endpointHandler({
    satellites: () => ({ count: 1272.4, at: 100 }),
    cctv: () => null,
    flights: async () => ({ count: 0, at: 5 }),
    'local-firms': () => {
      throw new Error('disk gone');
    },
    'ais-live-vessels': async () => ({ count: 9, at: Number.NaN }),
  });
  assert.deepEqual(await countRows(handler), [
    { layerId: 'satellites', count: 1272, at: 100 },
    { layerId: 'ais-live-vessels', count: 9, at: null },
  ]);
});

/** The endpoint's middleware, as a dev or preview server installs it. */
function endpointHandler(readers, hook = 'configureServer') {
  let handler = null;
  layerCountsEndpoint(readers)[hook]({
    middlewares: {
      use(route, fn) {
        assert.equal(route, '/api/layer-counts');
        handler = fn;
      },
    },
  });
  return handler;
}

/** Run one request through the endpoint and collect what it answered. */
async function ask(
  handler,
  { method = 'GET', headers = {}, url = '/', next } = {},
) {
  const sent = { status: 200, headers: {}, body: '' };
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      sent.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers = {}) {
      sent.status = status;
      for (const [name, value] of Object.entries(headers))
        sent.headers[name.toLowerCase()] = value;
    },
    end(body = '') {
      if (sent.status === 200 && this.statusCode !== 200)
        sent.status = this.statusCode;
      sent.body = String(body);
    },
  };
  await handler(
    {
      method,
      url,
      headers: { host: '127.0.0.1:5173', ...headers },
      socket: {},
    },
    res,
    next,
  );
  return sent;
}

test('the mounted route leaves unknown subpaths to the API fallback', async (t) => {
  const read = t.mock.fn(() => ({ count: 12, at: 100 }));
  const next = t.mock.fn();
  const handler = endpointHandler({ satellites: read });
  await ask(handler, { url: '/unknown', next });
  assert.equal(next.mock.callCount(), 1);
  assert.equal(read.mock.callCount(), 0);
  assert.equal((await ask(handler, { url: '/?ignored=1' })).status, 200);
});

async function countRows(handler) {
  const response = await ask(handler);
  assert.equal(response.status, 200);
  return JSON.parse(response.body).counts;
}

test('the endpoint answers GET with the counts, uncached, on dev and preview servers', async () => {
  const readers = {
    satellites: () => ({ count: 12, at: 100 }),
    'ais-live-vessels': () => ({ count: 9, at: null }),
  };
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const sent = await ask(endpointHandler(readers, hook));
    assert.equal(sent.status, 200, hook);
    assert.equal(sent.headers['cache-control'], 'no-store');
    assert.match(sent.headers['content-type'], /application\/json/);
    const body = JSON.parse(sent.body);
    assert.ok(Number.isFinite(body.now));
    assert.deepEqual(body.counts, [
      { layerId: 'satellites', count: 12, at: 100 },
      { layerId: 'ais-live-vessels', count: 9, at: null },
    ]);
  }
});

test('the endpoint answers HEAD with no body, refuses other methods and cross-site requests', async () => {
  let reads = 0;
  const handler = endpointHandler({
    satellites: () => {
      reads++;
      return { count: 12, at: 100 };
    },
  });
  const head = await ask(handler, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['cache-control'], 'no-store');
  assert.equal(head.body, '');

  const post = await ask(handler, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');

  const crossSite = await ask(handler, {
    headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' },
  });
  assert.equal(crossSite.status, 403);
  assert.doesNotMatch(crossSite.body, /satellites/);
  assert.equal(reads, 0, 'HEAD and rejected requests skip cache readers');
});

test('count requests have a per-peer window and recover without reading caches while limited', async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  let reads = 0;
  const handler = endpointHandler({
    flights: () => ({ count: ++reads, at: now }),
  });
  for (let i = 0; i < 60; i++)
    assert.equal((await ask(handler, { method: 'HEAD' })).status, 200);
  const limited = await ask(handler);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal((await ask(handler, { method: 'HEAD' })).body, '');
  assert.equal(reads, 0);
  now += 60_000;
  assert.equal((await countRows(handler))[0].count, 1);
});

test('OpenSky: the cached snapshot counts unique aircraft with positions', () => {
  const states = [
    ['abc123', '', '', null, null, -97.7, 30.2],
    [' ABC123 ', '', '', null, null, -97.8, 30.2],
    ['def456', '', '', null, null, null, null],
    ['fed321', '', '', null, null, -97.7, 300],
    ['654cba', '', '', null, null, -97.6, 30.3],
  ];
  assert.equal(openSkyStateCount(JSON.stringify({ states })), 2);
  assert.equal(openSkyStateCount('{"time":1,"states":null}'), 0);
  assert.equal(openSkyStateCount('<html>'), 0);
});

test('OpenSky: the count endpoint reports when the aircraft were observed', async (t) => {
  const savedMode = process.env.OPENSKY_AUTH_MODE;
  process.env.OPENSKY_AUTH_MODE = 'anon';
  t.after(() => {
    if (savedMode === undefined) delete process.env.OPENSKY_AUTH_MODE;
    else process.env.OPENSKY_AUTH_MODE = savedMode;
  });
  let now = 1_800_000_000_000;
  const observedAt = now - 300_000;
  const alpha = ['abc123', '', '', null, null, -97.7, 30.2];
  const bravo = ['def456', '', '', null, null, -97.6, 30.3];
  const snapshots = [
    { time: observedAt / 1000, states: [alpha] },
    { states: [alpha, bravo] },
  ];
  t.mock.method(Date, 'now', () => now);
  const upstream = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url, /^https:\/\/opensky-network\.org\/api\/states\/all\?/);
    return Response.json(snapshots.shift(), {
      headers: { 'x-rate-limit-remaining': '3000' },
    });
  });
  let flights;
  const plugin = openSkyProxy();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        assert.equal(route, '/api/flights');
        flights = handler;
      },
    },
  });
  const counts = endpointHandler({ flights: plugin.api.readLayerCount });
  assert.equal((await ask(flights)).status, 200);
  assert.deepEqual(await countRows(counts), [
    { layerId: 'flights', count: 1, at: observedAt },
  ]);

  now += 60_000;
  assert.equal((await ask(flights)).status, 200);
  assert.deepEqual(await countRows(counts), [
    { layerId: 'flights', count: 2, at: null },
  ]);
  assert.equal(upstream.mock.callCount(), 2);
});

const tle = (norad) =>
  `SAT ${norad}\n1 ${norad}U 98067A   26001.00000000  .00000000  00000-0  00000-0 0  9990\n2 ${norad}  51.6400 000.0000 0000000   0.0000   0.0000 15.50000000    00\n`;

test('each local composition reads counts from its own CelesTrak cache', async (t) => {
  const now = 1_800_000_000_000;
  const expected = { layerId: 'satellites', count: 2, at: now };
  t.mock.method(Date, 'now', () => now);
  t.mock.method(fsp, 'readFile', async () => {
    throw new Error('fixture cache missing');
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  const upstream = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(tle('25544') + tle('20580')),
  );

  function compose() {
    const routes = new Map();
    const server = {
      middlewares: { use: (route, handler) => routes.set(route, handler) },
    };
    for (const plugin of localProviderPlugins()) {
      if (plugin.name === 'celestrak-proxy' || plugin.name === 'layer-counts')
        plugin.configureServer(server);
    }
    return routes;
  }

  async function satelliteCount(routes) {
    const rows = await countRows(routes.get('/api/layer-counts'));
    return rows.find(({ layerId }) => layerId === 'satellites');
  }

  const first = compose();
  const warmed = await ask(first.get('/api/celestrak'), { url: '/stations' });
  assert.equal(warmed.status, 200);
  assert.deepEqual(await satelliteCount(first), expected);

  const second = compose();
  assert.equal(await satelliteCount(second), undefined);
  assert.deepEqual(await satelliteCount(first), expected);
  assert.equal(upstream.mock.callCount(), 1);
});

test('CelesTrak: matching TLE pairs count once across cached groups', () => {
  assert.equal(
    uniqueNoradCount([
      tle('25544') + tle('A0000') + tle('   42'),
      tle('25544') + tle('00042') + 'ORPHAN\n1 12345U trailing\n',
    ]),
    3,
  );
  assert.equal(uniqueNoradCount([tle('A0000'), tle('   42')]), 2);
  assert.equal(uniqueNoradCount(['ORPHAN\n1 12345U trailing\n', '', null]), 0);
});

test('CelesTrak: a count reading disk keeps a concurrent feed refresh', async (t) => {
  const now = 1_800_000_000_000;
  const stale = JSON.stringify({
    at: now - 7 * 3600_000,
    body: tle('25544'),
  });
  const fresh = tle('25544') + tle('20580');
  const firstRead = Promise.withResolvers();
  const readingCount = Promise.withResolvers();
  let firstIndexRead = true;
  t.mock.method(fsp, 'readdir', async () => ['celestrak-count-stations.json']);
  t.mock.method(Date, 'now', () => now);
  t.mock.method(fsp, 'readFile', async (filename) => {
    if (path.basename(filename) === 'celestrak-count-stations.json') {
      if (firstIndexRead) {
        firstIndexRead = false;
        readingCount.resolve();
        return firstRead.promise;
      }
      return JSON.stringify({ at: now - 7 * 3600_000, ids: [25544] });
    }
    if (path.basename(filename) === 'celestrak-stations.json') return stale;
    throw new Error('fixture cache missing');
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  const upstream = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(fresh),
  );
  const routes = new Map();
  const plugin = celestrakProxy();
  plugin.configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  const feed = () => ask(routes.get('/api/celestrak'), { url: '/stations' });

  const counts = endpointHandler({ satellites: plugin.api.readLayerCount });
  const pendingCount = countRows(counts);
  await readingCount.promise;
  const refresh = await feed();
  firstRead.resolve(JSON.stringify({ at: now - 7 * 3600_000, ids: [25544] }));
  const count = await pendingCount;
  const nextFeed = await feed();

  assert.equal(refresh.body, fresh);
  assert.deepEqual(count, [{ layerId: 'satellites', count: 2, at: now }]);
  assert.equal(nextFeed.body, fresh);
  assert.equal(nextFeed.headers['x-tle-cache'], 'HIT');
  assert.equal(upstream.mock.callCount(), 1);
});

test('CelesTrak does not refresh twice when a delayed index restore overlaps a refresh', async (t) => {
  const now = 1_800_000_000_000;
  const staleAt = now - 7 * 3600_000;
  const fresh = tle('25544') + tle('20580');
  const readingIndex = Promise.withResolvers();
  const releaseIndex = Promise.withResolvers();
  t.after(() => releaseIndex.resolve());
  t.mock.method(Date, 'now', () => now);
  t.mock.method(fsp, 'readFile', async (filename) => {
    if (path.basename(filename) === 'celestrak-stations.json')
      return JSON.stringify({ at: staleAt, body: tle('25544') });
    readingIndex.resolve();
    await releaseIndex.promise;
    return JSON.stringify({ at: staleAt, ids: [25544] });
  });
  for (const method of ['mkdir', 'writeFile', 'rename'])
    t.mock.method(fsp, method, async () => {});
  const upstream = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(fresh),
  );
  const plugin = celestrakProxy();
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  const feed = () => ask(routes.get('/api/celestrak'), { url: '/stations' });
  const restoring = feed();
  await readingIndex.promise;
  assert.equal((await feed()).headers['x-tle-cache'], 'MISS');
  releaseIndex.resolve();
  const restored = await restoring;
  assert.equal(restored.body, fresh);
  assert.equal(restored.headers['x-tle-cache'], 'HIT');
  assert.equal(upstream.mock.callCount(), 1);
});

test('a normal feed read upgrades an older group cache and cold counts open only the compact index', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-tle-count-'));
  const previous = process.cwd();
  t.after(async () => {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  await mkdir('.gev-cache');
  const at = Date.now();
  const body = tle('25544') + tle('20580');
  await writeFile(
    '.gev-cache/celestrak-stations.json',
    JSON.stringify({ at, body }),
  );
  const plugin = celestrakProxy();
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  assert.equal(await plugin.api.readLayerCount(), null);
  assert.equal(
    (await ask(routes.get('/api/celestrak'), { url: '/stations' })).body,
    body,
  );
  await writeFile(
    '.gev-cache/celestrak-count-visual.json',
    JSON.stringify({ at: at - 10, ids: [25544, 42] }),
  );
  const read = t.mock.method(fsp, 'readFile');
  const cold = celestrakProxy();
  assert.deepEqual(await cold.api.readLayerCount(), { count: 3, at: at - 10 });
  assert.deepEqual(
    read.mock.calls.map(({ arguments: args }) => path.basename(args[0])).sort(),
    ['celestrak-count-stations.json', 'celestrak-count-visual.json'],
  );
});

test('satellite counts survive interrupted writes and a later feed read repairs a damaged index', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-tle-write-'));
  const previous = process.cwd();
  t.after(async () => {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  await mkdir('.gev-cache');
  const raw = path.resolve('.gev-cache/celestrak-stations.json');
  const index = path.resolve('.gev-cache/celestrak-count-stations.json');
  const at = Date.now();
  let now = at + 7 * 3600_000;
  t.mock.method(Date, 'now', () => now);
  const old = { at, body: tle('25544') };
  const fresh = tle('25544') + tle('20580');
  await writeFile(raw, JSON.stringify(old));
  await writeFile(index, JSON.stringify({ at, ids: [25544] }));
  t.mock.method(globalThis, 'fetch', async () => new Response(fresh));
  t.mock.method(console, 'warn', () => {});
  function start() {
    const plugin = celestrakProxy();
    const routes = new Map();
    plugin.configureServer({
      middlewares: { use: (route, handler) => routes.set(route, handler) },
    });
    return {
      feed: () => ask(routes.get('/api/celestrak'), { url: '/stations' }),
      count: plugin.api.readLayerCount,
    };
  }
  const readingIndex = Promise.withResolvers();
  const releaseIndex = Promise.withResolvers();
  t.after(() => releaseIndex.resolve());
  const readFile = fsp.readFile;
  let holdIndex = true;
  t.mock.method(fsp, 'readFile', async (file, ...args) => {
    if (file === index && holdIndex) {
      holdIndex = false;
      readingIndex.resolve();
      await releaseIndex.promise;
    }
    return readFile(file, ...args);
  });
  const rename = fsp.rename;
  let failed = raw;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (to === failed) throw new Error('interrupted cache write');
    return rename(from, to);
  });
  const overlapping = start();
  const restoring = overlapping.feed();
  await readingIndex.promise;
  try {
    assert.equal((await overlapping.feed()).body, fresh);
  } finally {
    releaseIndex.resolve();
  }
  assert.equal((await restoring).body, fresh);
  assert.deepEqual(JSON.parse(await fsp.readFile(raw)), old);
  assert.deepEqual(await start().count(), { at, count: 1 });
  failed = index;
  assert.equal((await start().feed()).body, fresh);
  assert.equal(JSON.parse(await fsp.readFile(raw)).body, fresh);
  assert.deepEqual(await start().count(), { at, count: 1 });
  failed = null;
  await start().feed();
  assert.deepEqual(await start().count(), { at: now, count: 2 });
  const repairing = start();
  assert.deepEqual(await repairing.count(), { at: now, count: 2 });
  await writeFile(index, '{');
  await repairing.feed();
  assert.deepEqual(await start().count(), { at: now, count: 2 });
  // An old raw cache restored after a newer index cannot roll back the count.
  await writeFile(raw, JSON.stringify({ at: now - 1000, body: old.body }));
  const restarted = start();
  assert.deepEqual(await restarted.count(), { at: now, count: 2 });
  assert.equal((await restarted.feed()).body, old.body);
  assert.deepEqual(await restarted.count(), { at: now, count: 2 });
  assert.deepEqual((await fsp.readdir('.gev-cache')).sort(), [
    path.basename(index),
    path.basename(raw),
  ]);
});

test('a delayed CelesTrak repair cannot replace an index persisted by a concurrent refresh', async (t) => {
  const releaseRepair = Promise.withResolvers();
  const repairStarted = Promise.withResolvers();
  const refreshStarted = Promise.withResolvers();
  t.after(() => releaseRepair.resolve());
  const raw = 'celestrak-stations.json';
  const index = 'celestrak-count-stations.json';
  const now = 1_800_000_000_000;
  const freshBody = tle('25544') + tle('20580');
  const files = new Map([
    [raw, JSON.stringify({ at: now - 7 * 3600_000, body: tle('25544') })],
  ]);
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => {
    refreshStarted.resolve();
    return new Response(freshBody);
  });
  t.mock.method(fsp, 'readFile', async (file) => {
    const name = path.basename(file);
    if (!files.has(name)) throw new Error('fixture cache missing');
    return files.get(name);
  });
  t.mock.method(fsp, 'readdir', async () => [...files.keys()]);
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async (file, data) => {
    files.set(path.basename(file), data);
  });
  t.mock.method(fsp, 'unlink', async (file) => {
    files.delete(path.basename(file));
  });
  let firstRename = true;
  t.mock.method(fsp, 'rename', async (from, to) => {
    const destination = path.basename(to);
    if (destination === index && firstRename) {
      firstRename = false;
      repairStarted.resolve();
      await releaseRepair.promise;
    }
    files.set(destination, files.get(path.basename(from)));
    files.delete(path.basename(from));
  });
  const plugin = celestrakProxy();
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  const feed = () => ask(routes.get('/api/celestrak'), { url: '/stations' });
  const warming = feed();
  await repairStarted.promise;
  const refreshing = feed();
  await refreshStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  releaseRepair.resolve();
  assert.equal((await refreshing).body, freshBody);
  assert.equal((await warming).body, freshBody);
  assert.deepEqual(await celestrakProxy().api.readLayerCount(), {
    at: now,
    count: 2,
  });
});

test('CCTV: no count before the catalog is built, never building it to count', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  process.env.CCTV_SOURCES_JSON = JSON.stringify([
    {
      id: 'a',
      name: 'A',
      lat: 30,
      lon: -97,
      url: 'https://example.test/a.jpg',
    },
    {
      id: 'b',
      name: 'B',
      lat: 31,
      lon: -97,
      url: 'https://example.test/b.jpg',
    },
  ]);
  const getSources = createCctvCatalog({ sourceRoot: '/nonexistent' });
  assert.equal(getSources.cachedCount(), null);
  assert.equal(getSources.cachedCount(), null, 'asking did not build it');
  await getSources();
  const counted = getSources.cachedCount();
  assert.equal(counted.count, 2);
  assert.ok(Number.isFinite(counted.at));
});

test('CCTV: an empty refresh keeps serving the old catalog under its own build time', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const warned = [];
  t.mock.method(console, 'warn', (...args) => warned.push(args.join(' ')));
  process.env.CCTV_SOURCES_JSON = JSON.stringify([
    {
      id: 'a',
      name: 'A',
      lat: 30,
      lon: -97,
      url: 'https://example.test/a.jpg',
    },
  ]);
  const getSources = createCctvCatalog({ sourceRoot: '/nonexistent' });
  await getSources();
  assert.deepEqual(getSources.cachedCount(), { count: 1, at: 1_000 });
  // Past the cache's lifetime every source comes back empty.
  // No live packs either, so nothing is fetched.
  process.env.CCTV_SOURCES_JSON = '[]';
  process.env.CCTV_PREFER_AUSTIN = '0';
  now = 1_000 + 16 * 60_000;
  await getSources();
  for (
    let turn = 0;
    turn < 200 && !warned.some((line) => /returned empty/.test(line));
    turn++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(
    warned.some((line) => /returned empty/.test(line)),
    'the refresh ran',
  );
  assert.deepEqual(
    getSources.cachedCount(),
    { count: 1, at: 1_000 },
    'still the old catalog, under its own time',
  );
});

test('AIS: fresh vessels count, aids to navigation and stale rows do not', (t) => {
  const report = (mmsi) => ({
    MessageType: 'PositionReport',
    Message: { PositionReport: { UserID: Number(mmsi), Sog: 5, Cog: 90 } },
    MetaData: {
      MMSI: mmsi,
      latitude: 53.4,
      longitude: 6.2,
      time_utc: '2026-09-17 20:00:00.000000000 +0000 UTC',
    },
  });
  const start = Date.now() + 365 * 86_400_000;
  let now = start;
  t.mock.method(Date, 'now', () => now);
  ingestAisStreamEnvelope(report('244060901'));
  ingestAisStreamEnvelope(report('244060902'));
  ingestAisStreamEnvelope(report('992446001'));
  assert.deepEqual(aisStreamVesselCount(), { count: 2, at: start });
  now = start + AISSTREAM_STALE_MS + 1;
  assert.equal(aisStreamVesselCount(), null, 'every row has gone stale');
});

test('AIS: a subscription narrower than the world gives no count', async (t) => {
  const saved = process.env.AISSTREAM_BOUNDING_BOXES;
  t.after(() => {
    if (saved === undefined) delete process.env.AISSTREAM_BOUNDING_BOXES;
    else process.env.AISSTREAM_BOUNDING_BOXES = saved;
  });
  const start = Date.now() + 2 * 365 * 86_400_000;
  t.mock.method(Date, 'now', () => start);
  ingestAisStreamEnvelope({
    MessageType: 'PositionReport',
    Message: { PositionReport: { UserID: 244060903, Sog: 5, Cog: 90 } },
    MetaData: {
      MMSI: '244060903',
      latitude: 53.4,
      longitude: 6.2,
      time_utc: '2026-09-17 20:00:00.000000000 +0000 UTC',
    },
  });
  const handler = endpointHandler({
    'ais-live-vessels': aisLiveProxy().api.readLayerCount,
  });
  delete process.env.AISSTREAM_BOUNDING_BOXES;
  assert.deepEqual(await countRows(handler), [
    { layerId: 'ais-live-vessels', count: 1, at: start },
  ]);
  process.env.AISSTREAM_BOUNDING_BOXES = '[[[-90,-180],[90,180]]]';
  assert.equal(
    (await countRows(handler)).length,
    1,
    'the default box, spelt out',
  );
  process.env.AISSTREAM_BOUNDING_BOXES = '[[[50,0],[55,10]]]';
  assert.deepEqual(await countRows(handler), [], 'one region, no count');
});

test('FIRMS: no count without a key, and with one the count saved beside the cache, never the cache itself', async (t) => {
  const savedKey = process.env.FIRMS_MAP_KEY;
  const savedCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-firms-count-'));
  t.after(async () => {
    process.chdir(savedCwd);
    if (savedKey === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = savedKey;
    await rm(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  await mkdir(path.join(dir, '.gev-cache'));
  // A cache this read must not parse: it is not even JSON.
  await writeFile(path.join(dir, '.gev-cache', 'firms.json'), 'not json');
  const summaryFile = path.join(dir, '.gev-cache', 'firms-count.json');
  const at = Date.UTC(2026, 0, 2, 12);
  let now = at;
  t.mock.method(Date, 'now', () => now);
  await writeFile(summaryFile, JSON.stringify({ at, count: 4321 }));
  const handler = endpointHandler({
    'local-firms': firmsProxy().api.readLayerCount,
  });
  delete process.env.FIRMS_MAP_KEY;
  assert.deepEqual(await countRows(handler), [], 'no key, no count');
  process.env.FIRMS_MAP_KEY = 'fixture';
  assert.deepEqual(
    await countRows(handler),
    [],
    'a legacy total cannot establish a current window',
  );
  await writeFile(
    summaryFile,
    JSON.stringify({
      at,
      minutes: [
        { acqDate: '2026-01-01', acqTime: '1200', count: 3 },
        { acqDate: '2026-01-02', acqTime: '1159', count: 2 },
      ],
    }),
  );
  assert.deepEqual(await countRows(handler), [
    { layerId: 'local-firms', count: 5, at },
  ]);
  now++;
  assert.deepEqual(await countRows(handler), [
    { layerId: 'local-firms', count: 2, at },
  ]);
  await rm(path.join(dir, '.gev-cache', 'firms-count.json'));
  assert.deepEqual(await countRows(handler), [], 'no saved count, no count');

  // Refresh through the feed to exercise the writer, then read the same minute boundary
  // from the feed, its warm count reader, and a newly started count reader.
  now = at;
  const csv =
    'latitude,longitude,acq_date,acq_time,confidence,frp\n1,2,2026-01-01,1200,n,4\n1,2,2026-01-02,1159,n,4';
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(csv),
  );
  const plugin = firmsProxy();
  let route;
  plugin.configureServer({
    middlewares: {
      use: (_, handler) => {
        route = handler;
      },
    },
  });
  assert.equal(JSON.parse((await ask(route)).body).count, 6);
  now++;
  const served = JSON.parse((await ask(route)).body).count;
  assert.equal(served, 3);
  for (const reader of [plugin, firmsProxy()]) {
    assert.deepEqual(await reader.api.readLayerCount(), { count: served, at });
  }
  assert.equal(fetch.mock.callCount(), 3);
});

test('FIRMS keeps the fresh count when a delayed disk read overlaps persistence', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-firms-write-'));
  const previous = process.cwd();
  const key = process.env.FIRMS_MAP_KEY;
  const restoring = Promise.withResolvers();
  const releaseRestore = Promise.withResolvers();
  const writing = Promise.withResolvers();
  const releaseWrite = Promise.withResolvers();
  t.after(async () => {
    releaseRestore.resolve();
    releaseWrite.resolve();
    process.chdir(previous);
    if (key === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = key;
    await rm(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  process.env.FIRMS_MAP_KEY = 'fixture';
  await mkdir('.gev-cache');
  const now = Date.UTC(2026, 0, 2, 12);
  t.mock.method(Date, 'now', () => now);
  const readFile = fsp.readFile;
  t.mock.method(fsp, 'readFile', async (file, ...args) => {
    if (path.basename(file) !== 'firms.json') return readFile(file, ...args);
    restoring.resolve();
    await releaseRestore.promise;
    return JSON.stringify({
      at: now - 1000,
      sources: [],
      fires: [{ acqDate: '2026-01-02', acqTime: '1100' }],
    });
  });
  const makeDir = fsp.mkdir;
  t.mock.method(fsp, 'mkdir', async (...args) => {
    writing.resolve();
    await releaseWrite.promise;
    return makeDir(...args);
  });
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        'latitude,longitude,acq_date,acq_time,confidence,frp\n1,2,2026-01-02,1159,n,4',
      ),
  );
  const plugin = firmsProxy();
  let route;
  plugin.configureServer({
    middlewares: {
      use: (_, handler) => {
        route = handler;
      },
    },
  });
  const old = ask(route);
  await restoring.promise;
  const fresh = ask(route);
  await writing.promise;
  releaseRestore.resolve();
  const overlapping = JSON.parse((await old).body);
  releaseWrite.resolve();
  const current = JSON.parse((await fresh).body);
  assert.equal(overlapping.count, current.count);
  assert.deepEqual(await firmsProxy().api.readLayerCount(), {
    count: current.count,
    at: now,
  });
});

test('FIRMS warms a durable count from the raw cache and preserves current summaries', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-firms-repair-'));
  const previous = process.cwd();
  const key = process.env.FIRMS_MAP_KEY;
  t.after(async () => {
    process.chdir(previous);
    if (key === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = key;
    await rm(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  process.env.FIRMS_MAP_KEY = 'fixture';
  await mkdir('.gev-cache');
  const at = Date.UTC(2026, 0, 2, 12);
  const fire = { acqDate: '2026-01-02', acqTime: '1159' };
  const raw = JSON.stringify({ at, sources: [], fires: [fire, fire] });
  const rawPath = '.gev-cache/firms.json';
  const countPath = '.gev-cache/firms-count.json';
  await writeFile(rawPath, raw);
  t.mock.method(Date, 'now', () => at + 2000);
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('warm repair should not fetch');
  });
  const rename = t.mock.method(fsp, 'rename');
  const summary = (time, count) =>
    JSON.stringify({ at: time, minutes: [{ ...fire, count }] });

  for (const [label, disk, before, after, writes] of [
    ['missing', null, null, { at, count: 2 }, 1],
    ['broken JSON', '{', null, { at, count: 2 }, 1],
    ['invalid bucket', summary(at + 1000, '3'), null, { at, count: 2 }, 1],
    [
      'legacy total',
      JSON.stringify({ at, count: 2 }),
      null,
      { at, count: 2 },
      1,
    ],
    [
      'older',
      summary(at - 1000, 1),
      { at: at - 1000, count: 1 },
      { at, count: 2 },
      1,
    ],
    ['equal', summary(at, 2), { at, count: 2 }, { at, count: 2 }, 0],
    [
      'newer',
      summary(at + 1000, 3),
      { at: at + 1000, count: 3 },
      { at: at + 1000, count: 3 },
      0,
    ],
  ]) {
    if (disk !== null) await writeFile(countPath, disk);
    const plugin = firmsProxy();
    assert.deepEqual(await plugin.api.readLayerCount(), before, label);
    let route;
    plugin.configureServer({
      middlewares: {
        use: (_, handler) => {
          route = handler;
        },
      },
    });
    const previousWrites = rename.mock.callCount();
    const response = JSON.parse((await ask(route)).body);
    assert.equal(response.fetchedAt, at, label);
    assert.equal(response.count, 2, label);
    assert.deepEqual(
      await plugin.api.readLayerCount(),
      { at, count: 2 },
      label,
    );
    assert.deepEqual(await firmsProxy().api.readLayerCount(), after, label);
    assert.equal(rename.mock.callCount() - previousWrites, writes, label);
  }
  assert.equal(await fsp.readFile(rawPath, 'utf8'), raw);
  assert.equal(fetch.mock.callCount(), 0);
});

test('FIRMS keeps the last durable count when a raw cache replacement fails', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-firms-failed-write-'));
  const previous = process.cwd();
  const key = process.env.FIRMS_MAP_KEY;
  t.after(async () => {
    process.chdir(previous);
    if (key === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = key;
    await rm(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  process.env.FIRMS_MAP_KEY = 'fixture';
  await mkdir('.gev-cache');
  const now = Date.UTC(2026, 0, 2, 12);
  const at = now - 60 * 60_000;
  const fire = { acqDate: '2026-01-02', acqTime: '1059' };
  const rawPath = '.gev-cache/firms.json';
  const raw = JSON.stringify({ at, sources: [], fires: [fire, fire] });
  await writeFile(rawPath, raw);
  await writeFile(
    '.gev-cache/firms-count.json',
    JSON.stringify({ at, minutes: [{ ...fire, count: 2 }] }),
  );
  t.mock.method(Date, 'now', () => now);
  const saveFile = fsp.writeFile;
  t.mock.method(fsp, 'writeFile', async (filename, ...args) => {
    if (path.basename(filename).startsWith('firms.json'))
      throw new Error('raw cache write failed');
    return saveFile(filename, ...args);
  });
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        'latitude,longitude,acq_date,acq_time,confidence,frp\n1,2,2026-01-02,1159,n,4',
      ),
  );
  const plugin = firmsProxy();
  let route;
  plugin.configureServer({
    middlewares: {
      use: (_, handler) => {
        route = handler;
      },
    },
  });
  const fresh = JSON.parse((await ask(route)).body);
  assert.equal(fresh.fetchedAt, now);
  assert.equal(fresh.count, 3);
  assert.equal(await fsp.readFile(rawPath, 'utf8'), raw);
  assert.deepEqual(await firmsProxy().api.readLayerCount(), { at, count: 2 });
});

test('FIRMS serializes a delayed repair rename with a newer count write', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-firms-rename-'));
  const previous = process.cwd();
  const key = process.env.FIRMS_MAP_KEY;
  const renamingRepair = Promise.withResolvers();
  const releaseRepair = Promise.withResolvers();
  const writingRefresh = Promise.withResolvers();
  t.after(async () => {
    releaseRepair.resolve();
    process.chdir(previous);
    if (key === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = key;
    await rm(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  process.env.FIRMS_MAP_KEY = 'fixture';
  await mkdir('.gev-cache');
  let now = Date.UTC(2026, 0, 2, 12);
  t.mock.method(Date, 'now', () => now);
  await writeFile(
    '.gev-cache/firms.json',
    JSON.stringify({
      at: now,
      sources: [],
      fires: [{ acqDate: '2026-01-02', acqTime: '1159' }],
    }),
  );
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        'latitude,longitude,acq_date,acq_time,confidence,frp\n1,2,2026-01-02,1159,n,4',
      ),
  );
  const rename = fsp.rename;
  let replacements = 0;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (path.basename(to) === 'firms-count.json' && ++replacements === 1) {
      renamingRepair.resolve();
      await releaseRepair.promise;
    }
    await rename(from, to);
    if (path.basename(to) === 'firms.json') writingRefresh.resolve();
  });
  let route;
  firmsProxy().configureServer({
    middlewares: {
      use: (_, handler) => {
        route = handler;
      },
    },
  });
  const repair = ask(route);
  await renamingRepair.promise;
  now += 30 * 60_000;
  const refresh = ask(route);
  await writingRefresh.promise;
  await new Promise(setImmediate);
  const overlappingReplacements = replacements;
  releaseRepair.resolve();
  await repair;
  const current = JSON.parse((await refresh).body);
  assert.equal(overlappingReplacements, 1);
  assert.equal(current.count, 3);
  assert.deepEqual(await firmsProxy().api.readLayerCount(), {
    count: 3,
    at: now,
  });
  assert.deepEqual((await fsp.readdir('.gev-cache')).sort(), [
    'firms-count.json',
    'firms.json',
  ]);
});
