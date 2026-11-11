import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../geo/index.js';
import { planImport } from './geoImportPlan.js';
import { emptyRecords } from './geoImportRecords.js';

const random = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const ringArea = (ring) =>
  Math.abs(
    ring.reduce((sum, p, i) => {
      const q = ring[(i + 1) % ring.length];
      return sum + p[0] * q[1] - q[0] * p[1];
    }, 0),
  ) / 2;
function triangulated(rings, center) {
  const records = emptyRecords();
  records.polygons.push({
    rings,
    raised: true,
    fill: [1, 0, 0, 1],
    outline: null,
  });
  const plan = planImport(records);
  assert.equal(plan.report.drawn, 1);
  assert.equal(plan.meshes.length, 1);
  const { positions, indices } = plan.meshes[0];
  const points = [];
  for (let i = 0; i < positions.length; i += 3) {
    const p = geo.cartographic.fromCartesian({
      x: positions[i],
      y: positions[i + 1],
      z: positions[i + 2],
    });
    const lon = geo.math.toDegrees(p.longitude);
    const unwrapped = lon - 360 * Math.round((lon - center[0]) / 360);
    points.push([
      unwrapped - center[0],
      geo.math.toDegrees(p.latitude) - center[1],
    ]);
  }
  const local = rings.flat().map(([x, y]) => [x - center[0], y - center[1]]);
  const min = [0, 1].map((axis) => Math.min(...local.map((p) => p[axis])));
  const max = [0, 1].map((axis) => Math.max(...local.map((p) => p[axis])));
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const triangle = Array.from(
      indices.slice(i, i + 3),
      (index) => points[index],
    );
    for (const p of triangle)
      for (let axis = 0; axis < 2; axis++)
        assert.ok(
          p[axis] >= min[axis] - 1e-9 && p[axis] <= max[axis] + 1e-9,
          'triangle stays inside ring bounds',
        );
    area += ringArea(triangle);
  }
  return area;
}

for (let seed = 1; seed <= 128; seed++) {
  test(`raised polygon area, bounds, closure and winding (seed ${seed})`, () => {
    const next = random(seed);
    const center = [
      seed % 8 === 0 ? 179.99 : next() * 350 - 175,
      next() * 170 - 85,
    ];
    const radius = 0.01 + next() * 0.1;
    const height = next() * 5000 - 200;
    const count = 6 + Math.floor(next() * 40);
    // Ordered radial vertices make simple concave outlines. Small, disjoint
    // holes stay inside their minimum radius even near a pole or the dateline.
    const outer = Array.from({ length: count }, (_, i) => {
      const angle = (2 * Math.PI * i) / count;
      const r = radius * (0.7 + next() * 0.3);
      return [
        center[0] + Math.cos(angle) * r,
        center[1] + Math.sin(angle) * r,
        height,
      ];
    });
    const holes = Array.from({ length: seed % 4 }, (_, h) => {
      const x = center[0] + (h - 1) * radius * 0.3;
      return Array.from({ length: 5 + h }, (_, i) => {
        const angle = (2 * Math.PI * i) / (5 + h);
        return [
          x + Math.cos(angle) * radius * 0.08,
          center[1] + Math.sin(angle) * radius * 0.08,
          height,
        ];
      });
    });
    const rings = [outer, ...holes];
    const areas = rings.map((ring) =>
      ringArea(ring.map(([x, y]) => [x - center[0], y - center[1]])),
    );
    const expected = areas[0] - areas.slice(1).reduce((sum, n) => sum + n, 0);
    const actual = triangulated(rings, center);
    assert.ok(
      Math.abs(actual - expected) / expected < 0.01,
      `area ${actual} matches ${expected}`,
    );
    for (const variant of [
      rings.map((r) => [...r, r[0]]),
      rings.map((r) => [...r].reverse()),
      [outer, ...holes.map((r) => [...r].reverse())],
    ]) {
      const changed = triangulated(variant, center);
      assert.ok(
        Math.abs(changed - actual) / actual < 1e-8,
        'closure and winding preserve area',
      );
    }
  });
}
