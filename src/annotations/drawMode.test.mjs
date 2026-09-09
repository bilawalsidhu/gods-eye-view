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
  isDrawModeActive,
  setDrawModeActive,
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

test('the draw-mode flag is a plain module switch the click gesture can read', () => {
  assert.equal(isDrawModeActive(), false);
  assert.equal(setDrawModeActive(true), true);
  assert.equal(isDrawModeActive(), true);
  setDrawModeActive(false);
  assert.equal(isDrawModeActive(), false);
});
