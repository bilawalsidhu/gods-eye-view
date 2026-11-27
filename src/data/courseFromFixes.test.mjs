import test from 'node:test';
import assert from 'node:assert/strict';
import { courseFromFixes } from './courseFromFixes.js';

/** The course read from an anchor at (lat1, lon1) to a fix two seconds later. */
const course = (lat1, lon1, lat2, lon2) =>
  courseFromFixes(
    { lat: lat1, lon: lon1, ms: 0 },
    { lat: lat2, lon: lon2, ms: 2000 },
  ).courseDeg;

test('course between fixes reads true bearings, across the antimeridian too', () => {
  assert.ok(Math.abs(course(0, 0, 0, 0.01) - 90) < 1e-6);
  assert.ok(Math.abs(course(0, 0, -0.01, 0) - 180) < 1e-6);
  assert.ok(Math.abs(course(0, 179.9997, 0, -179.9997) - 90) < 1e-6);
  assert.equal(course(30, -97, 30.0001, -97), null, 'about 11 m');
});

test('the anchor moves only with a course, and only forward in time', () => {
  let state = courseFromFixes(null, { lat: 0, lon: 0, ms: 0 });
  assert.equal(state.courseDeg, null);
  assert.deepEqual(state.anchor, { lat: 0, lon: 0, ms: 0 });
  const first = state.anchor;
  state = courseFromFixes(first, { lat: 0, lon: 0.0001, ms: 1000 });
  assert.equal(state.courseDeg, null, '11 m: no course');
  assert.equal(state.anchor, first, 'the anchor stays');
  state = courseFromFixes(first, { lat: 0, lon: 0.0005, ms: 500 });
  assert.equal(state.courseDeg, null, 'not a second newer');
  state = courseFromFixes(first, {
    lat: 0,
    lon: 0.0005,
    ms: 2000,
    speedMps: 1,
  });
  assert.equal(state.courseDeg, null, 'standing');
  state = courseFromFixes(first, {
    lat: 0,
    lon: 0.0005,
    ms: 2000,
    speedMps: 8,
  });
  assert.ok(Math.abs(state.courseDeg - 90) < 1e-6);
  assert.deepEqual(state.anchor, { lat: 0, lon: 0.0005, ms: 2000 });
  state = courseFromFixes(first, { lat: NaN, lon: 0, ms: 3000 });
  assert.equal(state.anchor, first);
});
