import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGeofenceSession,
  addVertex,
  removeLastVertex,
  moveVertex,
  removeVertex,
  insertVertex,
  clearSession,
  canFinish,
  finishReason,
  toClosedLonLat,
  toGeoJSON,
  fromGeoJSON,
  ringAreaM2,
} from './geofenceModel.js';

test('draw: needs 3 points to close', () => {
  const s = createGeofenceSession();
  assert.equal(canFinish(s), false);
  assert.equal(finishReason(s), 'too-few');
  addVertex(s, { lon: 0, lat: 0 });
  addVertex(s, { lon: 1, lat: 0 });
  assert.equal(finishReason(s), 'too-few');
  addVertex(s, { lon: 0, lat: 1 });
  assert.equal(canFinish(s), true);
  assert.equal(finishReason(s), 'ok');
});

test('draw: degenerate collinear ring is rejected', () => {
  const s = createGeofenceSession();
  addVertex(s, { lon: 0, lat: 0 });
  addVertex(s, { lon: 1, lat: 0 });
  addVertex(s, { lon: 2, lat: 0 });
  assert.equal(finishReason(s), 'degenerate');
});

test('draw: duplicate click within tolerance is ignored', () => {
  const s = createGeofenceSession();
  addVertex(s, { lon: 0, lat: 0 });
  const r = addVertex(s, { lon: 0, lat: 0 });
  assert.equal(r.added, false);
  assert.equal(r.reason, 'duplicate');
  assert.equal(s.vertices.length, 1);
});

test('close: ring is explicitly closed for rendering', () => {
  const s = createGeofenceSession();
  addVertex(s, { lon: -122, lat: 37 });
  addVertex(s, { lon: -121, lat: 37 });
  addVertex(s, { lon: -121, lat: 38 });
  const closed = toClosedLonLat(s);
  assert.equal(closed.length, 4);
  assert.deepEqual(closed[0], closed[3]);
});

test('edit: moveVertex updates position', () => {
  const s = createGeofenceSession();
  addVertex(s, { lon: 0, lat: 0 });
  addVertex(s, { lon: 1, lat: 0 });
  addVertex(s, { lon: 0, lat: 1 });
  assert.ok(moveVertex(s, 0, { lon: 10, lat: 10 }));
  assert.deepEqual(s.vertices[0], { lon: 10, lat: 10 });
  assert.equal(moveVertex(s, 5, { lon: 0, lat: 0 }), false);
  assert.equal(moveVertex(s, 0, { lon: 999, lat: 0 }), false);
});

test('edit: removeVertex and insertVertex', () => {
  const s = createGeofenceSession();
  addVertex(s, { lon: 0, lat: 0 });
  addVertex(s, { lon: 1, lat: 0 });
  addVertex(s, { lon: 1, lat: 1 });
  addVertex(s, { lon: 0, lat: 1 });
  assert.ok(removeVertex(s, 1));
  assert.equal(s.vertices.length, 3);
  assert.ok(insertVertex(s, 1, { lon: 0.5, lat: 0 }));
  assert.equal(s.vertices.length, 4);
  assert.deepEqual(s.vertices[1], { lon: 0.5, lat: 0 });
});

test('clear: empties session', () => {
  const s = createGeofenceSession();
  addVertex(s, { lon: 0, lat: 0 });
  addVertex(s, { lon: 1, lat: 0 });
  clearSession(s);
  assert.equal(s.vertices.length, 0);
  assert.equal(canFinish(s), false);
});

test('geojson: round-trips a closed polygon', () => {
  const s = createGeofenceSession();
  addVertex(s, { lon: 0, lat: 0 });
  addVertex(s, { lon: 1, lat: 0 });
  addVertex(s, { lon: 0, lat: 1 });
  const gj = toGeoJSON(s);
  assert.equal(gj.type, 'Feature');
  assert.equal(gj.geometry.type, 'Polygon');
  assert.equal(gj.geometry.coordinates[0].length, 4);
  const back = fromGeoJSON(gj);
  assert.ok(back);
  assert.equal(back.vertices.length, 3);
});

test('area: small triangle has positive area', () => {
  const s = createGeofenceSession();
  addVertex(s, { lon: 0, lat: 0 });
  addVertex(s, { lon: 0.01, lat: 0 });
  addVertex(s, { lon: 0, lat: 0.01 });
  const a = ringAreaM2(s.vertices);
  assert.ok(a > 1000, `expected area > 1000, got ${a}`);
});

test('backspace: removeLastVertex', () => {
  const s = createGeofenceSession();
  addVertex(s, { lon: 0, lat: 0 });
  addVertex(s, { lon: 1, lat: 0 });
  assert.ok(removeLastVertex(s));
  assert.equal(s.vertices.length, 1);
  assert.ok(removeLastVertex(s));
  assert.equal(removeLastVertex(s), false);
});
