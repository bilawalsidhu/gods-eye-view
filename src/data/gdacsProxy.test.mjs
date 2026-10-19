import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDACS_TTL_MS,
  gdacsProxy,
  gdacsRetryCooldownMs,
} from '../../server/providers/gdacs.js';

const FEED =
  'https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP?eventtype=';
const TYPES = ['FL', 'VO', 'DR'];
const RETRY_MS = 5 * 60_000;

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
    centroid(type, 100 + TYPES.indexOf(type), type === 'VO' ? 'Red' : 'Green'),
    {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [] },
      properties: { Class: 'Poly_Cones', eventtype: type, eventid: 1 },
    },
  ],
});

const typeOf = (url) => new URL(url).searchParams.get('eventtype');

/** What GDACS answers for a valid type with no current events. */
const noEvents = () =>
  new Response(
    JSON.stringify({
      type: 'https://tools.ietf.org/html/rfc9110#section-15.5.5',
      title: 'Not Found',
      status: 404,
    }),
    {
      status: 404,
      headers: { 'content-type': 'application/problem+json; charset=utf-8' },
    },
  );

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
  test(`${hook}: fetches the three fixed GDACS feeds and returns only centroids`, async () => {
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
        type === 'VO' ? 'red' : 'green',
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
  assert.equal(calls.length, 3);
  clock = GDACS_TTL_MS.VO;
  await request();
  assert.deepEqual(calls.slice(3), ['VO']);
  clock = GDACS_TTL_MS.DR;
  await request();
  assert.deepEqual(calls.slice(4).sort(), [...TYPES].sort());
});

test('earthquake, cyclone and wildfire feeds are never requested or served', async () => {
  const calls = [];
  const request = install({
    fetchImpl: async (url) => {
      calls.push(typeOf(url));
      // A feed that strays into other hazards still yields only its own.
      return Response.json({
        type: 'FeatureCollection',
        features: ['EQ', 'TC', 'WF', typeOf(url)].map((type, index) =>
          centroid(type, 10 + index),
        ),
      });
    },
  });
  const res = await request();
  assert.deepEqual(calls, TYPES);
  assert.deepEqual(
    res.body.feeds.map(({ type }) => type),
    TYPES,
  );
  assert.deepEqual(res.body.events.map(({ type }) => type).sort(), [
    'DR',
    'FL',
    'VO',
  ]);
});

test('a 404 problem document for a type with no current events is an empty, fresh, cached feed', async () => {
  let clock = 0;
  const calls = [];
  const request = install({
    now: () => clock,
    fetchImpl: async (url) => {
      calls.push(typeOf(url));
      return typeOf(url) === 'VO'
        ? noEvents()
        : Response.json(feed(typeOf(url)));
    },
  });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], undefined);
  assert.equal(res.body.stale, undefined);
  assert.deepEqual(
    res.body.feeds.find(({ type }) => type === 'VO'),
    { type: 'VO', fetchedAt: 0, stale: false },
  );
  assert.deepEqual(
    res.body.events.map(({ id }) => id),
    ['FL-100', 'DR-102'],
  );
  // The empty answer is held for the volcano TTL like any other feed.
  clock = GDACS_TTL_MS.VO - 1;
  const again = await request();
  assert.equal(again.body.stale, undefined);
  assert.equal(calls.length, 3, 'no re-fetch inside the TTL');
  clock = GDACS_TTL_MS.VO;
  await request();
  assert.deepEqual(calls.slice(3), ['VO']);
});

test('a 404 that is not a GDACS problem document is still an outage', async () => {
  const request = install({
    now: () => 5,
    fetchImpl: async (url) =>
      typeOf(url) === 'VO'
        ? new Response('<html>gone</html>', {
            status: 404,
            headers: { 'content-type': 'text/html' },
          })
        : Response.json(feed(typeOf(url))),
  });
  const res = await request();
  assert.deepEqual(
    res.body.feeds.find(({ type }) => type === 'VO'),
    { type: 'VO', fetchedAt: null, stale: false, missing: true },
  );
});

