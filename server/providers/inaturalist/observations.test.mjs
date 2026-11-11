import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installInatProxy, NOW } from './proxy.fixture.mjs';
import { createInatClient, inatRetryCooldownMs } from './client.js';

const observation = (id = 1) => ({
  id,
  uri: `https://www.inaturalist.org/observations/${id}`,
  geojson: { coordinates: [-122.351, 47.613] },
  time_observed_at: '2026-11-04T17:00:00Z',
  observed_on: '2026-11-04',
  created_at: '2026-11-04T17:01:00Z',
  quality_grade: 'research',
  license_code: 'cc-by',
  positional_accuracy: 12,
  faves_count: 2,
  num_identification_agreements: 3,
  taxon: {
    name: 'Calypte anna',
    preferred_common_name: "Anna's hummingbird",
    iconic_taxon_name: 'Aves',
  },
  photos: [
    {
      url: 'https://inaturalist-open-data.s3.amazonaws.com/photos/123/square.jpeg',
      license_code: 'cc-by',
      attribution: 'Synthetic photographer, CC BY',
    },
  ],
  user: { login: 'must-never-leave-server' },
});
const envelope = (rows = [observation()], total = rows.length) => ({
  total_results: total,
  page: 1,
  per_page: 200,
  results: rows,
});
const boxUrl = (index = 0, extra = '') =>
  `/observations?south=47.51&west=${-122.49 + index * 0.2}&north=47.69&east=${-122.31 + index * 0.2}${extra}`;

function install(options = {}, hook = 'configureServer') {
  return installInatProxy(
    boxUrl(),
    {
      // Serial dispatch makes queued cancellation and coalescing observable.
      queueOptions: { intervalMs: 0, windowMs: 0, maxInFlight: 1 },
      ...options,
    },
    hook,
  );
}

