import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDACS_TTL_MS,
  gdacsProxy,
  gdacsRetryCooldownMs,
} from '../../server/providers/gdacs.js';

const FEED =
  'https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP?eventtype=';
const TYPES = ['EQ', 'TC', 'FL', 'VO', 'DR', 'WF'];

function centroid(type, eventid, alertlevel = 'Green', extra = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [10, 20] },
    properties: {
      Class: 'Point_Centroid',
      eventtype: type,
      eventid,
      episodeid: 1,
      alertlevel,
      name: `${type} ${eventid}`,
      fromdate: '2026-09-20T00:00:00',
      todate: '2026-09-28T00:00:00',
      iscurrent: 'true',
      url: {
        report: `https://www.gdacs.org/report.aspx?eventid=${eventid}`,
      },
      ...extra,
    },
  };
}

/** One feed per type: a centroid plus the track geometry that is dropped. */
const feed = (type) => ({
  type: 'FeatureCollection',
  features: [
    centroid(type, 100 + TYPES.indexOf(type), type === 'TC' ? 'Red' : 'Green'),
    {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [] },
      properties: { Class: 'Poly_Cones', eventtype: type, eventid: 1 },
    },
  ],
});

const typeOf = (url) => new URL(url).searchParams.get('eventtype');

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = gdacsProxy(options);
  assert.equal(plugin.name, 'gdacs');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/gdacs');
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
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: peer } }, res);
    return res;
  };
}

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: fetches the six fixed GDACS feeds and returns only centroids`, async () => {
    const calls = [];
    const request = install(
      {
        now: () => 1234,
        fetchImpl: async (url, options) => {
          calls.push(url);
          assert.ok(options.signal instanceof AbortSignal);
          assert.equal(options.redirect, 'error');
          return Response.json(feed(typeOf(url)));
        },
      },
      hook,
    );
    const res = await request('/?url=https://invalid.example');
    assert.equal(res.status, 200);
    assert.deepEqual(
      calls,
      TYPES.map((type) => `${FEED}${type}`),
    );
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['X-Data-Stale'], undefined);
    assert.equal(res.body.fetchedAt, 1234);
    assert.equal(res.body.stale, undefined);
    assert.deepEqual(
      res.body.feeds,
      TYPES.map((type) => ({ type, fetchedAt: 1234, stale: false })),
    );
    assert.deepEqual(
      res.body.events.map(({ id, level }) => [id, level]),
      TYPES.map((type, index) => [
        `${type}-${100 + index}`,
        type === 'TC' ? 'red' : 'green',
      ]),
    );
  });
}

test('each hazard type is cached for its own lifetime and concurrent reads share one upstream call', async () => {
  let clock = 0;
  const calls = [];
  const request = install({
    now: () => clock,
    fetchImpl: async (url) => {
      calls.push(typeOf(url));
      return Response.json(feed(typeOf(url)));
    },
  });
  await Promise.all([request(), request('/', 'GET', 'other')]);
  assert.equal(calls.length, 6);
  clock = GDACS_TTL_MS.EQ;
  await request();
  assert.deepEqual(calls.slice(6), ['EQ']);
  clock = GDACS_TTL_MS.DR;
  await request();
  assert.deepEqual(calls.slice(7).sort(), [...TYPES].sort());
});

test('a failed feed is reported missing while the others still serve', async () => {
  const request = install({
    now: () => 5,
    fetchImpl: async (url) =>
      typeOf(url) === 'DR'
        ? new Response('down', { status: 503 })
        : Response.json(feed(typeOf(url))),
  });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], 'true');
  assert.equal(res.body.stale, true);
  assert.deepEqual(
    res.body.feeds.find(({ type }) => type === 'DR'),
    { type: 'DR', fetchedAt: null, stale: false, missing: true },
  );
  assert.equal(res.body.events.length, 5);
});

test('an upstream failure serves the last copy of a feed as stale, else 502', async () => {
  let clock = 0;
  let fail = false;
  const request = install({
    now: () => clock,
    fetchImpl: async (url) => {
      if (fail) throw new Error('network');
      return Response.json(feed(typeOf(url)));
    },
  });
  fail = true;
  const cold = await request();
  assert.equal(cold.status, 502);
  assert.deepEqual(cold.body, { error: 'gdacs_unavailable' });
  fail = false;
  await request();
  fail = true;
  clock = GDACS_TTL_MS.DR + 1;
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], 'true');
  assert.ok(res.body.feeds.every(({ stale }) => stale));
  assert.equal(res.body.events.length, 6);
});

test('an upstream 429 starts one shared cooldown with no further upstream calls', async () => {
  let clock = 0;
  let calls = 0;
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '120' },
      });
    },
  });
  const first = await request();
  assert.equal(first.status, 429);
  assert.deepEqual(first.body, { error: 'gdacs_rate_limited' });
  assert.equal(first.headers['Retry-After'], '120');
  const upstreamCalls = calls;
  assert.ok(upstreamCalls >= 1 && upstreamCalls <= 6);
  clock = 60_000;
  const cooling = await request();
  assert.equal(cooling.status, 429);
  assert.equal(cooling.headers['Retry-After'], '60');
  assert.equal(calls, upstreamCalls, 'no upstream call during the cooldown');
  clock = 120_001;
  await request();
  assert.ok(calls > upstreamCalls, 'the cooldown ends');
});

test('Retry-After accepts seconds or an HTTP date, clamped to 30 s to 30 min', () => {
  const now = Date.UTC(2026, 8, 29, 12);
  assert.equal(gdacsRetryCooldownMs('90', now), 90_000);
  assert.equal(gdacsRetryCooldownMs('1', now), 30_000);
  assert.equal(gdacsRetryCooldownMs('86400', now), 30 * 60_000);
  assert.equal(
    gdacsRetryCooldownMs(new Date(now + 600_000).toUTCString(), now),
    600_000,
  );
  assert.equal(gdacsRetryCooldownMs(null, now), 5 * 60_000);
  assert.equal(gdacsRetryCooldownMs('soon', now), 5 * 60_000);
  assert.equal(
    gdacsRetryCooldownMs(new Date(now - 1000).toUTCString(), now),
    5 * 60_000,
  );
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

test('the route rejects other methods, paths, a malformed feed and floods', async () => {
  const request = install({
    fetchImpl: async () => Response.json({ features: 'no' }),
  });
  const post = await request('/', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.equal((await request('/other')).status, 404);
  assert.equal((await request('/')).status, 502);

  const flood = install({
    fetchImpl: async (url) => Response.json(feed(typeOf(url))),
  });
  let last;
  for (let index = 0; index < 31; index += 1)
    last = await flood('/', 'GET', 'one');
  assert.equal(last.status, 429);
  assert.deepEqual(last.body, { error: 'rate_limited' });
  assert.equal((await flood('/', 'GET', 'two')).status, 200);
});
