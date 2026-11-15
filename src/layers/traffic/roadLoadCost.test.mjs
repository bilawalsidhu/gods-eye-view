import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createTrafficSource, outsideDetailTiles } from './source.js';
import { createIngestion } from './ingestion.js';
import { createModel } from './model.js';
import { floorCellReader, roadSurfaceChunks } from './surface.js';
import { DOT_HEIGHT_OFFSET } from './policy.js';
import { clipTileLine } from '../../sources/openFreeMap.js';
import { tileToBBox } from '../../data/tomtomTiles.js';

// The clip as it was before the extent shortcut: every road against the four
// regions around every tile. The shortcut must return exactly this.
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
      // deepStrictEqual separates -0 from 0 and compares every vertex exactly.
      assert.deepStrictEqual(outsideDetailTiles(roads, loaded), expected);
    }
  });

test('only a road that reaches a detail tile is clipped against it', () => {
  const tiles = tileBlock(4823, 6158);
  const block = tiles.map((tile) => tileToBBox(tile.z, tile.x, tile.y));
  const west = Math.min(...block.map((box) => box.west)),
    north = Math.max(...block.map((box) => box.north));
  // 300 roads beside the block and between its tile edges, none touching one.
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
  assert.deepStrictEqual(
    roads,
    clipEveryRoadAgainstEveryTile([...clear, crossing], tiles),
  );
  assert.equal(roads.length, 301);
  // Four regions for each tile the crossing road reaches, never the 19,264
  // clips of every road against every tile.
  assert.ok(clips >= 4, `expected the crossing road to be clipped: ${clips}`);
  assert.ok(clips <= 4 * tiles.length, `clipped ${clips} times`);
});

/** A DEM-regime ground service: one floor per toFixed(3) cell, counting reads. */
function cellGround({ mesh = false, warm = () => true } = {}) {
  const ground = {
    reads: 0,
    meshFloorPreferred: () => mesh,
    cachedGroundFloor(lat, lon) {
      ground.reads++;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      // Number() as the shared cache does it: "-0.000" and "0.000" are one cell.
      const cell = `${Number(lat.toFixed(3))},${Number(lon.toFixed(3))}`;
      if (!warm(cell)) return null;
      let hash = 0;
      for (const character of cell)
        hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
      // The mesh regime answers per point, not per cell.
      return (hash % 4000) / 10 + (mesh ? lat - Math.floor(lat * 1000) / 1000 : 0);
    },
  };
  return ground;
}

test('floor reads are shared per cell and equal the per-coordinate reads', () => {
  const random = seeded(7);
  const points = [];
  for (let i = 0; i < 4000; i++)
    points.push([40.75 + random() * 0.01, -73.99 + random() * 0.01]);
  // Cell edges, where toFixed(3) and Math.round can disagree, in each sign.
  for (const lat of [40.7505, -40.7505, 0.0005, -0.0005, 1.0005, 8.5745])
    for (const lon of [-73.9905, 73.9905, 0.0005, -0.0005, 1.0005, 2.3515])
      points.push([lat, lon], [lat + 1e-9, lon - 1e-9], [lat - 1e-9, lon]);
  points.push([Number.NaN, 0], [0, Infinity], [0, 0], [-0, -0]);

  const direct = cellGround();
  const expected = points.map(([lat, lon]) =>
    direct.cachedGroundFloor(lat, lon),
  );
  const ground = cellGround();
  const floorAt = floorCellReader(ground);
  assert.deepStrictEqual(
    points.map(([lat, lon]) => floorAt(lat, lon)),
    expected,
  );
  // 4000 points in a 0.01 degree square share about 121 cells.
  assert.ok(ground.reads < 600, `read the shared cache ${ground.reads} times`);

  // A cold cell is remembered as cold for the pass, not asked again.
  const cold = cellGround({ warm: () => false });
  const coldAt = floorCellReader(cold);
  assert.equal(coldAt(40.7512, -73.9812), null);
  assert.equal(coldAt(40.7513, -73.9813), null);
  assert.equal(cold.reads, 1);
});

test('mesh floors and unknown ground services are read per coordinate', () => {
  const mesh = cellGround({ mesh: true });
  const meshAt = floorCellReader(mesh);
  const a = meshAt(40.7512, -73.9812),
    b = meshAt(40.75121, -73.9812);
  assert.equal(mesh.reads, 2);
  assert.notEqual(a, b);

  // No regime to ask: nothing says a floor is the same across a cell.
  let reads = 0;
  const bareAt = floorCellReader({ cachedGroundFloor: () => ++reads });
  bareAt(40.7512, -73.9812);
  bareAt(40.7512, -73.9812);
  assert.equal(reads, 2);
  assert.equal(floorCellReader(undefined)(1, 2), undefined);
  assert.equal(floorCellReader({})(1, 2), undefined);
});

function road(lon, lat, points = 40) {
  const coordinates = [];
  for (let i = 0; i < points; i++)
    coordinates.push([lon + i * 0.00004, lat + i * 0.00003]);
  return { type: 'residential', oneway: 1, coordinates };
}

