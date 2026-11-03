// Area geometry: containment over full MultiPolygons (islands, holes, the
// antimeridian), OSM relation assembly and display copies that never touch the
// counting geometry.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  circleRing,
  displayParts,
  multiPolygonAreaKm2,
  multiPolygonCounts,
  normalizeMultiPolygon,
  pointInPreparedArea,
  prepareArea,
} from './areaGeometry.js';

const square = (w, s, e, n) => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];

test('a point on an island counts, not only on the largest part', () => {
  // Mainland 0..10, island 20..22: the old largest-ring shortcut dropped the island.
  const area = prepareArea([[square(0, 0, 10, 10)], [square(20, 0, 22, 2)]]);
  assert.equal(pointInPreparedArea(area, 5, 5), true);
  assert.equal(pointInPreparedArea(area, 1, 21), true);
  assert.equal(pointInPreparedArea(area, 1, 15), false);
});

test('a point inside a hole is outside the area', () => {
  const area = prepareArea([[square(0, 0, 10, 10), square(4, 4, 6, 6)]]);
  assert.equal(pointInPreparedArea(area, 5, 5), false);
  assert.equal(pointInPreparedArea(area, 2, 2), true);
  // An island inside the hole (an enclave within an enclave) counts again.
  const nested = prepareArea([
    [square(0, 0, 10, 10), square(3, 3, 7, 7)],
    [square(4, 4, 6, 6)],
  ]);
  assert.equal(pointInPreparedArea(nested, 5, 5), true);
  assert.equal(pointInPreparedArea(nested, 3.5, 3.5), false);
});

test('a ring crossing the antimeridian contains points on both sides', () => {
  // 175E → 175W as one continuous ring (a drawn box over Fiji).
  const ring = [
    [175, -20],
    [-175, -20],
    [-175, -15],
    [175, -15],
    [175, -20],
  ];
  const area = prepareArea([[ring]]);
  assert.equal(area.crossesAntimeridian, true);
  assert.equal(pointInPreparedArea(area, -17, 178), true);
  assert.equal(pointInPreparedArea(area, -17, -178), true);
  assert.equal(pointInPreparedArea(area, -17, 0), false);
  assert.equal(pointInPreparedArea(area, -17, 170), false);
  // bbox is west > east across the line.
  assert.deepEqual(area.bbox, [175, -20, -175, -15]);
  // Area of a 10°×5° box near 17°S, not the 350° long way round.
  const km2 = multiPolygonAreaKm2([[ring]]);
  assert.ok(km2 > 500_000 && km2 < 620_000, `area ${km2}`);
});

test('a multipolygon split at ±180 keeps a tight bbox', () => {
  const area = prepareArea([
    [square(177, -19, 180, -16)],
    [square(-180, -19, -178, -16)],
  ]);
  assert.equal(area.crossesAntimeridian, true);
  assert.deepEqual(area.bbox, [177, -19, -178, -16]);
  assert.equal(pointInPreparedArea(area, -17, -179), true);
  assert.equal(pointInPreparedArea(area, -17, 179), true);
});

test('a crossing part and a separate island share one tight longitude frame', () => {
  const crossing = [
    [175, -20],
    [-175, -20],
    [-175, -15],
    [175, -15],
    [175, -20],
  ];
  const area = prepareArea([
    [crossing],
    [square(-170, -19, -160, -16)],
  ]);
  assert.equal(area.crossesAntimeridian, true);
  assert.deepEqual(area.bbox, [175, -20, -160, -15]);
  assert.equal(pointInPreparedArea(area, -17, 178), true);
  assert.equal(pointInPreparedArea(area, -17, -165), true);
  assert.equal(pointInPreparedArea(area, -17, 0), false);
});

test('normalization closes rings and drops degenerate parts', () => {
  const multi = normalizeMultiPolygon({
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      [
        [0.2, 0.2],
        [0.2, 0.2],
      ],
    ],
  });
  assert.equal(multi.length, 1);
  assert.equal(multi[0].length, 1, 'degenerate hole dropped');
  assert.deepEqual(multi[0][0][0], multi[0][0][3]);
  assert.equal(
    normalizeMultiPolygon({ type: 'LineString', coordinates: [] }),
    null,
  );
  assert.equal(
    normalizeMultiPolygon([
      [
        [0, 0],
        [1, 1],
      ],
    ]),
    null,
  );
});

test('area subtracts holes and counts parts', () => {
  const coords = [
    [square(0, 0, 1, 1), square(0.25, 0.25, 0.75, 0.75)],
    [square(5, 5, 6, 6)],
  ];
  const whole = multiPolygonAreaKm2([[square(0, 0, 1, 1)]]);
  const km2 = multiPolygonAreaKm2(coords);
  assert.ok(km2 < whole * 2 && km2 > whole * 1.7, `${km2} vs ${whole}`);
  assert.deepEqual(multiPolygonCounts(coords), { parts: 2, holes: 1 });
});

test('display copies are bounded and leave the counting geometry intact', () => {
  const dense = [];
  for (let i = 0; i < 20_000; i += 1) {
    const a = (i / 20_000) * Math.PI * 2;
    dense.push([
      Math.cos(a) * (1 + 0.01 * Math.sin(a * 200)),
      Math.sin(a) * (1 + 0.01 * Math.sin(a * 200)),
    ]);
  }
  dense.push(dense[0].slice());
  const coords = [[dense]];
  const snapshot = JSON.stringify(coords);
  const shown = displayParts(coords, { maxVertices: 2000 });
  const total = shown.parts.reduce((sum, p) => sum + p.outer.length, 0);
  assert.ok(total <= 2000, `${total} vertices`);
  assert.equal(JSON.stringify(coords), snapshot, 'input untouched');
  // A point the simplified copy might shave off still counts on the original.
  const area = prepareArea(coords);
  assert.equal(pointInPreparedArea(area, 0, 0), true);
});

test('display copies keep the largest parts first', () => {
  const coords = [
    [square(0, 0, 1, 1)],
    [square(10, 10, 15, 15)],
    [square(20, 20, 20.1, 20.1)],
  ];
  const shown = displayParts(coords, { maxParts: 2 });
  assert.equal(shown.totalParts, 3);
  assert.equal(shown.drawnParts, 2);
  assert.equal(shown.parts[0].outer[0][0], 10);
});

test('a circle ring is closed and about the requested radius', () => {
  const ring = circleRing(37.8, -122.39, 500);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  const km2 = multiPolygonAreaKm2([[ring]]);
  assert.ok(Math.abs(km2 - Math.PI * 0.25) < 0.02, `${km2}`);
});
