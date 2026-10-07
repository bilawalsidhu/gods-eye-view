// Street and building outlines from OpenFreeMap z14 tiles (fixtures: trimmed
// real tiles around the Texas Capitol, see src/data/fixtures/README.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildingFromTiles,
  createOpenFreeMapOutlineSource,
  decodeOpenFreeMapOutlineTile,
  enclosingAreaFromTiles,
  mergeLineSegments,
  normalizeStreetName,
  streetFromTiles,
  streetNameMatches,
} from './openFreeMapOutlines.js';
import {
  clearSharedOpenFreeMapTiles,
  createOpenFreeMapSource,
  registerOpenFreeMapProjection,
} from './openFreeMap.js';
import { createSharedDecodedTileCache } from './vectorTiles.js';
import { approximateDistanceM } from './featureGeometry.js';

const fixture = (y) =>
  decodeOpenFreeMapOutlineTile(
    readFileSync(
      new URL(
        `../data/fixtures/ofm-outlines-austin-14-3743-${y}.pbf`,
        import.meta.url,
      ),
    ),
    14,
    3743,
    y,
  );
const TILES = [fixture(6745), fixture(6746)];
const CAPITOL = { lat: 30.27472, lon: -97.74035 };

test('tiles decode named street lines and building polygons', () => {
  const names = new Set(TILES.flatMap((t) => t.streets.map((s) => s.name)));
  assert.ok(names.has('Congress Avenue'));
  assert.ok(names.has('South Congress Avenue'));
  assert.ok(TILES[0].buildings.length > 0);
  for (const street of TILES.flatMap((t) => t.streets))
    for (const [lon, lat] of street.coordinates) {
      assert.ok(lon > -97.76 && lon < -97.72, 'clipped to the tile core');
      assert.ok(lat > 30.24 && lat < 30.29);
    }
});

test('street names compare with abbreviations and a leading direction only', () => {
  assert.equal(normalizeStreetName('Congress Ave.'), 'congress avenue');
  assert.equal(
    normalizeStreetName('Lombard St, San Francisco'),
    'lombard street',
  );
  assert.ok(streetNameMatches('Congress Avenue', 'congress ave'));
  assert.ok(streetNameMatches('North Congress Avenue', 'Congress Avenue'));
  assert.ok(!streetNameMatches('Congress Avenue', 'South Congress Avenue'));
  assert.ok(!streetNameMatches('Congress Street', 'Congress Avenue'));
  assert.ok(!streetNameMatches('East 11th Street', '11th'));
});

test('same-name segments merge into polylines around the point (Congress Avenue)', () => {
  const street = streetFromTiles(TILES, {
    name: 'Congress Avenue',
    ...CAPITOL,
  });
  assert.equal(street.name, 'Congress Avenue');
  assert.equal(street.lines.length, 1, 'the tile pieces join into one line');
  const line = street.lines[0];
  const [start, end] = [line[0], line.at(-1)];
  const spanM = approximateDistanceM(start[1], start[0], end[1], end[0]);
  assert.ok(
    spanM > 1200,
    `Congress runs ${spanM.toFixed(0)} m from the river to the Capitol`,
  );
  // South Congress is a different street and stays out.
  const south = streetFromTiles(TILES, {
    name: 'South Congress Avenue',
    ...CAPITOL,
  });
  assert.ok(south);
  assert.ok(south.lines.every((l) => l.every(([, lat]) => lat < 30.265)));
});

test('street lookups are bounded by radius and answer null for unknown names', () => {
  assert.equal(
    streetFromTiles(TILES, { name: 'Lombard Street', ...CAPITOL }),
    null,
  );
  assert.equal(
    streetFromTiles(TILES, { name: 'Congress Avenue', lat: 30.4, lon: -97.74 }),
    null,
    'no piece within the radius of a far point',
  );
});

