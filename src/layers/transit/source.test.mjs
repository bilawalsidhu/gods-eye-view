import assert from 'node:assert/strict';
import test from 'node:test';
import { createTransitSource } from './source.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('the feed catalog is read from the public catalog route', async () => {
  const requested = [];
  const feeds = [
    {
      id: 'mbta',
      name: 'MBTA',
      center: { lat: 42.36, lon: -71.06 },
      loadRadiusKm: 60,
    },
  ];
  const source = createTransitSource({
    fetchImpl: async (url) => {
      requested.push(url);
      return json({ feeds });
    },
  });
  assert.deepEqual(await source.getFeeds(), feeds);
  assert.deepEqual(requested, ['/api/transit/feeds']);
});

test('feed catalog failures are reported', async () => {
  const failing = createTransitSource({ fetchImpl: async () => json({}, 503) });
  await assert.rejects(failing.getFeeds(), /Transit feeds HTTP 503/);
  const malformed = createTransitSource({
    fetchImpl: async () => json({ feeds: {} }),
  });
  await assert.rejects(malformed.getFeeds(), /Malformed transit feed catalog/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    createTransitSource({
      fetchImpl: async () => json({ feeds: [] }),
    }).getFeeds({ signal: aborted.signal }),
    (error) => error.name === 'AbortError',
  );
});

test('the French passenger-station catalogue is read from the local proxy route', async () => {
  const requested = [];
  const source = createTransitSource({
    fetchImpl: async (url) => {
      requested.push(url);
      return json({
        total: 1,
        stations: [
          {
            id: 'a',
            name: 'Paris Gare du Nord',
            shortCode: 'PV',
            uic: '87747006',
            lon: 2.3553,
            lat: 48.8809,
            segment: 'A',
          },
        ],
      });
    },
  });
  const snapshot = await source.getStations();
  assert.equal(requested.length, 1);
  // The browser names a route, never an upstream URL.
  assert.match(requested[0], /^\/api\/sncf\/stations$/);
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.stations.length, 1);
  assert.equal(snapshot.stations[0].name, 'Paris Gare du Nord');
  assert.equal(snapshot.stations[0].segment, 'A');
});

test('a station catalogue failure is reported rather than swallowed', async () => {
  const failing = createTransitSource({ fetchImpl: async () => json({}, 503) });
  await assert.rejects(failing.getStations(), /SNCF stations HTTP 503/);
  const malformed = createTransitSource({
    fetchImpl: async () => json({ stations: 'nope' }),
  });
  await assert.rejects(malformed.getStations(), /Malformed station response/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    createTransitSource({
      fetchImpl: async () => json({ stations: [] }),
    }).getStations({ signal: aborted.signal }),
    (error) => error.name === 'AbortError',
  );
});
