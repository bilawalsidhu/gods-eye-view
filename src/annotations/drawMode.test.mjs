// Pure tests for the manual draw session. Run with: npm test (node --test). No Cesium, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDrawSession,
  addVertex,
  removeLastVertex,
  canFinish,
  finishSpec,
  normalizeShape,
  pathLengthM,
  ringAreaM2,
  ringCentroid,
  formatMeasure,
  drawHint,
  finishReason,
  isFiniteCoordinate,
  closeRing,
  unwrapLongitudes,
  wrapLongitude,
  MAX_VERTICES,
  MIN_VERTICES,
} from './drawMode.js';

test('shapes normalize to area, line or pin, and unknown words fall back to area', () => {
  assert.equal(normalizeShape('route'), 'line');
  assert.equal(normalizeShape('marker'), 'pin');
  assert.equal(normalizeShape('polygon'), 'area');
  assert.equal(normalizeShape(undefined), 'area');
});

test('an area needs three vertices, a line two, a pin one', () => {
  const area = createDrawSession('area');
  addVertex(area, { lon: -97.74, lat: 30.27 });
  addVertex(area, { lon: -97.73, lat: 30.27 });
  assert.equal(canFinish(area), false);
  addVertex(area, { lon: -97.73, lat: 30.28 });
  assert.equal(canFinish(area), true);
  assert.equal(MIN_VERTICES.line, 2);
  assert.equal(MIN_VERTICES.pin, 1);
});

test('a second click within half a metre is the tail of a double-click, not a vertex', () => {
  const line = createDrawSession('line');
  assert.deepEqual(addVertex(line, { lon: 0, lat: 0 }), { added: true });
  assert.deepEqual(addVertex(line, { lon: 0.000001, lat: 0 }), {
    added: false,
    reason: 'duplicate',
  });
  assert.deepEqual(addVertex(line, { lon: 'x', lat: 0 }), {
    added: false,
    reason: 'invalid',
  });
  assert.equal(line.vertices.length, 1);
});

test('a pin keeps exactly one vertex: a later click moves it', () => {
  const pin = createDrawSession('pin');
  addVertex(pin, { lon: 1, lat: 1 });
  addVertex(pin, { lon: 2, lat: 2 });
  assert.equal(pin.vertices.length, 1);
  assert.deepEqual(pin.vertices[0], { lon: 2, lat: 2, height: 0 });
});

test('backspace removes the last vertex and reports whether it did', () => {
  const s = createDrawSession('line');
  assert.equal(removeLastVertex(s), false);
  addVertex(s, { lon: 0, lat: 0 });
  assert.equal(removeLastVertex(s), true);
  assert.equal(s.vertices.length, 0);
});

test('finishSpec yields the engine spec shapes with manual geometry, or null when unfinished', () => {
  const area = createDrawSession('area');
  assert.equal(finishSpec(area), null);
  [
    [-97.74, 30.27],
    [-97.73, 30.27],
    [-97.73, 30.28],
  ].forEach(([lon, lat]) => addVertex(area, { lon, lat }));
  assert.deepEqual(finishSpec(area, { label: ' Zilker ', color: 'amber' }), {
    type: 'area',
    manual: true,
    // CLOSED: the last position repeats the first so the outline polyline
    // draws all three sides of the triangle, not two.
    ring: [
      [-97.74, 30.27],
      [-97.73, 30.27],
      [-97.73, 30.28],
      [-97.74, 30.27],
    ],
    label: 'Zilker',
    color: 'amber',
  });
  const line = createDrawSession('line');
  addVertex(line, { lon: 0, lat: 0 });
  addVertex(line, { lon: 0.01, lat: 0 });
  assert.deepEqual(finishSpec(line), {
    type: 'route',
    manual: true,
    path: [
      [0, 0],
      [0.01, 0],
    ],
    label: null,
    color: 'primary',
  });
  const pin = createDrawSession('pin');
  addVertex(pin, { lon: 151.2, lat: -33.9 });
  assert.deepEqual(finishSpec(pin, { label: 'A shed' }), {
    type: 'pin',
    manual: true,
    latitude: -33.9,
    longitude: 151.2,
    label: 'A shed',
    color: 'primary',
  });
});

