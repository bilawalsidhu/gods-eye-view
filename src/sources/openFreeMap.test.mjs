import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decodeOpenFreeMapTile,
  openMapRoad,
  polygonCentroid,
  clipTileLine,
  createOpenFreeMapSource,
} from './openFreeMap.js';
import { createVectorTileSource } from './vectorTiles.js';
const fixture = (name) =>
  readFileSync(new URL(`../data/fixtures/${name}`, import.meta.url));

test('real z14 and z12 Austin tiles decode only drivable roads', () => {
  for (const [z, x, y, name] of [
    [14, 3743, 6745, 'ofm-austin-14-3743-6745.pbf'],
    [12, 935, 1686, 'ofm-austin-12-935-1686.pbf'],
  ]) {
    const { roads } = decodeOpenFreeMapTile(fixture(name), z, x, y);
    assert.ok(roads.length > 0);
    assert.ok(
      roads.every((r) =>
        [
          'motorway',
          'trunk',
          'primary',
          'secondary',
          'tertiary',
          'residential',
          'unclassified',
        ].includes(r.type),
      ),
    );
    assert.ok(roads.some((r) => r.oneway === 1));
  }
});

test('OpenMapTiles class mapping and reverse oneway preserve the animated-road contract', () => {
  const coords = [
    [-97, 30],
    [-97.001, 30.001],
  ];
  assert.deepEqual(
    openMapRoad(coords, { class: 'minor', oneway: -1 }).coordinates,
    coords.slice().reverse(),
  );
  assert.equal(openMapRoad(coords, { class: 'minor', oneway: -1 }).oneway, 1);
  assert.equal(openMapRoad(coords, { class: 'minor' }).type, 'residential');
  assert.equal(openMapRoad(coords, { class: 'service' }).type, 'unclassified');
  assert.equal(openMapRoad(coords, { class: 'primary', oneway: 0 }).oneway, 0);
  for (const klass of [
    'track',
    'path',
    'rail',
    'pier',
    'motorway_construction',
    'bridge',
  ])
    assert.equal(openMapRoad(coords, { class: klass }), null);
});

test('tile buffer clipping rejects slivers and does not join disconnected lines', () => {
  const box = { west: 0, east: 1, south: 0, north: 1 };
  assert.deepEqual(
    clipTileLine(
      [
        [-1, 0.5],
        [2, 0.5],
      ],
      box,
    ),
    [
      [
        [0, 0.5],
        [1, 0.5],
      ],
    ],
  );
  assert.deepEqual(
    clipTileLine(
      [
        [0, 0],
        [0.00001, 0],
      ],
      box,
    ),
    [],
  );
});

test('Camp Mabry tile emits an unnamed polygon and its centroid marker', () => {
  const { military } = decodeOpenFreeMapTile(
    fixture('ofm-camp-mabry-12-935-1685.pbf'),
    12,
    935,
    1685,
  );
  assert.ok(military.length > 0);
  const camp = military.find(
    (record) =>
      Math.abs(record.latitude - 30.314) < 0.03 &&
      Math.abs(record.longitude + 97.763) < 0.03,
  );
  assert.ok(camp);
  assert.equal(camp.name, 'Military area');
  assert.equal(camp.kind, 'installation');
  assert.equal(camp.class, 'military_land');
  assert.ok(camp.footprint.length > 3);
  assert.deepEqual(
    polygonCentroid([
      [0, 0],
      [4, 0],
      [0, 4],
      [0, 0],
    ]),
    [4 / 3, 4 / 3],
  );
});

