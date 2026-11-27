import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroundFloor } from '../../services/groundFloor.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { outsideDetailTiles } from './source.js';
import { createModel } from './model.js';
import { floorReaderOf, roadSurfaceChunks } from './surface.js';
import { DOT_HEIGHT_OFFSET } from './policy.js';
import { clipTileLine } from '../../sources/openFreeMap.js';
import { tileToBBox } from '../../data/tomtomTiles.js';

// Reference clip: every road against the four regions of every tile.
// outsideDetailTiles must return this, up to floating-point rounding.
function clipEveryRoadAgainstEveryTile(roads, tiles) {
  return roads.flatMap((road) => {
    let lines = [road.coordinates];
    for (const tile of tiles) {
      const box = tileToBBox(tile.z, tile.x, tile.y);
      const regions = [
        { west: -180, east: box.west, south: -85, north: 85 },
        { west: box.east, east: 180, south: -85, north: 85 },
        { west: box.west, east: box.east, south: -85, north: box.south },
        { west: box.west, east: box.east, south: box.north, north: 85 },
      ];
      lines = lines.flatMap((line) =>
        regions.flatMap((region) => clipTileLine(line, region)),
      );
    }
    return lines.map((coordinates) => ({ ...road, coordinates }));
  });
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function tileBlock(x, y, size = 4) {
  const tiles = [];
  for (let dx = 0; dx < size; dx++)
    for (let dy = 0; dy < size; dy++)
      tiles.push({ z: 14, x: x + dx, y: y + dy });
  return tiles;
}

/** Roads in and around a tile block: wandering, straight, tiny, and on tile edges. */
function roadsAround(tiles, random, count = 400) {
  const boxes = tiles.map((tile) => tileToBBox(tile.z, tile.x, tile.y));
  const west = Math.min(...boxes.map((box) => box.west)),
    east = Math.max(...boxes.map((box) => box.east)),
    south = Math.min(...boxes.map((box) => box.south)),
    north = Math.max(...boxes.map((box) => box.north));
  const width = east - west,
    height = north - south;
  const roads = [];
  for (let i = 0; i < count; i++) {
    const step = i % 7 === 0 ? 0.00002 : i % 3 === 0 ? 0.01 : 0.002;
    let lon = west - width / 2 + random() * width * 2,
      lat = south - height / 2 + random() * height * 2;
    const coordinates = [[lon, lat]];
    const points = 1 + Math.floor(random() * 12);
    for (let j = 0; j < points; j++) {
      lon += (random() - 0.5) * step;
      lat += (random() - 0.5) * step;
      coordinates.push([lon, lat]);
    }
    roads.push({ type: 'primary', oneway: i % 2, id: i, coordinates });
  }
  const box = boxes[5];
  const midLat = (box.south + box.north) / 2,
    midLon = (box.west + box.east) / 2;
  roads.push(
    // Along a tile edge, ending on a corner, and touching an edge from outside.
    {
      id: 'edge',
      coordinates: [
        [box.west, box.south - 0.01],
        [box.west, box.north + 0.01],
      ],
    },
    {
      id: 'corner',
      coordinates: [
        [box.west - 0.01, box.south - 0.01],
        [box.west, box.south],
        [box.east, box.north],
      ],
    },
    {
      id: 'touch',
      coordinates: [
        [box.west - 0.01, midLat],
        [box.west, midLat],
      ],
    },
    // Across the whole block, and a repeated vertex.
    {
      id: 'across',
      coordinates: [
        [west - 0.01, midLat],
        [east + 0.01, midLat + 0.0003],
      ],
    },
    {
      id: 'repeat',
      coordinates: [
        [midLon, midLat],
        [midLon, midLat],
        [midLon + 0.001, midLat],
      ],
    },
    // Records the clip drops or leaves alone.
    { id: 'single', coordinates: [[west - 0.02, midLat]] },
    { id: 'empty', coordinates: [] },
    {
      id: 'negative-zero',
      coordinates: [
        [-0, south - 0.02],
        [0.001, south - 0.02],
      ],
    },
    {
      id: 'polar',
      coordinates: [
        [west - 0.02, 86],
        [west - 0.02, 86.01],
      ],
    },
  );
  return roads;
}

/** Same roads and fields as the reference; each vertex within 1e-9 degrees (rounding steps, -0 and 0). */
function assertSameRoads(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    const { coordinates, ...fields } = actual[i];
    const { coordinates: reference, ...referenceFields } = expected[i];
    assert.deepStrictEqual(fields, referenceFields);
    assert.equal(coordinates.length, reference.length);
    for (let j = 0; j < coordinates.length; j++)
      for (let k = 0; k < 2; k++)
        assert.ok(
          Math.abs(coordinates[j][k] - reference[j][k]) <= 1e-9,
          `road ${i} vertex ${j}: ${coordinates[j]} vs ${reference[j]}`,
        );
  }
}