test('merge joins reversed and out-of-order pieces and keeps gaps apart', () => {
  const a = [
    [0, 0],
    [0.001, 0],
  ];
  const b = [
    [0.002, 0],
    [0.001, 0],
  ]; // reversed, shares a's end
  const c = [
    [0.01, 0],
    [0.011, 0],
  ]; // separate
  const chains = mergeLineSegments([b, c, a]);
  assert.equal(chains.length, 2);
  assert.equal(chains.find((ch) => ch.length === 3).length, 3);
});

test('the building containing a point is picked (Texas Capitol)', () => {
  const building = buildingFromTiles(TILES, CAPITOL);
  assert.ok(building.contains);
  assert.ok(building.ring.length >= 8);
  assert.deepEqual(building.ring[0], building.ring.at(-1), 'closed ring');
  assert.ok(building.heightM > 20, 'render height carried for extrusion');
});

test('a point beside a building picks the nearest within 40 m, else none', () => {
  const box = [
    [0, 0],
    [0.0002, 0],
    [0.0002, 0.0002],
    [0, 0.0002],
    [0, 0],
  ];
  const tiles = [{ buildings: [{ rings: [box], heightM: null }] }];
  const near = buildingFromTiles(tiles, { lat: 0.0001, lon: 0.00045 }); // ~28 m east
  assert.ok(near && !near.contains);
  assert.equal(buildingFromTiles(tiles, { lat: 0.0001, lon: 0.0008 }), null);
});

test('the open area enclosing the Capitol is its grounds, not a building', () => {
  const grounds = enclosingAreaFromTiles(TILES, CAPITOL);
  assert.ok(grounds, 'the park-like cover around the Capitol is found');
  assert.ok(
    grounds.areaM2 > 50_000 && grounds.areaM2 < 500_000,
    `${grounds.areaM2} m²`,
  );
  assert.equal(grounds.class, 'park');
  assert.equal(
    enclosingAreaFromTiles(TILES, { ...CAPITOL, minAreaM2: 1e6 }),
    null,
    'nothing grounds-sized above the floor',
  );
});

test('traffic idle preparation gives outlines the same decoded tile without another request', async () => {
  clearSharedOpenFreeMapTiles();
  const idle = [];
  const previousIdle = globalThis.requestIdleCallback;
  const previousCancelIdle = globalThis.cancelIdleCallback;
  globalThis.requestIdleCallback = (callback) => {
    idle.push(callback);
    return idle.length;
  };
  globalThis.cancelIdleCallback = () => {};
  let requests = 0;
  const bytes = readFileSync(
    new URL(
      '../data/fixtures/ofm-outlines-austin-14-3743-6745.pbf',
      import.meta.url,
    ),
  );
  const fetchImpl = async () => {
    requests++;
    return new Response(bytes);
  };
  const tiles = [{ z: 14, x: 3743, y: 6745 }];
  const box = { south: 30.27, north: 30.28, west: -97.75, east: -97.73 };
  try {
    const traffic = createOpenFreeMapSource({
      template:
        'https://tiles.openfreemap.org/planet/v/20250910_001001_pt/{z}/{x}/{y}.pbf',
      fetchImpl,
    });
    const outlines = createOpenFreeMapOutlineSource({
      template:
        'https://tiles.openfreemap.org/planet/v/20250910_001001_pt/{z}/{x}/{y}.pbf',
      fetchImpl,
    });
    await traffic.fetchBounds(box, { zoom: 14, tiles });
    assert.ok(idle.length > 0, 'traffic schedules the registered projection');
    for (const callback of idle)
      callback({ didTimeout: false, timeRemaining: () => 50 });
    const result = await outlines.fetchBounds(box, { zoom: 14, tiles });
    assert.ok(result.tiles[0].buildings.length > 0);
    assert.equal(requests, 1);
  } finally {
    globalThis.requestIdleCallback = previousIdle;
    globalThis.cancelIdleCallback = previousCancelIdle;
    clearSharedOpenFreeMapTiles();
  }
});