test('a failed feed is reported missing on its own, without marking the fresh feeds stale or re-fetching it on every request', async () => {
  let clock = 5;
  const calls = [];
  const request = install({
    now: () => clock,
    fetchImpl: async (url) => {
      calls.push(typeOf(url));
      return typeOf(url) === 'DR'
        ? new Response('down', { status: 503 })
        : Response.json(feed(typeOf(url)));
    },
  });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], undefined);
  assert.equal(res.body.stale, undefined);
  assert.deepEqual(
    res.body.feeds.find(({ type }) => type === 'DR'),
    { type: 'DR', fetchedAt: null, stale: false, missing: true },
  );
  assert.deepEqual(
    res.body.feeds.filter(({ type }) => type !== 'DR'),
    [
      { type: 'FL', fetchedAt: 5, stale: false },
      { type: 'VO', fetchedAt: 5, stale: false },
    ],
  );
  assert.equal(res.body.events.length, 2);
  clock = 5 + RETRY_MS - 1;
  const held = await request();
  assert.equal(held.body.feeds.find(({ type }) => type === 'DR').missing, true);
  assert.equal(calls.length, 3, 'the failed feed is held off, not re-fetched');
  clock = 5 + RETRY_MS;
  await request();
  assert.deepEqual(calls.slice(3), ['DR'], 'retried after the hold-off only');
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
  clock = RETRY_MS;
  await request();
  fail = true;
  clock = RETRY_MS + GDACS_TTL_MS.DR + 1;
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], 'true');
  assert.equal(res.body.stale, true);
  assert.ok(res.body.feeds.every(({ stale }) => stale));
  assert.equal(res.body.events.length, 3);
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
  assert.ok(upstreamCalls >= 1 && upstreamCalls <= 3);
  clock = 60_000;
  const cooling = await request();
  assert.equal(cooling.status, 429);
  assert.equal(cooling.headers['Retry-After'], '60');
  assert.equal(calls, upstreamCalls, 'no upstream call during the cooldown');
  clock = 120_001;
  await request();
  assert.ok(calls > upstreamCalls, 'the cooldown ends');
});

test('a valid Retry-After is honoured in full, seconds or HTTP date, up to 24 h', () => {
  const now = Date.UTC(2026, 8, 29, 12);
  const HOUR = 3_600_000;
  assert.equal(gdacsRetryCooldownMs('90', now), 90_000);
  assert.equal(gdacsRetryCooldownMs(' 7200 ', now), 2 * HOUR);
  assert.equal(gdacsRetryCooldownMs('86400', now), 24 * HOUR);
  assert.equal(
    gdacsRetryCooldownMs(new Date(now + 3 * HOUR).toUTCString(), now),
    3 * HOUR,
  );
  // A floor that only ever lengthens upstream's deadline.
  assert.equal(gdacsRetryCooldownMs('1', now), 30_000);
  // Past 24 h the header is taken as broken and capped.
  assert.equal(gdacsRetryCooldownMs('999999999', now), 24 * HOUR);
  for (const raw of [null, '', 'soon', '0', '-5', '1.5', '1e3'])
    assert.equal(gdacsRetryCooldownMs(raw, now), 5 * 60_000, String(raw));
  assert.equal(
    gdacsRetryCooldownMs(new Date(now - 1000).toUTCString(), now),
    5 * 60_000,
  );
});

test('concurrent 429s with different Retry-After deadlines keep the longest', async () => {
  let clock = 0;
  let calls = 0;
  const retryAfter = { FL: '60', VO: '7200', DR: '600' };
  const request = install({
    now: () => clock,
    fetchImpl: async (url) => {
      calls += 1;
      return new Response('slow down', {
        status: 429,
        headers: { 'retry-after': retryAfter[typeOf(url)] },
      });
    },
  });
  const first = await request();
  assert.equal(calls, 3);
  assert.equal(first.status, 429);
  assert.equal(first.headers['Retry-After'], '7200');
  clock = 7_199_000;
  const cooling = await request('/', 'GET', 'later');
  assert.equal(cooling.status, 429);
  assert.equal(cooling.headers['Retry-After'], '1');
  assert.equal(calls, 3, 'no upstream call until the longest deadline');
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