for (const [place, x, y] of [
  ['Manhattan', 4823, 6158],
  ['London, across longitude 0', 8190, 5446],
  ['longitude 0 and latitude 0', 8190, 8190],
  ['the southern and eastern hemispheres', 15070, 9826],
])
  test(`coarse roads clipped around detail tiles match the every-tile clip: ${place}`, () => {
    const tiles = tileBlock(x, y);
    const roads = roadsAround(tiles, seeded(x * 31 + y));
    for (const loaded of [tiles, tiles.slice(0, 5), tiles.slice(3, 4), []]) {
      const expected = clipEveryRoadAgainstEveryTile(roads, loaded);
      assert.ok(loaded.length === 0 || expected.length !== roads.length);
      assertSameRoads(outsideDetailTiles(roads, loaded), expected);
    }
  });

test('polar tile regions retain roads beyond the extent shortcut bounds', () => {
  for (const [y, lat] of [[0, 85.02], [2 ** 14 - 1, -85.02]]) {
    const tiles = [{ z: 14, x: 8192, y }];
    const roads = [{ coordinates: [[0.002, lat], [0.012, lat]] }];
    const expected = clipEveryRoadAgainstEveryTile(roads, tiles);
    assert.equal(expected.length, 1);
    assertSameRoads(outsideDetailTiles(roads, tiles), expected);
  }
});

test("only a line not wholly inside one of a tile's four regions is clipped against it", () => {
  const tiles = tileBlock(4823, 6158);
  const block = tiles.map((tile) => tileToBBox(tile.z, tile.x, tile.y));
  const west = Math.min(...block.map((box) => box.west)),
    north = Math.max(...block.map((box) => box.north));
  // 300 roads west or north of the block, each within one tile row or column,
  // none touching a tile.
  const clear = [];
  for (let i = 0; i < 300; i++) {
    const box = block[i % block.length];
    const lon = i % 2 ? west - 0.02 - i * 1e-5 : box.west + 0.004;
    const lat = i % 2 ? box.south + 0.004 : north + 0.01 + i * 1e-5;
    clear.push({
      coordinates: [
        [lon, lat],
        [lon + 0.002, lat + 0.0005],
        [lon + 0.003, lat + 0.001],
      ],
    });
  }
  const first = block[0];
  const crossing = {
    coordinates: [
      [first.west + 0.004, north + 0.01],
      [first.west + 0.004, (first.south + first.north) / 2],
    ],
  };
  let clips = 0;
  const counted = (line, region) => {
    clips++;
    return clipTileLine(line, region);
  };
  const roads = outsideDetailTiles([...clear, crossing], tiles, counted);
  assertSameRoads(
    roads,
    clipEveryRoadAgainstEveryTile([...clear, crossing], tiles),
  );
  assert.equal(roads.length, 301);
  // Four regions for each tile the crossing road reaches, never the 19,264
  // clips of every road against every tile.
  assert.ok(clips >= 4, `expected the crossing road to be clipped: ${clips}`);
  assert.ok(clips <= 4 * tiles.length, `clipped ${clips} times`);
});

function demGround(warm = () => true) {
  const terrain = {
    reads: 0,
    cachedRealEllipsoidalGround(lat, lon) {
      terrain.reads++;
      const cell = `${lat},${lon}`;
      if (!warm(cell)) return null;
      let hash = 0;
      for (const character of cell)
        hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
      return (hash % 4000) / 10;
    },
    resolveEllipsoidalGround: async () => {},
  };
  const ground = createGroundFloor({ terrain });
  ground.setMeshFloorPreferred(false);
  return { ground, terrain };
}