test('TileJSON is resolved once and decoded tile LRU prevents per-pan refetch', async () => {
  const calls = [];
  const source = createOpenFreeMapSource({
    fetchImpl: async (url) => {
      calls.push(url);
      return url.endsWith('/planet')
        ? Response.json({
            tiles: [
              'https://tiles.openfreemap.org/planet/version/{z}/{x}/{y}.pbf',
            ],
          })
        : new Response(fixture('ofm-austin-14-3743-6745.pbf'));
    },
  });
  const box = { south: 30.267, north: 30.268, west: -97.744, east: -97.743 };
  await source.fetchBounds(box, { zoom: 14 });
  await source.fetchBounds({ ...box, north: 30.269 }, { zoom: 14 });
  assert.equal(calls.length, 2);
  assert.equal(source.getStats().cacheEntries, 1);
  source.clear();
  assert.equal(source.getStats().cacheBytes, 0);
});

test('tile reads cap view size, concurrency and retained bytes, and reject oversized bodies', async () => {
  let concurrent = 0,
    peak = 0;
  const source = createVectorTileSource({
    template: 'https://tiles.example/{z}/{x}/{y}',
    allowedOrigin: 'https://tiles.example',
    maxTiles: 8,
    concurrency: 2,
    maxEntries: 2,
    maxCacheBytes: 100,
    decode: () => [1, 2, 3],
    fetchImpl: async () => {
      peak = Math.max(peak, ++concurrent);
      await new Promise((r) => setImmediate(r));
      concurrent--;
      return new Response('bytes');
    },
  });
  await assert.rejects(
    source.fetchBounds(
      { south: 20, north: 40, west: -100, east: -80 },
      { zoom: 14 },
    ),
    { code: 'TILE_VIEW_TOO_WIDE' },
  );
  await source.fetchBounds(
    { south: 30.26, north: 30.3, west: -97.8, east: -97.7 },
    { zoom: 12 },
  );
  assert.ok(peak <= 2);
  assert.ok(source.getStats().cacheEntries <= 2);
  assert.ok(source.getStats().cacheBytes <= 100);
  const huge = createVectorTileSource({
    template: 'https://tiles.example/{z}/{x}/{y}',
    allowedOrigin: 'https://tiles.example',
    maxResponseBytes: 4,
    decode: () => assert.fail('oversize decoded'),
    fetchImpl: async () => new Response('too many bytes'),
  });
  await assert.rejects(
    huge.fetchBounds(
      { south: 30.267, north: 30.268, west: -97.744, east: -97.743 },
      { zoom: 12 },
    ),
    { code: 'RESPONSE_TOO_LARGE' },
  );
});

test('shared TileJSON survives one camera cancellation and aborts when its last owner leaves', async () => {
  let finish,
    calls = 0,
    upstreamSignal;
  const source = createOpenFreeMapSource({
    fetchImpl: (url, { signal }) => {
      calls++;
      upstreamSignal = signal;
      return new Promise((resolve, reject) => {
        finish = () =>
          resolve(
            Response.json({
              tiles: ['https://tiles.openfreemap.org/planet/v/{z}/{x}/{y}.pbf'],
            }),
          );
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  const a = new AbortController(),
    b = new AbortController();
  const first = source.getMetadata(a.signal),
    second = source.getMetadata(b.signal);
  a.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(upstreamSignal.aborted, false);
  finish();
  await second;
  assert.equal(calls, 1);
  const cancelled = createOpenFreeMapSource({
    fetchImpl: (url, { signal }) => {
      upstreamSignal = signal;
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  const c = new AbortController();
  const waiting = cancelled.getMetadata(c.signal);
  c.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(upstreamSignal.aborted, true);
});

test('destroying a tile source aborts in-flight bodies and prevents stale cache refill', async () => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const source = createVectorTileSource({
    template: 'https://tiles.example/{z}/{x}/{y}',
    allowedOrigin: 'https://tiles.example',
    decode: () => [],
    fetchImpl: (url, { signal }) => {
      started();
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  const work = source.fetchBounds(
    { south: 30.267, north: 30.268, west: -97.744, east: -97.743 },
    { zoom: 12 },
  );
  await ready;
  source.clear();
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(source.getStats().cacheEntries, 0);
});
