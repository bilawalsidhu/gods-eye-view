import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeedsFromSystems,
  buildFeedsFromStations,
  fallbackCoordinates,
  isPublicSafetySystem,
  isScannerStation,
  placeQueries,
  systemCoordinates,
} from '../../../scripts/import-openmhz-systems.mjs';

test('coordinates are read from common field shapes and bad ones rejected', () => {
  assert.deepEqual(systemCoordinates({ lat: '30.2', lng: '-97.7' }), { lat: 30.2, lon: -97.7 });
  assert.deepEqual(
    systemCoordinates({ location: { coordinates: [-97.7, 30.2] } }),
    { lat: 30.2, lon: -97.7 },
  );
  assert.equal(systemCoordinates({ lat: 0, lon: 0 }), null);
  assert.equal(systemCoordinates({ lat: 120, lon: 0 }), null);
  assert.equal(systemCoordinates({}), null);
});

test('only police-like systems are imported, deduplicated, and geocoded politely', async () => {
  const sleeps = [];
  const queries = [];
  const feeds = await buildFeedsFromSystems(
    {
      systems: [
        { shortName: 'aus_pd', name: 'Austin Police', city: 'Austin', state: 'TX' },
        { shortName: 'bus', name: 'City Buses', lat: 1, lon: 2 },
        { shortName: 'co_so', name: 'County Sheriff', lat: 40, lon: -105 },
        { shortName: 'seen_pd', name: 'Seen Police', lat: 1, lon: 1 },
        { shortName: 'nowhere_pd', name: 'Nowhere Police' },
      ],
    },
    {
      existingIds: new Set(['openmhz-seen-pd']),
      sleep: async (ms) => sleeps.push(ms),
      fetchImpl: async (url) => {
        queries.push(String(url));
        return new Response(JSON.stringify([{ lat: '30.27', lon: '-97.74' }]));
      },
    },
  );
  assert.deepEqual(
    feeds.map((feed) => [feed.id, feed.lat, feed.lon, feed.type, feed.system]),
    [
      ['openmhz-aus-pd', 30.27, -97.74, 'openmhz', 'aus_pd'],
      ['openmhz-co-so', 40, -105, 'openmhz', 'co_so'],
    ],
  );
  assert.deepEqual(sleeps, [1100]);
  assert.match(queries[0], /q=Austin%2C%20Texas%2C%20USA/);
  assert.equal(isPublicSafetySystem({ name: 'Transit' }), false);
});

test('scanner stations are recognised and music "police" stations rejected', () => {
  assert.equal(isScannerStation({ name: 'Madrid Policía Scanner', tags: 'scanner' }), true);
  assert.equal(isScannerStation({ name: 'Sheriff Dispatch', tags: '' }), true);
  assert.equal(isScannerStation({ name: 'The Police Radio', tags: 'rock,sting,80s' }), false);
  assert.equal(isScannerStation({ name: 'Jazz FM', tags: 'jazz' }), false);
});

test('stations become stream feeds, with geocoding cached per place', async () => {
  const queries = [];
  const feeds = await buildFeedsFromStations(
    [
      { stationuuid: 'aaaaaa-1', name: 'City Police Scanner', tags: 'scanner', url_resolved: 'https://s.example.test/a.mp3', geo_lat: 51.5, geo_long: -0.12, country: 'UK' },
      { stationuuid: 'aaaaaa-1', name: 'duplicate uuid', tags: 'scanner', url_resolved: 'https://s.example.test/dup.mp3', geo_lat: 1, geo_long: 1 },
      { stationuuid: 'bbbbbb-2', name: 'Texas Sheriff', tags: 'scanner', url_resolved: 'http://s.example.test/b.mp3', state: 'Texas', country: 'USA' },
      { stationuuid: 'cccccc-3', name: 'Texas Police 2', tags: 'police', url_resolved: 'http://s.example.test/c.mp3', state: 'Texas', country: 'USA' },
      { stationuuid: 'dddddd-4', name: 'Bad Scheme Police', tags: 'police', url_resolved: 'ftp://x/y', geo_lat: 5, geo_long: 5 },
    ],
    {
      sleep: async () => {},
      geocodeFn: async (query) => {
        queries.push(query);
        return { lat: 31, lon: -99 };
      },
    },
  );
  assert.deepEqual(
    feeds.map((feed) => [feed.name, feed.type, feed.lat, feed.url]),
    [
      ['City Police Scanner', 'stream', 51.5, 'https://s.example.test/a.mp3'],
      ['Texas Sheriff', 'stream', 31, 'http://s.example.test/b.mp3'],
      ['Texas Police 2', 'stream', 31, 'http://s.example.test/c.mp3'],
    ],
  );
  assert.deepEqual(queries, ['Texas, USA']);
  assert.ok(feeds.every((feed) => /^[a-z0-9][a-z0-9-]*$/.test(feed.id)));
});

test('non-English police names match, and fire/EMS only with the public-safety flag', () => {
  assert.equal(isScannerStation({ name: 'Radio Polizei Berlin', tags: '' }), true);
  assert.equal(isScannerStation({ name: '警察廣播電臺', tags: '' }), true);
  assert.equal(isScannerStation({ name: 'Bomberos Madrid', tags: '' }), false);
  assert.equal(isScannerStation({ name: 'Bomberos Madrid', tags: '' }, { publicSafety: true }), true);
});

test('place queries handle city, county-only, statewide and international systems', () => {
  assert.deepEqual(placeQueries({ city: 'Chicago', state: 'IL', county: 'Cook' }), [
    'Chicago, Illinois, USA',
    'Cook County, Illinois, USA',
    'Illinois, USA',
  ]);
  assert.deepEqual(placeQueries({ county: 'Outagamie and Winnebago', state: 'WI' }), [
    'Outagamie County, Wisconsin, USA',
    'Wisconsin, USA',
  ]);
  assert.deepEqual(placeQueries({ city: 'Morris Co', state: 'NJ' }), [
    'Morris County, New Jersey, USA',
    'New Jersey, USA',
  ]);
  assert.deepEqual(placeQueries({ country: 'Australia', state: undefined }), ['Australia']);
});

test('unlocatable systems get a stable approximate position, never dropped silently', async () => {
  const a = fallbackCoordinates({ shortName: 'x1', state: 'MN' });
  const b = fallbackCoordinates({ shortName: 'x2', state: 'MN' });
  assert.deepEqual(a, fallbackCoordinates({ shortName: 'x1', state: 'MN' }));
  assert.notDeepEqual(a, b);
  assert.ok(Math.abs(a.lat - 46.3) < 1 && Math.abs(a.lon + 94.3) < 1);
  assert.equal(fallbackCoordinates({ state: 'ZZ' }), null);
  const feeds = await buildFeedsFromSystems(
    {
      systems: [
        { shortName: 'live', name: 'County Sheriff', county: 'Rice', state: 'MN', active: true },
        { shortName: 'live', name: 'County Sheriff dup', county: 'Rice', state: 'MN', active: true },
        { shortName: 'dead', name: 'Old Police', state: 'MN', active: false },
        { shortName: 'ca', name: 'Ontario Police', country: 'Canada', active: true },
      ],
    },
    { useGeocoder: false },
  );
  assert.deepEqual(
    feeds.map((feed) => feed.system),
    ['live', 'ca'],
  );
  assert.equal(feeds[0].agency, 'Rice, MN');
});