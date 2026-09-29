import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RADIATION_TTL_MS,
  radiationProxy,
  radiationRetryCooldownMs,
} from '../../server/providers/radiation.js';

const BFS_URL =
  'https://www.imis.bfs.de/ogc/opendata/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=opendata:odlinfo_odl_1h_latest&outputFormat=application/json';
const SAFECAST_URL = 'https://tt.safecast.org/devices';
const NOW = Date.parse('2026-09-29T21:00:00Z');

const bfsFeed = () => ({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [9.18, 49.45] },
      properties: {
        id: 'DEZ2240',
        name: 'Limbach',
        site_status: 1,
        end_measure: '2026-09-29T20:00:00Z',
        value: 0.148,
        unit: 'µSv/h',
      },
    },
  ],
});

const safecastFeed = () => [
  {
    device: 4070352005,
    loc_lat: 50.0,
    loc_lon: 30.0,
    loc_name: 'Kyiv',
    loc_country: 'UA',
    when_captured: '2026-09-29T20:30:00Z',
    lnd_7318u: 40,
    device_contact_name: 'Private Person',
    device_contact_email: 'someone@example.com',
  },
];

const feedFor = (url) =>
  url === BFS_URL ? bfsFeed() : url === SAFECAST_URL ? safecastFeed() : null;

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = radiationProxy(options);
  assert.equal(plugin.name, 'radiation');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/radiation');
        handler = callback;
      },
    },
  });
  return async (url = '/', method = 'GET', peer = 'local') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.raw = body;
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: peer } }, res);
    return res;
  };
}

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: fetches the two fixed feeds and returns normalised readings only`, async () => {
    const calls = [];
    const request = install(
      {
        now: () => NOW,
        fetchImpl: async (url, options) => {
          calls.push(url);
          assert.ok(options.signal instanceof AbortSignal);
          assert.equal(options.redirect, 'error');
          return Response.json(feedFor(url));
        },
      },
      hook,
    );
    const res = await request('/?url=https://invalid.example');
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [BFS_URL, SAFECAST_URL]);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['X-Data-Stale'], undefined);
    assert.equal(res.body.fetchedAt, NOW);
    assert.deepEqual(res.body.feeds, [
      { source: 'bfs', fetchedAt: NOW, stale: false },
      { source: 'safecast', fetchedAt: NOW, stale: false },
    ]);
    assert.deepEqual(
      res.body.readings.map(({ id, usvh }) => [id, usvh]),
      [
        ['bfs-DEZ2240', 0.148],
        ['safecast-4070352005', 0.12],
      ],
    );
    assert.doesNotMatch(res.raw, /contact|example\.com|Private Person/);
  });
}

test('each feed is cached for its own lifetime and concurrent reads share one upstream call', async () => {
  let clock = NOW;
  const calls = [];
  const request = install({
    now: () => clock,
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json(feedFor(url));
    },
  });
  await Promise.all([request(), request('/', 'GET', 'other')]);
  assert.equal(calls.length, 2);
  clock = NOW + RADIATION_TTL_MS.safecast;
  await request();
  assert.deepEqual(calls.slice(2), [SAFECAST_URL]);
  clock = NOW + RADIATION_TTL_MS.bfs;
  await request();
  assert.deepEqual(calls.slice(3), [BFS_URL], 'Safecast is still fresh');
});

test('a failed feed is reported missing while the other still serves', async () => {
  const request = install({
    now: () => NOW,
    fetchImpl: async (url) =>
      url === SAFECAST_URL
        ? new Response('down', { status: 503 })
        : Response.json(feedFor(url)),
  });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], 'true');
  assert.equal(res.body.stale, true);
  assert.deepEqual(res.body.feeds[1], {
    source: 'safecast',
    fetchedAt: null,
    stale: false,
    missing: true,
  });
  assert.deepEqual(
    res.body.readings.map(({ id }) => id),
    ['bfs-DEZ2240'],
  );
});

test('an upstream failure serves the last copy of a feed as stale, else 502', async () => {
  let clock = NOW;
  let fail = false;
  const request = install({
    now: () => clock,
    fetchImpl: async (url) => {
      if (fail) throw new Error('network');
      return Response.json(feedFor(url));
    },
  });
  fail = true;
  const cold = await request();
  assert.equal(cold.status, 502);
  assert.deepEqual(cold.body, { error: 'radiation_unavailable' });
  fail = false;
  await request();
  fail = true;
  clock = NOW + RADIATION_TTL_MS.bfs + 1;
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], 'true');
  assert.ok(res.body.feeds.every(({ stale }) => stale));
  assert.equal(res.body.readings.length, 2);
});

test('an upstream 429 cools that feed down with no further upstream calls', async () => {
  let clock = NOW;
  const calls = [];
  const request = install({
    now: () => clock,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '120' },
      });
    },
  });
  const first = await request();
  assert.equal(first.status, 429);
  assert.deepEqual(first.body, { error: 'radiation_rate_limited' });
  assert.equal(first.headers['Retry-After'], '120');
  assert.equal(calls.length, 2);
  clock = NOW + 60_000;
  const cooling = await request();
  assert.equal(cooling.status, 429);
  assert.equal(cooling.headers['Retry-After'], '60');
  assert.equal(calls.length, 2, 'no upstream call during the cooldown');
  clock = NOW + 120_001;
  await request();
  assert.equal(calls.length, 4, 'the cooldown ends');
});

test('one feed cooling down does not hold back the other', async () => {
  let clock = NOW;
  let limited = true;
  const calls = [];
  const request = install({
    now: () => clock,
    fetchImpl: async (url) => {
      calls.push(url);
      if (limited && url === BFS_URL)
        return new Response('slow down', {
          status: 429,
          headers: { 'retry-after': '3600' },
        });
      return Response.json(feedFor(url));
    },
  });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.body.feeds[0].missing, true);
  limited = false;
  clock = NOW + RADIATION_TTL_MS.safecast;
  await request();
  assert.deepEqual(calls.slice(2), [SAFECAST_URL], 'BfS is still cooling');
});

test('Retry-After accepts seconds or an HTTP date, clamped to 30 s to 60 min', () => {
  const now = Date.UTC(2026, 8, 29, 12);
  assert.equal(radiationRetryCooldownMs('90', now), 90_000);
  assert.equal(radiationRetryCooldownMs('1', now), 30_000);
  assert.equal(radiationRetryCooldownMs('86400', now), 60 * 60_000);
  assert.equal(
    radiationRetryCooldownMs(new Date(now + 600_000).toUTCString(), now),
    600_000,
  );
  assert.equal(radiationRetryCooldownMs(null, now), 5 * 60_000);
  assert.equal(radiationRetryCooldownMs('soon', now), 5 * 60_000);
});

test('an oversized upstream body is refused without being parsed', async () => {
  const request = install({
    fetchImpl: async () =>
      new Response('x'.repeat(8 * 1024 * 1024 + 1), {
        headers: { 'content-type': 'application/json' },
      }),
  });
  const res = await request();
  assert.equal(res.status, 502);
});

test('the route rejects other methods, paths, malformed feeds and floods', async () => {
  const request = install({
    fetchImpl: async () => Response.json({ features: 'no' }),
  });
  const post = await request('/', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.equal((await request('/other')).status, 404);
  assert.equal((await request('/')).status, 502);

  const flood = install({
    now: () => NOW,
    fetchImpl: async (url) => Response.json(feedFor(url)),
  });
  let last;
  for (let index = 0; index < 31; index += 1)
    last = await flood('/', 'GET', 'one');
  assert.equal(last.status, 429);
  assert.deepEqual(last.body, { error: 'rate_limited' });
  assert.equal((await flood('/', 'GET', 'two')).status, 200);
});