test('idle projections are retired on shared eviction, clear, and self-eviction', async () => {
  const previousIdle = globalThis.requestIdleCallback;
  const previousCancelIdle = globalThis.cancelIdleCallback;
  const scheduled = new Map();
  const cancelled = new Set();
  let nextHandle = 1;
  globalThis.requestIdleCallback = (callback) => {
    const handle = nextHandle++;
    scheduled.set(handle, callback);
    return handle;
  };
  globalThis.cancelIdleCallback = (handle) => cancelled.add(handle);
  let projectionRuns = 0;
  registerOpenFreeMapProjection('idle-lifecycle-test', () => {
    projectionRuns++;
    return { coordinates: Array.from({ length: 20_000 }, (_, i) => [i, i]) };
  });
  const firstBytes = readFileSync(
    new URL(
      '../data/fixtures/ofm-outlines-austin-14-3743-6745.pbf',
      import.meta.url,
    ),
  );
  const secondBytes = readFileSync(
    new URL(
      '../data/fixtures/ofm-outlines-austin-14-3743-6746.pbf',
      import.meta.url,
    ),
  );
  const sharedDecodedCache = createSharedDecodedTileCache({
    maxEntries: 1,
    maxCacheBytes: 100_000,
  });
  const source = createOpenFreeMapSource({
    template: 'https://tiles.openfreemap.org/planet/v/test/{z}/{x}/{y}.pbf',
    sharedDecodedCache,
    fetchImpl: async (url) =>
      new Response(
        String(url).includes('/6746.pbf') ? secondBytes : firstBytes,
      ),
  });
  const box = { south: 30.24, north: 30.29, west: -97.75, east: -97.73 };
  try {
    await source.fetchBounds(box, {
      zoom: 14,
      tiles: [{ z: 14, x: 3743, y: 6745 }],
    });
    const firstHandles = [...scheduled.keys()];
    assert.ok(firstHandles.length >= 2);

    await source.fetchBounds(box, {
      zoom: 14,
      tiles: [{ z: 14, x: 3743, y: 6746 }],
    });
    assert.ok(firstHandles.every((handle) => cancelled.has(handle)));
    for (const handle of firstHandles) scheduled.get(handle)();
    assert.equal(projectionRuns, 0, 'late callbacks after eviction are inert');

    const secondHandles = [...scheduled.keys()].filter(
      (handle) => !firstHandles.includes(handle),
    );
    sharedDecodedCache.clear();
    assert.ok(secondHandles.every((handle) => cancelled.has(handle)));
    for (const handle of secondHandles) scheduled.get(handle)();
    assert.equal(projectionRuns, 0, 'late callbacks after clear are inert');

    const selfEvictingCache = createSharedDecodedTileCache({
      maxEntries: 1,
      maxCacheBytes: 100_000,
    });
    const selfEvictingSource = createOpenFreeMapSource({
      template: 'https://tiles.openfreemap.org/planet/v/self/{z}/{x}/{y}.pbf',
      sharedDecodedCache: selfEvictingCache,
      fetchImpl: async () => new Response(firstBytes),
    });
    const beforeSelfEviction = nextHandle;
    await selfEvictingSource.fetchBounds(box, {
      zoom: 14,
      tiles: [{ z: 14, x: 3743, y: 6745 }],
    });
    const selfEvictingHandles = [...scheduled.keys()].filter(
      (handle) => handle >= beforeSelfEviction,
    );
    scheduled.get(selfEvictingHandles.at(-1))();
    assert.equal(projectionRuns, 1);
    assert.deepEqual(selfEvictingCache.stats(), { entries: 0, bytes: 0 });
    assert.ok(
      selfEvictingHandles.slice(0, -1).every((handle) => cancelled.has(handle)),
    );
    for (const handle of selfEvictingHandles)
      if (!cancelled.has(handle)) scheduled.get(handle)();
    assert.equal(projectionRuns, 1, 'self-eviction retires sibling idle work');
  } finally {
    source.clear();
    sharedDecodedCache.clear();
    globalThis.requestIdleCallback = previousIdle;
    globalThis.cancelIdleCallback = previousCancelIdle;
  }
});
