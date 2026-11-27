import { viewSummaryForLayer } from '../data/entityContext.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTEXT_LINES,
  CONTEXT_AREA,
  contextLine,
} from '../data/contextGeometry.js';
import {
  aboveInspectorHorizon,
  createInspectorSpatialIndex,
  distanceToInspectorBounds,
  expandInspectorBounds,
  inspectorPointRecord,
  inspectorViewScale,
  inspectorViewTier,
} from './inspectorSpatialIndex.js';

const center = { lat: 0, lon: 180 };
const wrapped = { west: 179, east: -179, south: -0.2, north: 0.2 };

test('bounds use the nearer wrapped edge, and the expanded search keeps it', () => {
  const east = { lat: 0, lon: -178.8 };
  const west = { lat: 0, lon: 178.8 };
  assert.equal(distanceToInspectorBounds(center, wrapped), 0);
  const toEast = distanceToInspectorBounds(east, wrapped);
  assert.ok(toEast > 22 && toEast < 23);
  assert.ok(
    Math.abs(toEast - distanceToInspectorBounds(west, wrapped)) < 0.001,
  );

  const index = createInspectorSpatialIndex();
  for (const point of [east, west, center, { lat: 30, lon: 150 }])
    index.add(point);
  const matches = [...index.points([expandInspectorBounds(wrapped, 30)])];
  assert.deepEqual(
    matches.sort((a, b) => a.lon - b.lon),
    [east, west, center],
  );
});

test('overhead membership is about aircraft elevation above the local horizon', () => {
  assert.equal(
    aboveInspectorHorizon({ altitudeM: 9000, onGround: false }, 30),
    true,
  );
  assert.equal(
    aboveInspectorHorizon({ altitudeM: 9000, onGround: false }, 80),
    false,
  );
  assert.equal(
    aboveInspectorHorizon({ altitudeM: 9000, onGround: true }, 0),
    false,
  );
});

test('the settled tier holds through the globe thresholds in both directions', () => {
  const at = (heightM, previous) =>
    inspectorViewTier({ center, heightM }, previous);
  assert.equal(at(50_000).city, true);
  assert.equal(at(50_001).city, false);
  const street = at(30_000);
  assert.equal(street.city, true);
  assert.equal(at(54_000, street).city, true);
  const local = at(60_000, street);
  assert.equal(local.city, false);
  assert.equal(at(45_000, local).city, false);
  assert.equal(at(42_000, local).city, true);

  assert.equal(at(5_600_000, local).globe, false);
  const globe = at(5_800_000, local);
  assert.equal(globe.globe, true);
  assert.equal(at(4_500_000, globe).globe, true);
  assert.equal(at(4_200_000, globe).globe, false);
  assert.ok(
    inspectorViewScale({ center, eye: { lat: 0, lon: 179 }, heightM: 2000 }) <
      50,
  );
});

test('a nearly worldwide wrapped viewport visits each park in its shared edge cell once', () => {
  const index = createInspectorSpatialIndex();
  for (const [id, lon] of [
    ['West Park', 0.1],
    ['East Park', 0.7],
    ['Lake Park', -90],
  ])
    index.add({ id, lat: 0, lon });
  const bounds = { west: 0.4, east: 0.2, south: -1, north: 1 };
  assert.deepEqual([...index.points([bounds])].map((park) => park.id).sort(), [
    'East Park',
    'Lake Park',
    'West Park',
  ]);
});

