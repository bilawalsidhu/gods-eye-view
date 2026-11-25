import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { layerCountsEndpoint } from './layerCounts.js';
import { openSkyProxy, openSkyStateCount } from '../aircraft/opensky.js';
import { celestrakProxy } from '../space/celestrak.js';
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
    satellites: () => ({ count: 1272, at: 100 }),
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
      sent.body = method === 'HEAD' ? '' : String(body);
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
  const limitedHead = await ask(handler, { method: 'HEAD' });
  assert.equal(limitedHead.status, 429);
  assert.equal(limitedHead.headers['retry-after'], '60');
  assert.equal(limitedHead.body, '');
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

test('each local composition reads counts from its own CelesTrak cache and deduplicates paired records', async (t) => {
  const now = 1_800_000_000_000;
  const stationsCount = { layerId: 'satellites', count: 3, at: now };
  const combinedCount = { ...stationsCount, count: 4 };
  t.mock.method(Date, 'now', () => now);
  t.mock.method(fsp, 'readFile', async () => {
    throw new Error('fixture cache missing');
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  t.mock.method(fsp, 'rename', async () => {});
  const upstream = t.mock.method(globalThis, 'fetch', async (url) => {
    const group = new URL(url).searchParams.get('GROUP');
    const orphan = 'ORPHAN\n1 12345U trailing\n';
    const body =
      group === 'stations'
        ? tle('25544') + tle('A0000') + tle('   42')
        : tle('25544') + tle('00042') + tle('20580') + orphan;
    return new Response(body);
  });

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
  assert.deepEqual(await satelliteCount(first), stationsCount);
  assert.equal(
    (await ask(first.get('/api/celestrak'), { url: '/visual' })).status,
    200,
  );
  assert.deepEqual(await satelliteCount(first), combinedCount);

  const second = compose();
  assert.equal(await satelliteCount(second), undefined);
  assert.deepEqual(await satelliteCount(first), combinedCount);
  assert.equal(upstream.mock.callCount(), 2);
});

async function cacheDir(t, { firmsKey } = {}) {
  const previous = process.cwd();
  const key = process.env.FIRMS_MAP_KEY;
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-layer-count-'));
  t.after(async () => {
    process.chdir(previous);
    if (key === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = key;
    await rm(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  if (firmsKey === undefined) delete process.env.FIRMS_MAP_KEY;
  else process.env.FIRMS_MAP_KEY = firmsKey;
  await mkdir('.gev-cache');
  return dir;
}

test('CelesTrak cold counts read only existing core TLE caches', async (t) => {
  await cacheDir(t);
  const now = 1_800_000_000_000;
  for (const [file, age, body] of [
    ['celestrak-stations', 1000, tle('25544') + tle('A0000')],
    ['celestrak-visual', 2000, tle('25544') + tle('20580')],
    [
      'celestrak-geo',
      3000,
      'BROKEN PAIR\n1 99999U trailing\n2 99998 trailing\n',
    ],
    ['celestrak-active', 4000, tle('33333')],
    ['celestrak-starlink', 5000, tle('44444')],
    ['celestrak-satcat-stations', 6000, tle('55555')],
  ]) {
    await writeFile(
      `.gev-cache/${file}.json`,
      JSON.stringify({ at: now - age, body }),
    );
  }
  await writeFile('.gev-cache/celestrak-science.json', '{');
  const upstream = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('counts must not fetch');
  });
  const handler = endpointHandler({
    satellites: celestrakProxy().api.readLayerCount,
  });
  const readCount = () => countRows(handler);
  const expected = [{ layerId: 'satellites', count: 3, at: now - 2000 }];
  assert.deepEqual(await readCount(), expected);

  const before = (await fsp.readdir('.gev-cache')).sort();
  const read = t.mock.method(fsp, 'readFile');
  const write = t.mock.method(fsp, 'writeFile');
  const rename = t.mock.method(fsp, 'rename');
  assert.deepEqual(await Promise.all([readCount(), readCount()]), [
    expected,
    expected,
  ]);
  const reads = read.mock.calls.map(({ arguments: [file] }) =>
    path.basename(file),
  );
  assert.equal(
    reads.length,
    new Set(reads).size,
    'overlap reads each file once',
  );
  assert.ok(reads.includes('celestrak-stations.json'));
  assert.ok(reads.includes('celestrak-visual.json'));
  assert.ok(
    !reads.some((file) => /celestrak-(?:active|starlink|satcat-)/.test(file)),
    'the count only opens raw core-group caches',
  );
  assert.equal(upstream.mock.callCount(), 0);
  assert.equal(write.mock.callCount(), 0);
  assert.equal(rename.mock.callCount(), 0);
  assert.deepEqual((await fsp.readdir('.gev-cache')).sort(), before);

  await writeFile(
    '.gev-cache/celestrak-visual.json',
    JSON.stringify({
      at: now,
      body: tle('25544') + tle('20580') + tle('12345'),
    }),
  );
  assert.deepEqual(await readCount(), [
    { layerId: 'satellites', count: 4, at: now - 1000 },
  ]);
});

test('CelesTrak counts prefer a fresh in-memory feed over an overlapping raw disk read', async (t) => {
  const now = 1_800_000_000_000;
  const stale = JSON.stringify({ at: now - 7 * 3600_000, body: tle('25544') });
  const fresh = tle('25544') + tle('20580');
  const staleRead = Promise.withResolvers();
  const countReading = Promise.withResolvers();
  let firstRead = true;
  t.after(() => staleRead.resolve(stale));
  t.mock.method(Date, 'now', () => now);
  t.mock.method(fsp, 'readFile', async (file) => {
    if (path.basename(file) !== 'celestrak-stations.json')
      throw new Error('fixture cache missing');
    if (!firstRead) return stale;
    firstRead = false;
    countReading.resolve();
    return staleRead.promise;
  });
  for (const method of ['mkdir', 'writeFile', 'rename'])
    t.mock.method(fsp, method, async () => {});
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
  await countReading.promise;
  try {
    const refresh = await feed();
    assert.equal(refresh.body, fresh);
    assert.equal(refresh.headers['x-tle-cache'], 'MISS');
  } finally {
    staleRead.resolve(stale);
  }

  assert.deepEqual(await pendingCount, [
    { layerId: 'satellites', count: 2, at: now },
  ]);
  const next = await feed();
  assert.equal(next.body, fresh);
  assert.equal(next.headers['x-tle-cache'], 'HIT');
  assert.equal(upstream.mock.callCount(), 1);
});

test('CelesTrak counts reflect the last usable cache when atomic TLE persistence fails', async (t) => {
  await cacheDir(t);
  const raw = path.resolve('.gev-cache/celestrak-stations.json');
  const at = 1_800_000_000_000;
  const now = at + 7 * 3600_000;
  const old = { at, body: tle('25544') };
  const fresh = old.body + tle('20580');
  await writeFile(raw, JSON.stringify(old));
  t.mock.method(Date, 'now', () => now);
  const upstream = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(fresh),
  );
  t.mock.method(console, 'warn', () => {});
  const rename = fsp.rename;
  let interrupt = true;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (interrupt && to === raw) throw new Error('interrupted write');
    await rename(from, to);
  });

  async function refresh(plugin) {
    const routes = new Map();
    plugin.configureServer({
      middlewares: { use: (route, handler) => routes.set(route, handler) },
    });
    const response = await ask(routes.get('/api/celestrak'), {
      url: '/stations',
    });
    assert.equal(response.body, fresh);
    assert.equal(response.headers['x-tle-cache'], 'MISS');
  }

  const first = celestrakProxy();
  await refresh(first);
  assert.deepEqual(await first.api.readLayerCount(), { count: 2, at: now });
  assert.deepEqual(JSON.parse(await fsp.readFile(raw, 'utf8')), old);
  const cold = celestrakProxy();
  assert.deepEqual(await cold.api.readLayerCount(), { count: 1, at });

  interrupt = false;
  await refresh(cold);
  assert.deepEqual(await celestrakProxy().api.readLayerCount(), {
    count: 2,
    at: now,
  });
  assert.deepEqual(await fsp.readdir('.gev-cache'), [path.basename(raw)]);
  assert.equal(upstream.mock.callCount(), 2);
});

test('CCTV: no count before the catalog is built, never building it to count', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  process.env.CCTV_FORCE_AUSTIN = '0';
  process.env.CCTV_SOURCES_FILE = 'missing-catalog.json';
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
  process.env.CCTV_FORCE_AUSTIN = '0';
  process.env.CCTV_SOURCES_FILE = 'missing-catalog.json';
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
  ingestAisStreamEnvelope(report('244060901'), true);
  ingestAisStreamEnvelope(report('244060902'), true);
  ingestAisStreamEnvelope(report('992446001'), true);
  assert.deepEqual(aisStreamVesselCount(), { count: 2, at: start });
  now = start + AISSTREAM_STALE_MS + 1;
  assert.equal(aisStreamVesselCount(), null, 'every row has gone stale');
});

