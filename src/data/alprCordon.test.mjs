// Cordon analysis — pure rules. Node-only, no Cesium, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCordonRoadsQuery,
  normalizeCordonRoads,
  pickCordonBoundary,
  stitchOuterRing,
  ringBox,
  cordonPointInRing,
  ringCrossings,
  nearestCameraToRoadM,
  dedupeCrossings,
  computeCordon,
} from './alprCameras.js';

// Square test town: lon −97.745…−97.735, lat 30.265…30.275 (~1 km across).
const TOWN_RING = [
  [-97.745, 30.265],
  [-97.735, 30.265],
  [-97.735, 30.275],
  [-97.745, 30.275],
];

const way = (id, highway, coords, tags = {}) => ({
  type: 'way',
  id,
  tags: { highway, ...tags },
  geometry: coords.map(([lon, lat]) => ({ lat, lon })),
});

test('cordon roads query is bbox-bounded, class-filtered and capped', () => {
  const query = buildCordonRoadsQuery({
    south: 30.26,
    west: -97.75,
    north: 30.28,
    east: -97.73,
  });
  assert.match(query, /\(30\.26,-97\.75,30\.28,-97\.73\)/);
  assert.match(query, /highway/);
  assert.match(query, /motorway.*residential/);
  assert.match(query, /out geom 4000;$/);
});

test('road normalization keeps drivable classes and drops paths and stubs', () => {
  const payload = {
    elements: [
      way(1, 'primary', [[-97.75, 30.27], [-97.74, 30.27]], { name: 'Main Street' }),
      way(2, 'trunk_link', [[-97.75, 30.27], [-97.74, 30.27]]),
      way(3, 'footway', [[-97.75, 30.27], [-97.74, 30.27]]),
      way(4, 'service', [[-97.75, 30.27], [-97.74, 30.27]]),
      way(5, 'primary', [[-97.75, 30.27]]), // one point — not a line
      { type: 'node', id: 6, lat: 30.27, lon: -97.74 },
    ],
  };
  const roads = normalizeCordonRoads(payload);
  assert.deepEqual(
    roads.map((r) => [r.id, r.cls, r.baseCls]),
    [
      [1, 'primary', 'primary'],
      [2, 'trunk_link', 'trunk'],
    ],
  );
  assert.equal(roads[0].name, 'Main Street');
});

test('boundary candidates order municipality-first with deterministic ties', () => {
  const area = (id, level, name = `L${level}`) => ({
    type: 'area',
    id,
    tags: { boundary: 'administrative', admin_level: String(level), name },
  });
  const picked = pickCordonBoundary([
    area(60, 6),
    area(90, 9),
    area(81, 8),
    area(80, 8),
    area(70, 7),
    area(20, 2), // country — never a cordon
    { type: 'area', id: 99, tags: { boundary: 'administrative', admin_level: '8' } }, // unnamed
    { type: 'area', id: 98, tags: { admin_level: '8', name: 'not admin' } },
  ]);
  assert.deepEqual(
    picked.map((c) => [c.id, c.level]),
    [
      [80, 8],
      [81, 8],
      [90, 9],
      [70, 7],
      [60, 6],
    ],
  );
});

test('outer ways chain into one ring, reversing and skipping inner members', () => {
  const ring = stitchOuterRing({
    members: [
      { role: 'outer', geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }] },
      // Reversed continuation: its END matches the current tail.
      { role: 'outer', geometry: [{ lat: 1, lon: 1 }, { lat: 0, lon: 1 }] },
      { role: 'inner', geometry: [{ lat: 5, lon: 5 }, { lat: 5, lon: 6 }] },
      { role: 'outer', geometry: [{ lat: 1, lon: 1 }, { lat: 0, lon: 0 }] },
    ],
  });
  assert.deepEqual(ring, [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ]);
  assert.deepEqual(ringBox(ring), { south: 0, west: 0, north: 1, east: 1 });
});