test('a ground service without a pass reader is read per coordinate', () => {
  const service = {
    reads: 0,
    cachedGroundFloor() {
      return ++this.reads;
    },
  };
  const at = floorReaderOf(service);
  at(40.7512, -73.9812);
  at(40.7512, -73.9812);
  assert.equal(service.reads, 2);
  assert.equal(floorReaderOf(undefined)(1, 2), undefined);
  assert.equal(floorReaderOf({})(1, 2), undefined);
});

function road(lon, lat, points = 40) {
  const coordinates = [];
  for (let i = 0; i < points; i++)
    coordinates.push([lon + i * 0.00004, lat + i * 0.00003]);
  return { type: 'residential', oneway: 1, coordinates };
}

test('parsing reads each floor cell once and builds the same waypoints', () => {
  const warm = (cell) => !cell.startsWith('40.751,');
  const { ground, terrain } = demGround(warm);
  const state = { _viewHeightEstimate: 12 };
  const model = createModel({
    state,
    services: { ground },
    parts: {},
    source: {},
  });
  const records = [road(-73.99, 40.75), road(-73.9899, 40.7501)];
  const parsed = model.parseRoads({ roads: records });
  const coordinates = records.reduce(
    (count, record) => count + record.coordinates.length,
    0,
  );
  assert.ok(
    terrain.reads < coordinates / 3,
    `${terrain.reads} floor reads for ${coordinates} coordinates`,
  );

  const direct = demGround(warm);
  const expected = records.flatMap((record) =>
    roadSurfaceChunks(record.coordinates).map((coords) =>
      coords.map(([lon, lat]) => {
        const floor = direct.ground.cachedGroundFloor(lat, lon);
        return fromDegrees(
          lon,
          lat,
          (floor ?? state._viewHeightEstimate) + DOT_HEIGHT_OFFSET,
        );
      }),
    ),
  );
  assert.ok(direct.terrain.reads >= coordinates);
  assert.deepStrictEqual(
    parsed.map((entry) => entry.waypoints),
    expected,
  );
  const cold = parsed.flatMap((entry) =>
    entry.coords.map((coords, i) => [coords, entry.waypoints[i]]),
  ).filter(([[lon, lat]]) => direct.ground.cachedGroundFloor(lat, lon) == null);
  assert.ok(cold.length > 0);
  for (const [[lon, lat], waypoint] of cold)
    assert.deepStrictEqual(
      waypoint,
      fromDegrees(lon, lat, state._viewHeightEstimate + DOT_HEIGHT_OFFSET),
    );
});

test('a record parsed earlier in the pass is not parsed again', () => {
  const { ground, terrain } = demGround();
  const model = createModel({
    state: {},
    services: { ground },
    parts: {},
    source: {},
  });
  const first = {
    type: 'residential',
    oneway: 0,
    coordinates: [
      [-73.99, 40.75],
      [-73.975, 40.755],
    ],
  };
  const second = road(-73.98, 40.76);
  const short = { type: 'primary', coordinates: [[-73.97, 40.77]] };
  const parsedBySource = new WeakMap();
  const tile = model.parseRoads({ roads: [first] }, null, parsedBySource);
  const chunks = roadSurfaceChunks(first.coordinates).length;
  assert.ok(chunks >= 2);
  assert.equal(tile.length, 2 * chunks);
  tile[0].flow = { level: 0, closure: true };
  const reads = terrain.reads;
  const replaced = model.parseRoads(
    { roads: [second, short, first], replace: true },
    null,
    parsedBySource,
  );
  assert.equal(replaced.length, 1 + tile.length);
  // The same parsed roads, in the snapshot's order: dots stay attached.
  for (const [i, parsed] of tile.entries()) assert.equal(replaced[i + 1], parsed);
  assert.equal(replaced[1].flow, null);
  const fresh = demGround();
  createModel({
    state: {},
    services: { ground: fresh.ground },
    parts: {},
    source: {},
  }).parseRoads({ roads: [second] });
  assert.equal(terrain.reads - reads, fresh.terrain.reads, 'only the new record read');

  // Without the map, every call parses.
  const again = model.parseRoads({ roads: [first] });
  assert.notEqual(again[0], tile[0]);
  assert.deepStrictEqual(again, tile);
});
