import assert from 'node:assert/strict';
import test from 'node:test';
import * as geo from '../../geo/index.js';
import { polygonShape, rectangleShape } from './shapes.js';

const vertex = (shape, index) => {
  const v = shape.attributes.position.values;
  return geo.cartographic.fromCartesian(
    geo.cartesian3.create(v[index * 3], v[index * 3 + 1], v[index * 3 + 2]),
  );
};
const area = (shape) => {
  // Sum of triangle areas in square metres.
  const v = shape.attributes.position.values,
    i = shape.indices;
  const p = (k) => geo.cartesian3.create(v[k * 3], v[k * 3 + 1], v[k * 3 + 2]);
  let sum = 0;
  for (let t = 0; t < i.length; t += 3) {
    const a = p(i[t]),
      ab = geo.cartesian3.subtract(p(i[t + 1]), a, geo.cartesian3.create()),
      ac = geo.cartesian3.subtract(p(i[t + 2]), a, geo.cartesian3.create());
    sum +=
      geo.cartesian3.magnitude(
        geo.cartesian3.cross(ab, ac, geo.cartesian3.create()),
      ) / 2;
  }
  return sum;
};

test('a pack polygon fills its outline less its holes, each vertex at its own height', () => {
  const square = [
    [-97.75, 30.25, 10],
    [-97.74, 30.25, 10],
    [-97.74, 30.26, 10],
    [-97.75, 30.26, 10],
    [-97.75, 30.25, 10],
  ];
  const hole = [
    [-97.747, 30.253, 10],
    [-97.743, 30.253, 10],
    [-97.743, 30.257, 10],
    [-97.747, 30.257, 10],
  ];
  const full = polygonShape([square]);
  const holed = polygonShape([square, hole]);
  assert.equal(full.indices.length, 6, 'the closing vertex is not repeated');
  assert.ok(
    Math.abs(area(holed) / area(full) - (1 - 0.16)) < 0.01,
    `the hole is left out: ${area(holed) / area(full)}`,
  );
  for (let k = 0; k < holed.attributes.position.values.length / 3; k++)
    assert.ok(Math.abs(vertex(holed, k).height - 10) < 1e-6);
  assert.equal(polygonShape([[square[0], square[1]]]), null);
});

test('a raised polygon keeps its authored vertices as on Cesium', () => {
  const shape = polygonShape([
    [
      [0, 0],
      [3, 0],
      [3, 1],
      [0, 1],
    ],
  ]);
  assert.equal(shape.attributes.position.values.length / 3, 4);
});

test('a pack image rectangle maps its texture from the south-west corner', () => {
  const shape = rectangleShape([-97.8, 30.2, -97.7, 30.3], 25);
  const st = shape.attributes.st.values;
  assert.deepEqual([...st.slice(0, 2)], [0, 0]);
  assert.deepEqual([...st.slice(-2)], [1, 1]);
  const first = vertex(shape, 0),
    last = vertex(shape, st.length / 2 - 1);
  assert.ok(Math.abs(geo.math.toDegrees(first.longitude) + 97.8) < 1e-9);
  assert.ok(Math.abs(geo.math.toDegrees(last.latitude) - 30.3) < 1e-9);
  assert.ok(Math.abs(first.height - 25) < 1e-6);
  assert.equal(shape.indices.length, 6);
  const wide = rectangleShape([10, 0, 13.5, 1]);
  assert.equal(wide.indices.length, 4 * 1 * 6, 'cells of at most a degree');
});

test('pack polygon triangle area follows Cesium for concave rings, holes and the antimeridian', async () => {
  const C = await import('cesium');
  for (const rings of [
    [
      [
        [20, 10, 200],
        [21, 10, 300],
        [20.5, 10.5, 200],
        [21, 11, 300],
        [20, 11, 200],
      ],
    ],
    [
      [
        [20, 10, 200],
        [21, 10, 200],
        [21, 11, 200],
        [20, 11, 200],
      ],
      [
        [20.2, 10.2, 200],
        [20.8, 10.2, 200],
        [20.8, 10.8, 200],
        [20.2, 10.8, 200],
      ],
    ],
    [
      [
        [179.8, 10, 50],
        [-179.8, 10, 50],
        [-179.8, 10.2, 50],
        [179.8, 10.2, 50],
      ],
    ],
  ]) {
    const hierarchy = (ring) =>
      new C.PolygonHierarchy(ring.map((p) => C.Cartesian3.fromDegrees(...p)));
    const outer = hierarchy(rings[0]);
    outer.holes = rings.slice(1).map(hierarchy);
    const native = C.PolygonGeometry.createGeometry(
      new C.PolygonGeometry({
        polygonHierarchy: outer,
        perPositionHeight: true,
        vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
        arcType: C.ArcType.GEODESIC,
      }),
    );
    const shared = polygonShape(rings);
    assert.ok(Math.abs(area(shared) / area(native) - 1) < 0.00001);
    assert.equal(shared.indices.length, native.indices.length);
  }
});