test('containment and crossing detection agree on the square town', () => {
  assert.equal(cordonPointInRing(TOWN_RING, 30.27, -97.74), true);
  assert.equal(cordonPointInRing(TOWN_RING, 30.27, -97.75), false);

  const entering = [
    { lat: 30.27, lon: -97.75 },
    { lat: 30.27, lon: -97.74 },
  ];
  const crossings = ringCrossings(TOWN_RING, entering);
  assert.equal(crossings.length, 1);
  assert.ok(Math.abs(crossings[0].lon - -97.745) < 1e-9, 'gate sits on the west edge');
  assert.ok(Math.abs(crossings[0].lat - 30.27) < 1e-9);

  const inside = [
    { lat: 30.27, lon: -97.744 },
    { lat: 30.27, lon: -97.736 },
  ];
  assert.equal(ringCrossings(TOWN_RING, inside).length, 0);

  const through = [
    { lat: 30.27, lon: -97.75 },
    { lat: 30.27, lon: -97.73 },
  ];
  assert.equal(ringCrossings(TOWN_RING, through).length, 2, 'a through road enters and leaves');
});

test('camera-to-road distance gates coverage at the configured radius', () => {
  const road = [
    { lat: 30.27, lon: -97.75 },
    { lat: 30.27, lon: -97.74 },
  ];
  const near = nearestCameraToRoadM(
    [{ latitude: 30.2701, longitude: -97.7445 }],
    road,
  );
  assert.ok(near > 5 && near < 20, `~11 m expected, got ${near}`);
  const far = nearestCameraToRoadM(
    [{ latitude: 30.272, longitude: -97.7445 }],
    road,
  );
  assert.ok(far > 200 && far < 250, `~220 m expected, got ${far}`);
  assert.equal(nearestCameraToRoadM([], road), Infinity);
});

test('nearby same-name crossings merge; different roads never do', () => {
  const base = { baseCls: 'trunk', covered: false, nearestCameraM: Infinity };
  const merged = dedupeCrossings([
    { ...base, name: 'Big Highway', lat: 30.275, lon: -97.744 },
    { ...base, name: 'Big Highway', lat: 30.275, lon: -97.7442, covered: true, nearestCameraM: 40 },
    { ...base, name: 'Other Road', lat: 30.275, lon: -97.7441 },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].covered, true, 'a merged gate is covered when any part is');
  assert.equal(merged[0].nearestCameraM, 40);
});

test('computeCordon: gates, merge, coverage and honest class totals', () => {
  const roads = normalizeCordonRoads({
    elements: [
      // Covered west entry: camera ~11 m off the polyline.
      way(1, 'primary', [[-97.75, 30.27], [-97.74, 30.27]], { name: 'Main Street' }),
      // Uncovered east entry.
      way(2, 'residential', [[-97.734, 30.268], [-97.74, 30.268]], { name: 'Quiet Road' }),
      // Dual carriageway crossing the north edge twice ~19 m apart → one gate.
      way(3, 'trunk', [[-97.744, 30.272], [-97.744, 30.278]], { name: 'Big Highway' }),
      way(4, 'trunk', [[-97.7442, 30.272], [-97.7442, 30.278]], { name: 'Big Highway' }),
      // Fully inside — no gate.
      way(5, 'residential', [[-97.744, 30.27], [-97.736, 30.27]], { name: 'Inner Loop' }),
    ],
  });
  const { gates, stats } = computeCordon({
    ring: TOWN_RING,
    roads,
    cameras: [{ latitude: 30.2701, longitude: -97.7445 }],
  });
  assert.equal(stats.total, 3);
  assert.equal(stats.covered, 1);
  assert.ok(Math.abs(stats.share - 1 / 3) < 1e-9);
  assert.deepEqual(stats.majors, { total: 2, covered: 1 });
  assert.deepEqual(stats.byClass, {
    primary: { total: 1, covered: 1 },
    residential: { total: 1, covered: 0 },
    trunk: { total: 1, covered: 0 },
  });
  const gaps = gates.filter((gate) => !gate.covered);
  assert.deepEqual(
    gaps.map((gate) => gate.name).sort(),
    ['Big Highway', 'Quiet Road'],
  );
});