test('length and area come out in metres on a local grid', () => {
  const km = pathLengthM([
    { lon: 0, lat: 0 },
    { lon: 0, lat: 0.009 },
  ]);
  assert.ok(km > 990 && km < 1010, `1 km of latitude, got ${km}`);
  const square = [
    { lon: 0, lat: 0 },
    { lon: 0.001, lat: 0 },
    { lon: 0.001, lat: 0.001 },
    { lon: 0, lat: 0.001 },
  ];
  const m2 = ringAreaM2(square);
  assert.ok(m2 > 12000 && m2 < 12800, `~111 m square, got ${m2}`);
  assert.deepEqual(ringCentroid(square), { lon: 0.0005, lat: 0.0005 });
});

test('the measure and the hint follow the shape and the vertex count', () => {
  const area = createDrawSession('area');
  assert.equal(drawHint(area), 'Click 3 more points.');
  [
    { lon: 0, lat: 0 },
    { lon: 0.01, lat: 0 },
    { lon: 0.01, lat: 0.01 },
  ].forEach((v) => addVertex(area, v));
  assert.match(formatMeasure(area), /ha$|km²$|m²$/);
  assert.match(drawHint(area), /double-click or Enter to finish/);
  const pin = createDrawSession('pin');
  assert.equal(drawHint(pin), 'Click where the pin goes.');
  assert.equal(drawHint(null), 'Pick a shape, then click the map.');
});

test('a vertex must be a finite coordinate on the globe', () => {
  assert.equal(isFiniteCoordinate({ lon: 12, lat: -4 }), true);
  assert.equal(isFiniteCoordinate({ lon: 0, lat: 90 }), true);
  for (const bad of [
    null,
    {},
    { lon: NaN, lat: 0 },
    { lon: 0, lat: Infinity },
    { lon: 181, lat: 0 },
    { lon: 0, lat: -90.5 },
    { lon: '10', lat: 10 },
  ]) {
    assert.equal(isFiniteCoordinate(bad), false, JSON.stringify(bad));
  }
  const line = createDrawSession('line');
  assert.deepEqual(addVertex(line, { lon: 200, lat: 0 }), {
    added: false,
    reason: 'invalid',
  });
  assert.equal(line.vertices.length, 0);
});

test('one shape holds at most MAX_VERTICES points', () => {
  const line = createDrawSession('line');
  for (let i = 0; i < MAX_VERTICES + 25; i += 1)
    addVertex(line, { lon: i * 0.001, lat: 0 });
  assert.equal(line.vertices.length, MAX_VERTICES);
  assert.deepEqual(addVertex(line, { lon: 99, lat: 1 }), {
    added: false,
    reason: 'full',
  });
  assert.match(drawHint(line), /512-point limit reached/);

  // A pin replaces its one vertex forever: the ceiling cannot strand it.
  const pin = createDrawSession('pin');
  for (let i = 0; i < MAX_VERTICES + 5; i += 1)
    assert.equal(addVertex(pin, { lon: i * 0.01, lat: 0 }).added, true);
  assert.equal(pin.vertices.length, 1);
});

test('a shape that encloses nothing is refused, with a reason', () => {
  // Three points on one meridian are not an area.
  const collinear = createDrawSession('area');
  for (const lat of [0, 0.001, 0.002]) addVertex(collinear, { lon: 0, lat });
  assert.equal(collinear.vertices.length, 3);
  assert.equal(finishReason(collinear), 'degenerate');
  assert.equal(canFinish(collinear), false);
  assert.equal(finishSpec(collinear), null);
  assert.match(drawHint(collinear), /in a line/);

  // Moving one point off that line makes it a shape again.
  collinear.vertices[2].lon = 0.001;
  assert.equal(finishReason(collinear), 'ok');
  assert.ok(finishSpec(collinear));

  // A line whose two ends are a handful of centimetres apart has no length.
  const stub = createDrawSession('line');
  addVertex(stub, { lon: 0, lat: 0 });
  addVertex(stub, { lon: 0.000007, lat: 0 }, { minSeparationM: 0.01 });
  assert.equal(stub.vertices.length, 2);
  assert.equal(finishReason(stub), 'degenerate');
  assert.equal(finishSpec(stub), null);
  assert.match(drawHint(stub), /no length/);

  // And the states in between are named, not lumped together.
  assert.equal(finishReason(createDrawSession('area')), 'too-few');
  assert.equal(finishReason(null), 'invalid');
});

