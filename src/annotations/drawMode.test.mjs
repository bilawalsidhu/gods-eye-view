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
  assert.deepEqual(addVertex(line, { lon: 0.000001, lat: 0 }), { added: false, reason: 'duplicate' });
  assert.deepEqual(addVertex(line, { lon: 'x', lat: 0 }), { added: false, reason: 'invalid' });
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
  [[-97.74, 30.27], [-97.73, 30.27], [-97.73, 30.28]].forEach(([lon, lat]) => addVertex(area, { lon, lat }));
  assert.deepEqual(finishSpec(area, { label: ' Zilker ', color: 'amber' }), {
    type: 'area', manual: true, ring: [[-97.74, 30.27], [-97.73, 30.27], [-97.73, 30.28]], label: 'Zilker', color: 'amber',
  });
  const line = createDrawSession('line');
  addVertex(line, { lon: 0, lat: 0 });
  addVertex(line, { lon: 0.01, lat: 0 });
  assert.deepEqual(finishSpec(line), { type: 'route', manual: true, path: [[0, 0], [0.01, 0]], label: null, color: 'primary' });
  const pin = createDrawSession('pin');
  addVertex(pin, { lon: 151.2, lat: -33.9 });
  assert.deepEqual(finishSpec(pin, { label: 'A shed' }), { type: 'pin', manual: true, latitude: -33.9, longitude: 151.2, label: 'A shed', color: 'primary' });
});

test('length and area come out in metres on a local grid', () => {
  const km = pathLengthM([{ lon: 0, lat: 0 }, { lon: 0, lat: 0.009 }]);
  assert.ok(km > 990 && km < 1010, `1 km of latitude, got ${km}`);
  const square = [{ lon: 0, lat: 0 }, { lon: 0.001, lat: 0 }, { lon: 0.001, lat: 0.001 }, { lon: 0, lat: 0.001 }];
  const m2 = ringAreaM2(square);
  assert.ok(m2 > 12000 && m2 < 12800, `~111 m square, got ${m2}`);
  assert.deepEqual(ringCentroid(square), { lon: 0.0005, lat: 0.0005 });
});

test('the measure and the hint follow the shape and the vertex count', () => {
  const area = createDrawSession('area');
  assert.equal(drawHint(area), 'Click 3 more points.');
  [{ lon: 0, lat: 0 }, { lon: 0.01, lat: 0 }, { lon: 0.01, lat: 0.01 }].forEach((v) => addVertex(area, v));
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
  assert.deepEqual(addVertex(line, { lon: 200, lat: 0 }), { added: false, reason: 'invalid' });
  assert.equal(line.vertices.length, 0);
});

test('one shape holds at most MAX_VERTICES points', () => {
  const line = createDrawSession('line');
  for (let i = 0; i < MAX_VERTICES + 25; i += 1) addVertex(line, { lon: i * 0.001, lat: 0 });
  assert.equal(line.vertices.length, MAX_VERTICES);
  assert.deepEqual(addVertex(line, { lon: 99, lat: 1 }), { added: false, reason: 'full' });
  assert.match(drawHint(line), /512-point limit reached/);

  // A pin replaces its one vertex forever: the ceiling cannot strand it.
  const pin = createDrawSession('pin');
  for (let i = 0; i < MAX_VERTICES + 5; i += 1) assert.equal(addVertex(pin, { lon: i * 0.01, lat: 0 }).added, true);
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