test('parsing reads each floor cell once and builds the same waypoints', () => {
  const ground = cellGround({ warm: (cell) => !cell.endsWith('3') });
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
    ground.reads < coordinates / 3,
    `${ground.reads} floor reads for ${coordinates} coordinates`,
  );

  const direct = cellGround({ warm: (cell) => !cell.endsWith('3') });
  const expected = records.flatMap((record) =>
    roadSurfaceChunks(record.coordinates).map((coords) =>
      coords.map(([lon, lat]) => {
        const floor = direct.cachedGroundFloor(lat, lon);
        return Cesium.Cartesian3.fromDegrees(
          lon,
          lat,
          (floor ?? state._viewHeightEstimate) + DOT_HEIGHT_OFFSET,
        );
      }),
    ),
  );
  assert.ok(direct.reads >= coordinates);
  assert.deepStrictEqual(
    parsed.map((entry) => entry.waypoints),
    expected,
  );
});

test('a record parsed earlier in the pass is not parsed again', () => {
  const ground = cellGround();
  const model = createModel({
    state: {},
    services: { ground },
    parts: {},
    source: {},
  });
  const first = { ...road(-73.99, 40.75), oneway: 0 },
    second = road(-73.98, 40.76),
    short = { type: 'primary', coordinates: [[-73.97, 40.77]] };
  const parsedBySource = new WeakMap();
  const tile = model.parseRoads({ roads: [first] }, null, parsedBySource);
  assert.equal(tile.length, 2, 'a two-way record parses to both directions');
  const reads = ground.reads;
  const replaced = model.parseRoads(
    { roads: [second, short, first], replace: true },
    null,
    parsedBySource,
  );
  assert.equal(replaced.length, 3);
  // The same parsed roads, in the snapshot's order: dots stay attached.
  assert.equal(replaced[1], tile[0]);
  assert.equal(replaced[2], tile[1]);
  const fresh = cellGround();
  createModel({
    state: {},
    services: { ground: fresh },
    parts: {},
    source: {},
  }).parseRoads({ roads: [second] });
  assert.equal(ground.reads - reads, fresh.reads, 'only the new record read');

  // Without the map every call parses, as before.
  const again = model.parseRoads({ roads: [first] });
  assert.notEqual(again[0], tile[0]);
  assert.deepStrictEqual(again, tile);
});

test('the snapshot that ends a pass parses only the records it adds', async () => {
  const detail = { z: 14, x: 3743, y: 6745 };
  const core = tileToBBox(detail.z, detail.x, detail.y);
  const local = {
    type: 'residential',
    oneway: 1,
    coordinates: [
      [core.west + 0.002, core.south + 0.002],
      [core.west + 0.004, core.south + 0.004],
    ],
  };
  const distant = {
    type: 'primary',
    oneway: 1,
    coordinates: [
      [core.east + 0.01, core.south],
      [core.east + 0.02, core.south],
    ],
  };
  const bounds = {
    ...core,
    east: core.east + 0.03,
    coverage: {
      detail: [detail],
      coarse: [{ z: 12, x: 935, y: 1686 }],
      key: 'test',
    },
  };
  const source = createTrafficSource({
    mapTiles: {
      async fetchBounds(box, { zoom, onTile }) {
        const tile = { roads: zoom === 14 ? [local] : [distant] };
        onTile?.(tile);
        return {
          tiles: [tile],
          loadedTiles: zoom === 14 ? [detail] : bounds.coverage.coarse,
          partial: false,
        };
      },
    },
  });
  const parsedRecords = [];
  const painted = [];
  const state = {
    _enabled: true,
    _loadGeneration: 0,
    _tileCache: new Map(),
    _roadMode: null,
    _liveMode: false,
    // The model's contract: fill the map, answer known records from it.
    _parseRoads: (data, trace, parsedBySource) =>
      data.roads.flatMap((record) => {
        const known = parsedBySource?.get(record);
        if (known) return known;
        parsedRecords.push(record);
        const parsed = [{ record }];
        parsedBySource?.set(record, parsed);
        return parsed;
      }),
  };
  const ingestion = createIngestion({
    state,
    source,
    services: {},
    parts: {
      viewport: {
        clampBounds: (b) => b,
        getBoundsCenter: () => ({ lat: 30.26, lon: -97.74 }),
      },
      flow: {
        warmFlow: () => Promise.resolve([]),
        applyFlowThenRender: async (roads, box, generation, altitude, label) => {
          if (label === 'Loaded full') painted.push(roads);
          return true;
        },
      },
    },
  });
  await ingestion.loadRoadsForBounds(bounds, 350);
  assert.equal(
    parsedRecords.filter((record) => record === local).length,
    1,
    'the detail tile record is parsed when its tile streams, not again',
  );
  // The full graph is still the detail record plus the coarse road outside it.
  assert.equal(painted.at(-1).length, 2);
  assert.equal(painted.at(-1)[0].record, local);
  assert.deepStrictEqual(
    painted.at(-1)[1].record.coordinates,
    distant.coordinates,
  );
});