test('AIS: worldwide counts follow the subscription at receipt and require a configured key', async (t) => {
  const savedKey = process.env.AISSTREAM_API_KEY;
  process.env.AISSTREAM_API_KEY = 'fixture';
  const saved = process.env.AISSTREAM_BOUNDING_BOXES;
  t.after(() => {
    if (savedKey === undefined) delete process.env.AISSTREAM_API_KEY;
    else process.env.AISSTREAM_API_KEY = savedKey;
    if (saved === undefined) delete process.env.AISSTREAM_BOUNDING_BOXES;
    else process.env.AISSTREAM_BOUNDING_BOXES = saved;
  });
  const start = Date.now() + 2 * 365 * 86_400_000;
  t.mock.method(Date, 'now', () => start);
  ingestAisStreamEnvelope(
    {
      MessageType: 'PositionReport',
      Message: { PositionReport: { UserID: 244060903, Sog: 5, Cog: 90 } },
      MetaData: {
        MMSI: '244060903',
        latitude: 53.4,
        longitude: 6.2,
        time_utc: '2026-09-17 20:00:00.000000000 +0000 UTC',
      },
    },
    true,
  );
  const { readLayerCount } = aisLiveProxy().api;
  const handler = endpointHandler({ 'ais-live-vessels': readLayerCount });
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
  const warn = t.mock.method(console, 'warn', () => {});
  process.env.AISSTREAM_BOUNDING_BOXES = 'invalid JSON';
  assert.deepEqual(await countRows(handler), [
    { layerId: 'ais-live-vessels', count: 1, at: start },
  ]);
  assert.equal(
    warn.mock.callCount(),
    0,
    'count reads do not warn about the environment',
  );
  process.env.AISSTREAM_BOUNDING_BOXES = '[[[50,0],[55,10]]]';
  assert.deepEqual(
    await countRows(handler),
    [{ layerId: 'ais-live-vessels', count: 1, at: start }],
    'the retained row arrived under worldwide coverage',
  );
  delete process.env.AISSTREAM_API_KEY;
  assert.equal(readLayerCount(), null);
  assert.deepEqual(await countRows(handler), []);
});