test('a bounded park query visits crossing paths and containing grounds without scanning distant trails', () => {
  const index = createInspectorSpatialIndex();
  const path = (start, end) => contextLine([start, end]);
  const rect = { west: -0.1, east: 0.1, south: -0.1, north: 0.1 };
  const remote = path({ lat: 0, lon: 70 }, { lat: 0, lon: 71 });
  for (let i = 0; i < 10000; i++)
    index.add({ id: i, lat: 0, lon: 70, [CONTEXT_LINES]: [remote] });
  const crossing = {
    id: 'trail',
    lat: 0,
    lon: -3,
    [CONTEXT_LINES]: [path({ lat: 0, lon: -3 }, { lat: 0, lon: 3 })],
  };
  const grounds = {
    id: 'grounds',
    lat: 2,
    lon: 2,
    [CONTEXT_AREA]: [
      [
        [-2, -2],
        [2, -2],
        [2, 2],
        [-2, 2],
        [-2, -2],
      ],
    ],
  };
  const entrances = {
    id: 'entrances',
    lat: 9,
    lon: 9,
    parts: [{ lat: 0, lon: 0 }],
  };
  for (const park of [crossing, grounds, entrances]) index.add(park);
  const island = {
    id: 'island trail',
    lat: 20,
    lon: 178,
    [CONTEXT_LINES]: [path({ lat: 20, lon: 178 }, { lat: 20, lon: -179 })],
  };
  index.add(island);
  const islandView = { west: 179, east: -179, south: 19, north: 21 };
  assert.deepEqual([...index.points([islandView])], [island]);
  assert.equal(
    [...index.points([{ west: -180, east: 180, south: -90, north: 90 }])]
      .length,
    10004,
  );
  const matches = [...index.points([rect, rect])].map((p) => p.id);
  assert.equal(matches.length, 3);
  assert.deepEqual(matches, ['trail', 'grounds', 'entrances']);
});

test("cells come nearest first and never overstate a point's distance", () => {
  const index = createInspectorSpatialIndex();
  for (let i = 0; i < 200; i++)
    index.add({ lat: ((i * 157) % 199) / 100, lon: ((i * 97) % 211) / 100 });
  const rect = { west: 0, east: 0.1, south: 0, north: 0.1 };
  const distance = (at) => distanceToInspectorBounds(at, rect);
  for (const size of [3, 10]) {
    const bounds = [{ west: 0, south: 0, north: size, east: size }];
    let previous = -Infinity;
    let total = 0;
    for (const { cell, minKm } of index.cellsByDistance(bounds, distance)) {
      assert.ok(minKm >= previous);
      for (const at of cell) assert.ok(minKm <= distance(at));
      previous = minKm;
      total += cell.length;
    }
    assert.equal(total, 200);
  }
});

test('an empty park view stops measuring after the nearest eligible three are found', (t) => {
  const index = createInspectorSpatialIndex();
  const rect = { west: -0.01, east: 0.01, south: -0.01, north: 0.01 };
  for (let i = 1; i <= 4; i++)
    index.add({ id: String(i), lat: 0, lon: 0.011 * i });
  for (let i = 0; i < 5000; i++)
    index.add({ id: 'far-' + i, lat: 0.01, lon: 3 + i / 100000 });
  let calls = 0;
  const closest = (at) => {
    calls++;
    return distanceToInspectorBounds(at, rect);
  };
  const bounds = [expandInspectorBounds(rect, 1000)];
  const inspector = {
    radius: 0.1,
    localScopes: { anchor: { lat: 0, lon: 0 }, excludeKey: 'parks:1' },
    index,
    isPoint: inspectorPointRecord,
    closestLimit: 1000,
    closest,
    closestCells: index.cellsByDistance(bounds, closest),
    snapshot: { source: null, points: index.points([rect]) },
  };
  const row = { id: 'parks', enabled: true };
  const group = viewSummaryForLayer(
    { layers: new Map([[row.id, row]]) },
    row,
    rect,
    { lat: 0, lon: 0 },
    { clipViewport: true, heightM: 50_000, inspector },
  );
  assert.equal(group.scope, 'closest');
  assert.deepEqual(
    group.items.map(({ identity }) => identity.id),
    ['2', '3', '4'],
  );
  t.diagnostic(`${calls} distance measurements for 5004 parks`);
  assert.ok(calls < 200);
});
