// The Rail source names a registered feed id and nothing else: the catalog
// route, the per-feed train route with the id encoded as one path segment,
// and the caller's abort signal at every await.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRailSource } from './source.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const isAbort = (error) => error?.name === 'AbortError';

test('the feed catalog is read from the public catalog route', async () => {
  const requested = [];
  const feeds = [
    {
      id: 'mbta-rail',
      name: 'MBTA',
      center: { lat: 42.36, lon: -71.06 },
      loadRadiusKm: 110,
    },
  ];
  const source = createRailSource({
    fetchImpl: async (url, init) => {
      requested.push({ url, accept: init.headers.Accept });
      return json({ feeds });
    },
  });
  assert.deepEqual(await source.getFeeds(), feeds);
  assert.deepEqual(requested, [
    { url: '/api/rail/feeds', accept: 'application/json' },
  ]);
});

test('feed catalog failures are reported', async () => {
  const failing = createRailSource({ fetchImpl: async () => json({}, 503) });
  await assert.rejects(failing.getFeeds(), /Rail feeds HTTP 503/);
  const malformed = createRailSource({
    fetchImpl: async () => json({ feeds: {} }),
  });
  await assert.rejects(malformed.getFeeds(), /Malformed rail feed catalog/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    createRailSource({
      fetchImpl: async () => json({ feeds: [] }),
    }).getFeeds({ signal: aborted.signal }),
    isAbort,
  );
});

test('a snapshot is requested from the train route for that feed', async () => {
  const requested = [];
  const snapshot = { feedId: 'mta-lirr', count: 0, dropped: 3, trains: [] };
  const controller = new AbortController();
  const source = createRailSource({
    fetchImpl: async (url, init) => {
      requested.push({
        url,
        signal: init.signal,
        accept: init.headers.Accept,
      });
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { 'X-GEV-Cache': 'HIT', 'X-Rail-Contact': '1794000000000' },
      });
    },
  });
  const response = await source.requestSnapshot('mta-lirr', {
    signal: controller.signal,
  });
  assert.deepEqual(requested, [
    {
      url: '/api/rail/trains/mta-lirr',
      signal: controller.signal,
      accept: 'application/json',
    },
  ]);
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-gev-cache'), 'HIT');
  assert.equal(response.headers.get('x-rail-contact'), '1794000000000');
  assert.deepEqual(await response.json(), snapshot);
});

test('path packs are requested from the paths route with the same wrapper', async () => {
  const requested = [];
  const pack = { version: 1, feedId: 'grt-ion', shapes: [] };
  const source = createRailSource({
    fetchImpl: async (url) => {
      requested.push(url);
      return new Response(JSON.stringify(pack), { status: 200 });
    },
  });
  const response = await source.requestPaths('grt-ion');
  assert.deepEqual(requested, ['/api/rail/paths/grt-ion']);
  assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), pack);
  assert.throws(() => source.requestPaths(''), TypeError);
});

test('the feed id is encoded as a single path segment', async () => {
  const requested = [];
  const source = createRailSource({
    fetchImpl: async (url) => {
      requested.push(url);
      return json({}, 404);
    },
  });
  const response = await source.requestSnapshot('../feeds?x=1 #');
  assert.equal(response.ok, false);
  assert.equal(response.status, 404);
  assert.deepEqual(requested, ['/api/rail/trains/..%2Ffeeds%3Fx%3D1%20%23']);
});

test('a missing, non-string or oversized feed id is refused', () => {
  let calls = 0;
  const source = createRailSource({
    fetchImpl: async () => {
      calls += 1;
      return json({});
    },
  });
  for (const id of ['', undefined, null, 42, {}, 'a'.repeat(161)]) {
    assert.throws(
      () => source.requestSnapshot(id),
      { name: 'TypeError', message: 'A rail feed identifier is required' },
      String(id).slice(0, 12),
    );
  }
  assert.doesNotThrow(() => source.requestSnapshot('a'.repeat(160)));
  assert.equal(calls, 1);
});

test('an already aborted request never reaches the network', () => {
  let calls = 0;
  const source = createRailSource({
    fetchImpl: async () => {
      calls += 1;
      return json({});
    },
  });
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => source.requestSnapshot('mbta-rail', { signal: controller.signal }),
    isAbort,
  );
  assert.equal(calls, 0);
});

test('an abort while the response is in flight rejects the snapshot', async () => {
  const controller = new AbortController();
  const source = createRailSource({
    fetchImpl: async () => {
      controller.abort();
      return json({ trains: [] });
    },
  });
  await assert.rejects(
    source.requestSnapshot('mbta-rail', { signal: controller.signal }),
    isAbort,
  );
});

test('an abort while the body is read rejects the parsed snapshot', async () => {
  const controller = new AbortController();
  const source = createRailSource({
    fetchImpl: async () => json({ trains: [] }),
  });
  const response = await source.requestSnapshot('mbta-rail', {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(response.json(), isAbort);
});

test('timetables and trip updates use the same per-feed wrapper', async () => {
  const requested = [];
  const source = createRailSource({
    fetchImpl: async (url, init) => {
      requested.push([url, init.headers.Accept]);
      return url.includes('/schedule/')
        ? json({ error: 'No rail schedule' }, 404)
        : json({ trips: [{ tripId: 't1', delaySec: 120 }] });
    },
  });
  const schedule = await source.requestSchedule('mbta-rail');
  assert.equal(schedule.ok, false);
  assert.equal(schedule.status, 404);
  const updates = await source.requestUpdates('mbta-rail');
  assert.equal(updates.ok, true);
  assert.deepEqual(await updates.json(), {
    trips: [{ tripId: 't1', delaySec: 120 }],
  });
  assert.deepEqual(requested, [
    ['/api/rail/schedule/mbta-rail', 'application/json'],
    ['/api/rail/updates/mbta-rail', 'application/json'],
  ]);
  assert.throws(() => source.requestSchedule(''), TypeError);
  assert.throws(() => source.requestUpdates(42), TypeError);
});