async function until(check) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise(setImmediate);
  }
  assert.fail('expected fake upstream calls were not dispatched');
}

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: actual v2 envelope, fixed query, projection and privacy`, async () => {
    const calls = [];
    const cache = new Map();
    const request = install(
      {
        cache,
        fetchImpl: async (url, options) => {
          calls.push(new URL(url));
          assert.equal(options.redirect, 'error');
          assert.ok(options.signal instanceof AbortSignal);
          assert.equal(options.headers.Accept, 'application/json');
          assert.equal(
            options.headers['User-Agent'],
            'gods-eye-view-wildlife-sightings-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
          );
          return Response.json(envelope());
        },
      },
      hook,
    );
    assert.equal(calls.length, 0, 'construction and mounting do not acquire');
    const result = await request(
      boxUrl(0, '&url=https://attacker.example&per_page=999'),
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.equal(result.body.rows[0].stableId, 'inat:1');
    assert.equal(result.body.fetchedAt, NOW);
    assert.equal(result.body.scope, 'view');
    assert.deepEqual(result.body.box, {
      south: 47.5,
      west: -122.5,
      north: 47.7,
      east: -122.3,
    });
    const query = calls[0].searchParams;
    assert.equal(
      calls[0].origin + calls[0].pathname,
      'https://api.inaturalist.org/v2/observations',
    );
    // Only the projected fields are requested, never user or identification data.
    assert.match(query.get('fields'), /^\(id:!t,uri:!t,.*photos:\(url:!t/);
    assert.doesNotMatch(query.get('fields'), /user|identifications/);
    assert.equal(query.get('swlat'), '47.5');
    assert.equal(query.get('swlng'), '-122.5');
    assert.equal(query.get('nelat'), '47.7');
    assert.equal(query.get('nelng'), '-122.3');
    assert.equal(query.get('d1'), '2026-11-02');
    assert.equal(query.has('created_d1'), false);
    assert.equal(query.get('per_page'), '200');
    assert.equal(query.get('verifiable'), 'true');
    assert.equal(query.get('photos'), 'true');
    assert.equal(query.get('captive'), 'false');
    assert.equal(query.get('order_by'), 'random');
    assert.equal(query.has('order'), false);
    assert.doesNotMatch(
      JSON.stringify(result.body),
      /must-never-leave-server|"user"/,
    );
    assert.doesNotMatch(
      JSON.stringify([...cache.values()]),
      /must-never-leave-server|"user"/,
    );
  });
}

test('gate, method, route and query validation run before quota, cache or upstream', async () => {
  const cache = new Map();
  let calls = 0;
  const request = install({
    cache,
    fetchImpl: async () => {
      calls += 1;
      return Response.json(envelope());
    },
  });
  for (let i = 0; i < 32; i += 1) {
    const response = await request('/observations?scope=global', {
      headers: {
        host: 'localhost:5173',
        origin: 'https://foreign.example',
        'sec-fetch-site': 'cross-site',
      },
    });
    assert.equal(response.status, 403);
  }
  const method = await request('/observations', { method: 'POST' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.Allow, 'GET');
  for (const route of ['/', '/unknown', '/observations/extra', '//[invalid'])
    assert.equal((await request(route)).body.error, 'unknown_route');
  assert.equal(
    (await request('/observations?scope=planet')).body.error,
    'invalid_scope',
  );
  for (const query of [
    '',
    'south=NaN&west=0&north=1&east=1',
    'south=&west=0&north=1&east=1',
    'south=0&west=0&north=0&east=1',
    'south=0&west=1&north=1&east=0',
    'south=-91&west=0&north=1&east=1',
    'south=0&west=-181&north=1&east=1',
    'south=0&west=0&north=41&east=1',
    'south=0&west=0&north=1&east=41',
  ]) {
    const result = await request(`/observations?${query}`);
    assert.equal(result.status, 400, query);
    assert.equal(result.body.error, 'invalid_bbox', query);
  }
  assert.equal(cache.size, 0);
  assert.equal(calls, 0);
  const allowed = await request('/observations?scope=global', {
    headers: {
      host: 'gev.example',
      origin: 'https://gev.example',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.9',
    },
  });
  assert.equal(allowed.status, 200);
});

test('cached requests never exhaust a local request admission limiter', async () => {
  let calls = 0;
  const request = install({
    fetchImpl: async () => {
      calls += 1;
      return Response.json(envelope());
    },
  });
  for (let i = 0; i < 30; i += 1) assert.equal((await request()).status, 200);
  const cached = await request();
  assert.equal(cached.status, 200);
  assert.equal(cached.headers['Retry-After'], undefined);
  assert.equal(calls, 1);
});

test('proxy rejects oversized snapped spans before acquisition and preserves canonical client boxes', async () => {
  const urls = [];
  const request = install({
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return Response.json(envelope());
    },
  });
  for (const query of [
    'south=10.2&west=0&north=50.1&east=1',
    'south=0&west=10.2&north=1&east=50.1',
  ]) {
    const result = await request(`/observations?${query}`);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid_bbox');
  }
  assert.equal(urls.length, 0);
  const canonical =
    '/observations?south=47.4&west=-122.3&north=47.6&east=-122.1';
  const first = await request(canonical);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.box, {
    south: 47.4,
    west: -122.3,
    north: 47.6,
    east: -122.1,
  });
  assert.equal(urls[0].searchParams.get('swlat'), '47.4');
  assert.equal(urls[0].searchParams.get('swlng'), '-122.3');
  const second = await request(canonical);
  assert.deepEqual(second.body, first.body);
  assert.equal(urls.length, 1, 'canonical boxes share their cache key');
});

test('view snapping, whales, research and global queries obey the requested policy', async () => {
  const urls = [];
  const request = install({
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return Response.json(envelope());
    },
  });
  await request(
    '/observations?south=40.2&west=-123.7&north=46.1&east=-121.4&quality=research&taxa=Aves',
  );
  assert.equal(urls[0].searchParams.get('swlat'), '40');
  assert.equal(urls[0].searchParams.get('nelat'), '47');
  assert.equal(urls[0].searchParams.get('per_page'), '200');
  assert.equal(urls[0].searchParams.get('quality_grade'), 'research');
  assert.equal(urls[0].searchParams.get('iconic_taxa'), 'Aves');
  await request(boxUrl(0, '&taxa=whales'));
  const whales = urls[1].searchParams;
  assert.equal(whales.get('taxon_id'), '152871');
  assert.equal(whales.get('d1'), '2026-10-28');
  assert.equal(whales.has('created_d1'), false);
  assert.equal(whales.has('photos'), false);
  assert.equal(whales.has('iconic_taxa'), false);
  await request('/observations?scope=global&quality=typo&taxa=typo&south=bad');
  const global = urls[2].searchParams;
  for (const field of [
    'swlat',
    'swlng',
    'nelat',
    'nelng',
    'quality_grade',
    'iconic_taxa',
  ])
    assert.equal(global.has(field), false, field);
  assert.equal(global.get('per_page'), '200');
  assert.equal(global.get('d1'), '2026-11-02');
  assert.equal(global.has('created_d1'), false);
  assert.equal(global.get('order_by'), 'observed_on');
  assert.equal(global.get('order'), 'desc');
  await request('/observations?scope=global&taxa=whales');
  const globalWhales = urls[3].searchParams;
  assert.equal(globalWhales.get('d1'), '2026-10-28');
  assert.equal(globalWhales.has('created_d1'), false);
  assert.equal(globalWhales.get('order_by'), 'observed_on');
  assert.equal(globalWhales.get('order'), 'desc');
});

test('fresh cache hits and global ten-minute TTL spend no upstream quota', async () => {
  let at = NOW;
  let calls = 0;
  const request = install({
    now: () => at,
    fetchImpl: async () => {
      calls += 1;
      return Response.json(envelope());
    },
  });
  const first = await request();
  at += 299_999;
  assert.deepEqual((await request()).body, first.body);
  at += 1;
  await request();
  assert.equal(calls, 2);
  await request('/observations?scope=global');
  at += 599_999;
  await request('/observations?scope=global');
  assert.equal(calls, 3);
  at += 1;
  await request('/observations?scope=global');
  assert.equal(calls, 4);
});

test('the same snapped view and window hour returns one cached random sample until expiry', async () => {
  let at = NOW;
  let draws = 0;
  const cache = new Map();
  const request = install({
    cache,
    now: () => at,
    fetchImpl: async (url) => {
      const query = new URL(url).searchParams;
      assert.equal(query.get('order_by'), 'random');
      assert.equal(query.get('per_page'), '200');
      return Response.json(envelope([observation(++draws)]));
    },
  });
  const first = await request();
  for (const elapsed of [1, 1000, 60_000, 299_999]) {
    at = NOW + elapsed;
    const next = await request();
    assert.deepEqual(next.body, first.body);
  }
  assert.equal(draws, 1);
  assert.match(cache.keys().next().value, /2026-11-02T18:00:00Z$/);
  at = NOW + 300_000;
  const refresh = await request();
  assert.equal(refresh.body.rows[0].stableId, 'inat:2');
  assert.equal(draws, 2);
});

test('disconnected queued views are dropped while a remaining coalesced consumer keeps its request', async () => {
  const calls = [];
  const releases = [];
  const cache = new Map();
  const request = install({
    cache,
    fetchImpl: (url, { signal }) => {
      calls.push({ url: new URL(url), signal });
      return new Promise((resolve) => releases.push(resolve));
    },
  });
  const first = request(boxUrl(0));
  await until(() => releases.length === 1);
  const superseded = new AbortController();
  const oldView = request(boxUrl(1), { signal: superseded.signal });
  const oneConsumer = new AbortController();
  const one = request(boxUrl(2), { signal: oneConsumer.signal });
  const other = request(boxUrl(2));
  superseded.abort();
  oneConsumer.abort();
  await Promise.all([oldView, one]);
  // Rejoining the abandoned key creates a healthy generation; the old
  // coalescing promise must not later delete or cancel this replacement.
  const replacement = request(boxUrl(1));
  releases[0](Response.json(envelope()));
  await until(() => releases.length === 2);
  assert.equal(calls[1].url.searchParams.get('swlng'), '-122.1');
  assert.equal(calls[1].signal.aborted, false);
  releases[1](Response.json(envelope([observation(2)])));
  await until(() => releases.length === 3);
  assert.equal(calls[2].url.searchParams.get('swlng'), '-122.3');
  releases[2](Response.json(envelope([observation(3)])));
  const results = await Promise.all([first, other, replacement]);
  assert.ok(results.every((result) => result.status === 200));
  assert.equal(
    calls.length,
    3,
    'the abandoned queued generation never dispatched',
  );
  assert.equal(cache.size, 3);
  assert.equal(results[1].body.rows[0].stableId, 'inat:2');
  assert.equal(results[2].body.rows[0].stableId, 'inat:3');
});

test('observation windows reject old sightings uploaded today and keep recent observations', async () => {
  for (const [taxa, recentTime, expectedD1] of [
    ['all', '2026-11-04T17:00:00Z', '2026-11-02'],
    ['whales', '2026-10-30T17:00:00Z', '2026-10-28'],
  ]) {
    let upstreamQuery;
    const request = install({
      fetchImpl: async (url) => {
        upstreamQuery = new URL(url).searchParams;
        return Response.json(
          envelope([
            {
              ...observation(80),
              time_observed_at: '2010-06-01T12:00:00Z',
              observed_on: '2010-06-01',
            },
            {
              ...observation(81),
              time_observed_at: recentTime,
              observed_on: recentTime.slice(0, 10),
            },
          ]),
        );
      },
    });
    const result = await request(boxUrl(0, `&taxa=${taxa}`));
    assert.equal(result.status, 200, taxa);
    assert.equal(upstreamQuery.get('d1'), expectedD1);
    assert.equal(upstreamQuery.has('created_d1'), false);
    assert.equal(upstreamQuery.get('order_by'), 'random');
    assert.deepEqual(
      result.body.rows.map((row) => row.stableId),
      ['inat:81'],
    );
  }
});

test('same-key requests single-flight and a seventeenth distinct in-flight key queues', async () => {
  const releases = [];
  const request = install({
    fetchImpl: () => new Promise((resolve) => releases.push(resolve)),
  });
  const a = request();
  const b = request();
  await until(() => releases.length === 1);
  releases.shift()(Response.json(envelope()));
  assert.deepEqual((await a).body, (await b).body);
  const pending = Array.from({ length: 16 }, (_, i) => request(boxUrl(i + 1)));
  await until(() => releases.length === 1);
  pending.push(request(boxUrl(18)));
  for (let i = 0; i < 17; i += 1) {
    await until(() => releases.length > i);
    releases[i](Response.json(envelope()));
  }
  assert.ok((await Promise.all(pending)).every(({ status }) => status === 200));
});

test('a fresh global sample survives the hourly observation-window rollover without another fetch', async () => {
  let at = Date.parse('2026-11-04T18:59:00Z');
  let calls = 0;
  const request = install({
    now: () => at,
    fetchImpl: async () => {
      calls += 1;
      return Response.json(envelope());
    },
  });
  const first = await request('/observations?scope=global');
  at += 60_000;
  const nextHour = await request('/observations?scope=global');
  assert.deepEqual(nextHour.body, first.body);
  assert.equal(nextHour.body.stale, undefined);
  assert.equal(calls, 1);
  at += 9 * 60_000;
  await request('/observations?scope=global');
  assert.equal(calls, 2);
});

test('pending global refresh coalesces across the hourly observation-window rollover with a busy queue', async () => {
  let at = Date.parse('2026-11-04T18:59:59Z');
  const releases = [];
  const cache = new Map();
  const request = install({
    cache,
    now: () => at,
    fetchImpl: (url) =>
      new Promise((resolve) =>
        releases.push({
          resolve,
          url: new URL(url),
        }),
      ),
  });
  const first = request(
    '/observations?scope=global&quality=research&taxa=Aves',
  );
  const views = Array.from({ length: 15 }, (_, i) => request(boxUrl(i)));
  await until(() => releases.length === 1);
  assert.equal(releases[0].url.searchParams.get('d1'), '2026-11-02');
  at = Date.parse('2026-11-04T19:00:01Z');
  const nextHour = request(
    '/observations?scope=global&quality=research&taxa=Aves',
  );
  await new Promise(setImmediate);
  assert.equal(
    releases.length,
    1,
    'the same global query joins the pending refresh',
  );
  const distinct = request(
    '/observations?scope=global&quality=research&taxa=Mammalia',
  );
  for (let i = 0; i < 17; i += 1) {
    await until(() => releases.length > i);
    releases[i].resolve(Response.json(envelope()));
  }
  const [original, joined] = await Promise.all([first, nextHour]);
  assert.equal(original.status, 200);
  assert.equal((await distinct).status, 200);
  assert.deepEqual(joined.body, original.body);
  assert.ok((await Promise.all(views)).every(({ status }) => status === 200));
  const globalEntries = [...cache.entries()].filter(
    ([, entry]) => entry.value.scope === 'global',
  );
  assert.equal(globalEntries.length, 2);
  assert.match(globalEntries[0][0], /2026-11-02T18:00:00Z$/);
  assert.equal(
    (await request('/observations?scope=global&quality=research&taxa=Aves'))
      .status,
    200,
  );
  assert.equal(
    releases.length,
    17,
    'the accepted global answer keeps its ten-minute freshness',
  );
});

test('view refreshes retain distinct hourly keys while a previous-hour request is pending', async () => {
  let at = Date.parse('2026-11-04T18:59:59Z');
  const releases = [];
  const request = install({
    now: () => at,
    fetchImpl: () => new Promise((resolve) => releases.push(resolve)),
  });
  const first = request();
  await until(() => releases.length === 1);
  at = Date.parse('2026-11-04T19:00:01Z');
  const nextHour = request();
  await new Promise(setImmediate);
  assert.equal(
    releases.length,
    1,
    'the next view queues behind the current call',
  );
  releases[0](Response.json(envelope()));
  await until(() => releases.length === 2);
  releases[1](Response.json(envelope()));
  assert.ok(
    (await Promise.all([first, nextHour])).every(
      ({ status }) => status === 200,
    ),
  );
});

test('upstream minute ceiling waits for request 61 across client addresses', async () => {
  let at = NOW;
  let calls = 0;
  const request = install({
    now: () => at,
    queueOptions: {
      now: () => at,
      intervalMs: 0,
      wait: async (ms) => {
        at += ms;
      },
    },
    fetchImpl: async () => {
      calls += 1;
      return Response.json(envelope());
    },
  });
  for (let i = 0; i < 60; i += 1)
    assert.equal(
      (await request(boxUrl(i), { peer: `10.0.0.${i}` })).status,
      200,
    );
  const queued = await request(boxUrl(60), { peer: '10.0.1.1' });
  assert.equal(queued.status, 200);
  assert.equal(queued.headers['Retry-After'], undefined);
  assert.equal(at, NOW + 60_000);
  assert.equal(calls, 61);
});

test('views refresh after many prior requests without fabricating an upstream limit', async () => {
  let at = NOW;
  let calls = 0;
  const request = install({
    now: () => at,
    fetchImpl: async () => {
      calls += 1;
      return Response.json(envelope());
    },
  });
  const first = await request();
  at += 300_001;
  for (let i = 1; i <= 60; i += 1)
    await request(boxUrl(i), { peer: `10.0.0.${i}` });
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, undefined);
  assert.notEqual(stale.body.fetchedAt, first.body.fetchedAt);
  assert.equal(calls, 62);
});

test('bounded samples preserve partial metadata, and well-formed empty views are valid', async () => {
  let at = NOW;
  let fail = false;
  const request = install({
    now: () => at,
    fetchImpl: async () =>
      fail
        ? new Response('unavailable', { status: 503 })
        : Response.json(envelope([observation()], 500)),
  });
  const first = await request();
  assert.equal(first.body.partial, true);
  assert.equal(first.body.rawRowCount, 500);
  fail = true;
  at += 59 * 60_000;
  const stale = await request();
  assert.equal(
    stale.status,
    200,
    'hourly window changes still permit stale fallback',
  );
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.fetchedAt, first.body.fetchedAt);
  assert.equal(stale.body.partial, true);
  at += 2 * 60_000;
  const expired = await request();
  assert.equal(expired.status, 502);
  assert.equal(expired.body.error, 'inaturalist_unavailable');
  const empty = install({
    fetchImpl: async () => Response.json(envelope([], 0)),
  });
  const result = await empty();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.rows, []);
});

test('bad envelopes, JSON and capped bodies fail closed without inventing a cooldown', async () => {
  for (const bad of [
    () => Response.json({ total_results: 1, results: {} }),
    () => Response.json({ total_results: 1, observations: [observation()] }),
    () => Response.json({ total_results: '1', results: [observation()] }),
    () => Response.json(envelope([], 1)),
    () => Response.json(envelope([{ ...observation(), id: null }], 1)),
    () => new Response('{malformed'),
    () =>
      new Response('{}', {
        headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) },
      }),
  ]) {
    let at = NOW;
    let calls = 0;
    const request = install({
      now: () => at,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? bad() : Response.json(envelope());
      },
    });
    const first = await request();
    assert.equal(first.status, 502);
    assert.equal(first.body.error, 'inaturalist_unavailable');
    assert.equal(first.headers['Retry-After'], undefined);
    assert.equal((await request(boxUrl(1))).status, 200);
    assert.equal(calls, 2);
  }
});

test('a wholly invalid iNat page cannot replace a previously valid snapshot', async () => {
  let at = NOW;
  let fail = false;
  const cache = new Map();
  const request = install({
    cache,
    now: () => at,
    fetchImpl: async () =>
      Response.json(
        fail
          ? envelope([{ ...observation(), quality_grade: 'casual' }])
          : envelope(),
      ),
  });
  const first = await request();
  const original = cache.values().next().value;
  fail = true;
  at += 300_001;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.fetchedAt, first.body.fetchedAt);
  assert.equal(cache.values().next().value, original);
});

test('429 cooldown honors seconds, HTTP dates, and long upstream deadlines', async () => {
  assert.equal(inatRetryCooldownMs(null, NOW), 60_000);
  assert.equal(inatRetryCooldownMs('0', NOW), 0);
  assert.equal(inatRetryCooldownMs('2', NOW), 2000);
  assert.equal(inatRetryCooldownMs('999999', NOW), 999_999_000);
  assert.equal(inatRetryCooldownMs('7200', NOW), 7_200_000);
  assert.equal(
    inatRetryCooldownMs(new Date(NOW + 7_200_000).toUTCString(), NOW),
    7_200_000,
  );
  let at = NOW;
  const releases = [];
  const warnings = [];
  const request = install({
    now: () => at,
    warn: (message) => warnings.push(message),
    fetchImpl: () => new Promise((resolve) => releases.push(resolve)),
  });
  const first = request();
  const later = request(boxUrl(1));
  await until(() => releases.length === 1);
  releases[0](
    new Response('limit', {
      status: 429,
      headers: { 'Retry-After': '999999' },
    }),
  );
  assert.equal((await first).headers['Retry-After'], '999999');
  assert.equal((await later).headers['Retry-After'], '999999');
  at += 1000;
  assert.equal((await request(boxUrl(1))).headers['Retry-After'], '999998');
  at += 5000;
  const cooling = await request(boxUrl(2));
  assert.equal(cooling.status, 429);
  assert.equal(cooling.headers['Retry-After'], '999993');
  assert.equal(
    releases.length,
    1,
    'queued calls do not dispatch during cooldown',
  );
  assert.equal(
    warnings.filter((message) => message.includes('capped')).length,
    0,
  );
});

for (const [upstreamStatus, expectedStatus, code, retryAfterS] of [
  [429, 429, 'inaturalist_rate_limited', 120],
  [503, 502, 'inaturalist_unavailable', 120],
]) {
  test(`concurrent reservations honor an immediate upstream ${upstreamStatus} before dispatch`, async () => {
    let calls = 0;
    const warnings = [];
    const client = createInatClient({
      now: () => 0,
      cacheDir: null,
      queueOptions: { intervalMs: 0 },
      warn: (message) => warnings.push(message),
      fetchImpl: async () => {
        calls += 1;
        return new Response('synthetic failure', {
          status: upstreamStatus,
          headers: { 'Retry-After': '120' },
        });
      },
    });
    const params = {
      scope: 'global',
      quality: 'all',
      taxa: 'all',
      observedD1: '1969-12-30',
    };
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => client.getObservations(params)),
    );
    assert.equal(
      calls,
      1,
      'pending reservations must not dispatch during cooldown',
    );
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason.status, expectedStatus);
      assert.equal(result.reason.code, code);
      assert.equal(result.reason.retryAfterS, retryAfterS);
    }
    assert.equal(
      warnings.length,
      1,
      'only the dispatched refresh logs a failure',
    );
    await assert.rejects(client.getObservations(params), {
      status: expectedStatus,
      code,
      retryAfterS,
    });
    assert.equal(calls, 1);
  });
}

test('budget is read lazily, persisted as counters only, enforced across restart and UTC rollover', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'gev-inat-budget-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const cacheDir = path.join(parent, 'not-created');
  const before = process.env.INATURALIST_DAILY_BUDGET;
  process.env.INATURALIST_DAILY_BUDGET = '2';
  t.after(() =>
    before === undefined
      ? delete process.env.INATURALIST_DAILY_BUDGET
      : (process.env.INATURALIST_DAILY_BUDGET = before),
  );
  let at = NOW;
  let calls = 0;
  const options = {
    now: () => at,
    cacheDir,
    warn() {},
    fetchImpl: async () => {
      calls += 1;
      return Response.json(envelope());
    },
  };
  const client = createInatClient(options);
  assert.deepEqual(
    await readdir(parent),
    [],
    'construction performs no directory write',
  );
  const params = {
    scope: 'global',
    quality: 'all',
    taxa: 'all',
    observedD1: '2026-11-02',
  };
  await Promise.all([
    client.getObservations(params),
    client.getObservations(params),
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(cacheDir, 'budget.json'), 'utf8')),
    { date: '2026-11-04', count: 2 },
  );
  assert.deepEqual(
    await readdir(cacheDir),
    ['budget.json'],
    'atomic temporary files are retired',
  );
  const restarted = createInatClient(options);
  await assert.rejects(restarted.getObservations(params), {
    status: 503,
    code: 'inaturalist_budget_exhausted',
  });
  assert.equal(calls, 2);
  at = Date.parse('2026-11-05T00:00:00Z');
  await restarted.getObservations(params);
  assert.deepEqual(restarted.budgetState(), {
    date: '2026-11-05',
    count: 1,
    budget: 2,
  });
  assert.deepEqual(
    JSON.parse(await readFile(path.join(cacheDir, 'budget.json'), 'utf8')),
    { date: '2026-11-05', count: 1 },
  );
  assert.equal(calls, 3);
});

test('memory cache is an LRU bounded to 400 projected entries', async () => {
  let at = NOW;
  const cache = new Map();
  const request = install({
    cache,
    now: () => at,
    fetchImpl: async () => Response.json(envelope()),
  });
  for (let i = 0; i < 400; i += 1) {
    if (i && i % 20 === 0) at += 61_000;
    await request(boxUrl(i), { peer: String(i) });
  }
  assert.equal(cache.size, 400);
  const firstKey = cache.keys().next().value;
  const secondKey = [...cache.keys()][1];
  await request(boxUrl(0));
  await request(boxUrl(400));
  assert.equal(cache.size, 400);
  assert.equal(cache.has(firstKey), true);
  assert.equal(cache.has(secondKey), false);
});

test('aborted client calls spend no budget and never fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = createInatClient({
    now: () => NOW,
    cacheDir: null,
    queueOptions: { intervalMs: 0 },
    fetchImpl: () => assert.fail('aborted call fetched'),
  });
  await assert.rejects(
    client.getObservations({}, { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(client.budgetState().count, 0);
});