test('AIS: a vessel received under a regional subscription does not count', (t) => {
  const now = Date.now() + 3 * 365 * 86_400_000;
  t.mock.method(Date, 'now', () => now);
  ingestAisStreamEnvelope(
    {
      MessageType: 'PositionReport',
      Message: { PositionReport: { UserID: 244060904, Sog: 5, Cog: 90 } },
      MetaData: {
        MMSI: '244060904',
        latitude: 53.4,
        longitude: 6.2,
        time_utc: '2026-09-17 20:00:00.000000000 +0000 UTC',
      },
    },
    false,
  );
  assert.equal(aisStreamVesselCount(), null);
});

test('FIRMS: no count without a key, and with one the count saved beside the cache, never the cache itself', async (t) => {
  const dir = await cacheDir(t);
  // A cache this read must not parse: it is not even JSON.
  await writeFile(path.join(dir, '.gev-cache', 'firms.json'), 'not json');
  const summaryFile = path.join(dir, '.gev-cache', 'firms-count.json');
  const at = Date.UTC(2026, 0, 2, 12);
  let now = at;
  t.mock.method(Date, 'now', () => now);
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
  const handler = endpointHandler({
    'local-firms': firmsProxy().api.readLayerCount,
  });
  const read = t.mock.method(fsp, 'readFile');
  delete process.env.FIRMS_MAP_KEY;
  assert.deepEqual(await countRows(handler), [], 'no key, no count');
  assert.equal(read.mock.callCount(), 0);
  process.env.FIRMS_MAP_KEY = 'fixture';
  assert.deepEqual(await countRows(handler), [
    { layerId: 'local-firms', count: 5, at },
  ]);
  now++;
  assert.deepEqual(await countRows(handler), [
    { layerId: 'local-firms', count: 2, at },
  ]);
  await rm(summaryFile);
  assert.deepEqual(await countRows(handler), [], 'no saved count, no count');
  assert.ok(
    read.mock.calls.every(
      ({ arguments: [file] }) =>
        path.basename(file) === path.basename(summaryFile),
    ),
    'counts read only the compact summary',
  );

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

test('FIRMS restores raw data without a sidecar write and publishes one summary on refresh', async (t) => {
  await cacheDir(t, { firmsKey: 'fixture' });

  const at = Date.UTC(2026, 0, 2, 12);
  const fire = { acqDate: '2026-01-02', acqTime: '1159' };
  const raw = JSON.stringify({ at, sources: [], fires: [fire, fire] });
  await writeFile('.gev-cache/firms.json', raw);
  let now = at + 1000;
  t.mock.method(Date, 'now', () => now);
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        'latitude,longitude,acq_date,acq_time,confidence,frp\n1,2,2026-01-02,1159,n,4',
      ),
  );
  const rename = t.mock.method(fsp, 'rename');
  const plugin = firmsProxy();
  let route;
  plugin.configureServer({
    middlewares: {
      use: (_, handler) => {
        route = handler;
      },
    },
  });
  assert.equal(JSON.parse((await ask(route)).body).count, 2);
  assert.deepEqual(await plugin.api.readLayerCount(), { at, count: 2 });
  assert.equal(await firmsProxy().api.readLayerCount(), null);
  assert.deepEqual(await fsp.readdir('.gev-cache'), ['firms.json']);
  assert.equal(rename.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);

  now = at + 30 * 60_000;
  const replies = await Promise.all([ask(route), ask(route)]);
  for (const reply of replies) {
    const body = JSON.parse(reply.body);
    assert.equal(body.fetchedAt, now);
    assert.equal(body.count, 3);
  }
  assert.equal(fetch.mock.callCount(), 3, 'one pass over the three sources');
  assert.deepEqual(
    rename.mock.calls.map(({ arguments: [, to] }) => path.basename(to)),
    ['firms.json', 'firms-count.json'],
  );
  const persistedFeed = JSON.parse(
    await fsp.readFile('.gev-cache/firms.json', 'utf8'),
  );
  assert.equal(
    persistedFeed.minutes,
    undefined,
    'only the summary stores minute buckets',
  );
  assert.deepEqual(await firmsProxy().api.readLayerCount(), {
    at: now,
    count: 3,
  });
});

test('FIRMS keeps the last durable count when a raw cache replacement fails', async (t) => {
  await cacheDir(t, { firmsKey: 'fixture' });
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
  assert.deepEqual(await plugin.api.readLayerCount(), { at: now, count: 3 });
  assert.equal(await fsp.readFile(rawPath, 'utf8'), raw);
  assert.deepEqual(await firmsProxy().api.readLayerCount(), { at, count: 2 });
});
