import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  _resetLayerCountsForTest,
  layerCountsEndpoint,
  readLayerCounts,
  registerLayerCount,
} from './layerCounts.js';
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

test('layer counts come only from registered cache readers, and empty or failing ones are left out', async (t) => {
  t.after(_resetLayerCountsForTest);
  registerLayerCount('satellites', () => ({ count: 1272.4, at: 100 }));
  registerLayerCount('cctv', () => null);
  registerLayerCount('flights', async () => ({ count: 0, at: 5 }));
  registerLayerCount('local-firms', () => {
    throw new Error('disk gone');
  });
  registerLayerCount('ais-live-vessels', async () => ({
    count: 9,
    at: Number.NaN,
  }));
  assert.deepEqual(await readLayerCounts(), [
    { layerId: 'satellites', count: 1272, at: 100 },
    { layerId: 'ais-live-vessels', count: 9, at: null },
  ]);
});

/** The endpoint's middleware, as a dev or preview server installs it. */
function endpointHandler(hook = 'configureServer') {
  let handler = null;
  layerCountsEndpoint()[hook]({
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
async function ask(handler, { method = 'GET', headers = {}, url = '/' } = {}) {
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
  );
  return sent;
}

test('the endpoint answers GET with the counts, uncached, on dev and preview servers', async (t) => {
  t.after(_resetLayerCountsForTest);
  registerLayerCount('satellites', () => ({ count: 12, at: 100 }));
  registerLayerCount('ais-live-vessels', () => ({ count: 9, at: null }));
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const sent = await ask(endpointHandler(hook));
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

test('the endpoint answers HEAD with no body, refuses other methods and cross-site requests', async (t) => {
  t.after(_resetLayerCountsForTest);
  let reads = 0;
  registerLayerCount('satellites', () => {
    reads++;
    return { count: 12, at: 100 };
  });
  const handler = endpointHandler();
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
  assert.equal(reads, 1, 'only the HEAD read the caches');
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
    _resetLayerCountsForTest();
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
  openSkyProxy().configureServer({
    middlewares: {
      use(route, handler) {
        assert.equal(route, '/api/flights');
        flights = handler;
      },
    },
  });
  const counts = endpointHandler();
  assert.equal((await ask(flights)).status, 200);
  assert.deepEqual(JSON.parse((await ask(counts)).body).counts, [
    { layerId: 'flights', count: 1, at: observedAt },
  ]);

  now += 60_000;
  assert.equal((await ask(flights)).status, 200);
  assert.deepEqual(JSON.parse((await ask(counts)).body).counts, [
    { layerId: 'flights', count: 2, at: null },
  ]);
  assert.equal(upstream.mock.callCount(), 2);
});

const tle = (norad) =>
  `SAT ${norad}\n1 ${norad}U 98067A   26001.00000000  .00000000  00000-0  00000-0 0  9990\n2 ${norad}  51.6400 000.0000 0000000   0.0000   0.0000 15.50000000    00\n`;

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
  t.after(_resetLayerCountsForTest);
  const now = 1_800_000_000_000;
  const stale = JSON.stringify({
    at: now - 7 * 3600_000,
    body: tle('25544'),
  });
  const fresh = tle('25544') + tle('20580');
  const firstRead = Promise.withResolvers();
  const stationReads = [firstRead.promise, stale];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(fsp, 'readFile', async (filename) => {
    if (path.basename(filename) !== 'celestrak-stations.json')
      throw new Error('fixture cache missing');
    return stationReads.shift();
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  const upstream = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(fresh),
  );
  const routes = new Map();
  celestrakProxy().configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  const feed = () => ask(routes.get('/api/celestrak'), { url: '/stations' });

  const pendingCount = ask(endpointHandler());
  const refresh = await feed();
  firstRead.resolve(stale);
  const count = await pendingCount;
  const nextFeed = await feed();

  assert.equal(refresh.body, fresh);
  assert.deepEqual(JSON.parse(count.body).counts, [
    { layerId: 'satellites', count: 2, at: now },
  ]);
  assert.equal(nextFeed.body, fresh);
  assert.equal(nextFeed.headers['x-tle-cache'], 'HIT');
  assert.equal(upstream.mock.callCount(), 1);
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
    _resetLayerCountsForTest();
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
  aisLiveProxy();
  delete process.env.AISSTREAM_BOUNDING_BOXES;
  assert.deepEqual(await readLayerCounts(), [
    { layerId: 'ais-live-vessels', count: 1, at: start },
  ]);
  process.env.AISSTREAM_BOUNDING_BOXES = '[[[-90,-180],[90,180]]]';
  assert.equal(
    (await readLayerCounts()).length,
    1,
    'the default box, spelt out',
  );
  process.env.AISSTREAM_BOUNDING_BOXES = '[[[50,0],[55,10]]]';
  assert.deepEqual(await readLayerCounts(), [], 'one region, no count');
});

test('FIRMS: no count without a key, and with one the count saved beside the cache, never the cache itself', async (t) => {
  const savedKey = process.env.FIRMS_MAP_KEY;
  const savedCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-firms-count-'));
  t.after(async () => {
    process.chdir(savedCwd);
    if (savedKey === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = savedKey;
    _resetLayerCountsForTest();
    await rm(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  await mkdir(path.join(dir, '.gev-cache'));
  // A cache this read must not parse: it is not even JSON.
  await writeFile(path.join(dir, '.gev-cache', 'firms.json'), 'not json');
  await writeFile(
    path.join(dir, '.gev-cache', 'firms-count.json'),
    JSON.stringify({ at: 1234, count: 4321 }),
  );
  firmsProxy();
  delete process.env.FIRMS_MAP_KEY;
  assert.deepEqual(await readLayerCounts(), [], 'no key, no count');
  process.env.FIRMS_MAP_KEY = 'fixture';
  assert.deepEqual(await readLayerCounts(), [
    { layerId: 'local-firms', count: 4321, at: 1234 },
  ]);
  await rm(path.join(dir, '.gev-cache', 'firms-count.json'));
  assert.deepEqual(await readLayerCounts(), [], 'no saved count, no count');
});
