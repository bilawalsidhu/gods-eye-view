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
import { approximateDistanceM, stitchLines } from './featureGeometry.js';

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
  assert.ok(!streetNameMatches('कुल मार्ग', 'काली मार्ग'));
  assert.ok(streetNameMatches('काली मार्ग', 'काली मार्ग'));
  assert.ok(streetNameMatches('Champs-Élysées', 'Champs Elysees'));
  // Japanese: dakuten and handakuten are kept, so these stay distinct.
  assert.ok(!streetNameMatches('ハシ通り', 'バシ通り'));
  assert.ok(!streetNameMatches('ハシ通り', 'パシ通り'));
  assert.ok(streetNameMatches('表参道', '表参道'));
  // Thai: vowel and tone marks are kept.
  assert.ok(!streetNameMatches('ถนนสุขุมวิท', 'ถนนสุขมวท'));
  assert.ok(!streetNameMatches('ถนนข้าวสาร', 'ถนนขาวสาร'));
  assert.ok(streetNameMatches('ถนนสุขุมวิท', 'ถนนสุขุมวิท'));
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
  const chains = stitchLines([b, c, a], { toleranceM: 3 });

  test('stitchLines joins at exactly the tolerance only when inclusive', () => {
    const a = [
      [0, 0],
      [0.001, 0],
    ];
    const b = [
      [0.00102, 0],
      [0.002, 0],
    ];
    const gap = approximateDistanceM(0, 0.001, 0, 0.00102);
    assert.equal(
      stitchLines([a, b], { toleranceM: gap, inclusive: true }).length,
      1,
    );
    assert.equal(stitchLines([a, b], { toleranceM: gap }).length, 2);
  });
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

test('tile enclosure alone does not identify the named Capitol grounds', () => {
  assert.equal(
    enclosingAreaFromTiles(TILES, { ...CAPITOL, name: 'Texas Capitol' }),
    null,
    'the former unlabeled enclosure is not an exact named answer',
  );
  assert.equal(
    enclosingAreaFromTiles(TILES, {
      ...CAPITOL,
      name: 'Texas Capitol',
      minAreaM2: 1e6,
    }),
    null,
    'nothing grounds-sized above the floor',
  );
});

test('traffic projects outlines only on demand and shares the decoded tile', async () => {
  clearSharedOpenFreeMapTiles();
  const idle = [];
  const previousIdle = globalThis.requestIdleCallback;
  const previousCancelIdle = globalThis.cancelIdleCallback;
  globalThis.requestIdleCallback = (callback) => {
    idle.push(callback);
    return idle.length;
  };
  globalThis.cancelIdleCallback = () => {};
  let projectionRuns = 0;
  registerOpenFreeMapProjection('requested-outlines-test', (...args) => {
    projectionRuns++;
    return decodeOpenFreeMapOutlineTile(...args);
  });
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
      projection: 'requested-outlines-test',
      template:
        'https://tiles.openfreemap.org/planet/v/20250910_001001_pt/{z}/{x}/{y}.pbf',
      fetchImpl,
    });
    const trafficResult = await traffic.fetchBounds(box, { zoom: 14, tiles });
    assert.equal(idle.length, 0, 'traffic schedules no outline extraction');
    assert.equal(projectionRuns, 0);
    const result = await outlines.fetchBounds(box, { zoom: 14, tiles });
    assert.ok(result.tiles[0].buildings.length > 0);
    await outlines.fetchBounds(box, { zoom: 14, tiles });
    assert.equal(
      projectionRuns,
      1,
      'the first explicit request owns the cached projection',
    );
    assert.deepEqual(
      (await traffic.fetchBounds(box, { zoom: 14, tiles })).tiles,
      trafficResult.tiles,
    );
    assert.equal(requests, 1);
  } finally {
    globalThis.requestIdleCallback = previousIdle;
    globalThis.cancelIdleCallback = previousCancelIdle;
    clearSharedOpenFreeMapTiles();
  }
});

test('an explicitly requested over-budget projection releases its shared entry', async () => {
  let projectionRuns = 0;
  registerOpenFreeMapProjection('projection-lifecycle-test', () => {
    projectionRuns++;
    return { coordinates: Array.from({ length: 20_000 }, (_, i) => [i, i]) };
  });
  const firstBytes = readFileSync(
    new URL(
      '../data/fixtures/ofm-outlines-austin-14-3743-6745.pbf',
      import.meta.url,
    ),
  );
  const sharedDecodedCache = createSharedDecodedTileCache({
    maxEntries: 1,
    maxCacheBytes: 100_000,
  });
  const source = createOpenFreeMapSource({
    template: 'https://tiles.openfreemap.org/planet/v/test/{z}/{x}/{y}.pbf',
    projection: 'projection-lifecycle-test',
    sharedDecodedCache,
    fetchImpl: async () => new Response(firstBytes),
  });
  const box = { south: 30.24, north: 30.29, west: -97.75, east: -97.73 };
  try {
    await source.fetchBounds(box, {
      zoom: 14,
      tiles: [{ z: 14, x: 3743, y: 6745 }],
    });
    assert.equal(projectionRuns, 1);
    assert.deepEqual(sharedDecodedCache.stats(), { entries: 0, bytes: 0 });
  } finally {
    source.clear();
    sharedDecodedCache.clear();
  }
});