test('a finished area is a CLOSED ring, so its outline has no missing side', () => {
  const area = createDrawSession('area');
  for (const [lon, lat] of [
    [-97.74, 30.27],
    [-97.73, 30.27],
    [-97.73, 30.28],
  ])
    addVertex(area, { lon, lat });

  const spec = finishSpec(area);
  assert.equal(
    spec.ring.length,
    4,
    'three clicked vertices become four ring positions',
  );
  assert.deepEqual(
    spec.ring.at(-1),
    spec.ring[0],
    'the last position repeats the first',
  );
  // The renderer draws the outline as a polyline over exactly these positions:
  // an open ring would draw two of the triangle's three sides.
  assert.equal(spec.ring.length - 1, area.vertices.length);

  // A line is NOT closed — it is a path, and joining its ends would invent a
  // segment the person never drew.
  const line = createDrawSession('line');
  addVertex(line, { lon: 0, lat: 0 });
  addVertex(line, { lon: 0.01, lat: 0 });
  assert.equal(finishSpec(line).path.length, 2);

  // closeRing is idempotent: finishing an already-closed ring adds nothing.
  const closed = closeRing([
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ]);
  assert.equal(closed.length, 4);
});

test('a shape straddling the antimeridian measures what it looks like', () => {
  // 0.002 degrees square at the equator — about 223 m a side, so ~49,600 m2 —
  // sitting across 180. Raw longitude arithmetic reads that 0.002-degree width
  // as 359.998 degrees: the area came out in the thousands of square
  // kilometres and the centroid landed on the Greenwich meridian, half a world
  // from the shape it belongs to.
  const rectangle = [
    { lon: 179.999, lat: -0.001 },
    { lon: -179.999, lat: -0.001 },
    { lon: -179.999, lat: 0.001 },
    { lon: 179.999, lat: 0.001 },
  ];
  const area = ringAreaM2(rectangle);
  assert.ok(
    area > 45_000 && area < 55_000,
    `a ~223 m x ~223 m patch is ~49,600 m2, got ${Math.round(area)} m2`,
  );
  assert.ok(area < 1e6, 'and nowhere near a square kilometre');

  const centre = ringCentroid(rectangle);
  assert.ok(
    Math.abs(Math.abs(centre.lon) - 180) < 0.01,
    `the centre belongs on the antimeridian, got lon ${centre.lon}`,
  );
  assert.ok(Math.abs(centre.lat) < 0.01, `got lat ${centre.lat}`);

  // Length was already safe — haversine is periodic in the longitude delta —
  // and this pins that so a "fix" cannot break it.
  const across = pathLengthM([
    { lon: 179.999, lat: 0 },
    { lon: -179.999, lat: 0 },
  ]);
  assert.ok(
    across > 150 && across < 300,
    `about 222 m, got ${Math.round(across)} m`,
  );

  // The same shape away from the seam still measures the same.
  const inland = rectangle.map((v) => ({ lon: v.lon - 179.999, lat: v.lat }));
  assert.ok(
    Math.abs(ringAreaM2(inland) - area) < 1,
    'position must not change size',
  );

  // And the ordinary case is untouched.
  const austin = [
    { lon: -97.75, lat: 30.26 },
    { lon: -97.74, lat: 30.26 },
    { lon: -97.74, lat: 30.27 },
  ];
  const centroid = ringCentroid(austin);
  assert.ok(Math.abs(centroid.lon + 97.7433) < 0.001);
  assert.ok(Math.abs(centroid.lat - 30.2633) < 0.001);
});

test('longitude unwrapping is continuous and re-wraps to one canonical range', () => {
  const unwrapped = unwrapLongitudes([
    { lon: 179.9, lat: 0 },
    { lon: -179.9, lat: 0 },
  ]);
  assert.equal(unwrapped[0].lon, 179.9);
  assert.ok(
    Math.abs(unwrapped[1].lon - 180.1) < 1e-9,
    `continuous neighbour, got ${unwrapped[1].lon}`,
  );
  assert.equal(wrapLongitude(180.1).toFixed(4), (-179.9).toFixed(4));
  assert.equal(wrapLongitude(-190), 170);
  assert.equal(wrapLongitude(10), 10);
  assert.equal(wrapLongitude(180), -180);
  assert.equal(unwrapLongitudes([]).length, 0);
});
