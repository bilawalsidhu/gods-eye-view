import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextLine,
  linePointWithinRadius,
  linePointInRect,
} from './contextGeometry.js';

test('out-of-range vertices are excluded from rectangle and radius queries', () => {
  const path = contextLine([
    { lat: 0, lon: 181 },
    { lat: 91, lon: 0 },
  ]);
  assert.deepEqual(path.points(), []);
  const start = performance.now();
  const center = { lat: 0, lon: 0 };
  assert.equal(
    linePointInRect([path], { west: -1, east: 1, south: -1, north: 1 }, center),
    null,
  );
  assert.equal(linePointWithinRadius([path], center, 100), null);
  assert.ok(performance.now() - start < 250);
});

test('spherical clipping uses the valid segment of a path with an out-of-range longitude', () => {
  const from = { lat: 0, lon: -2 };
  const to = { lat: 0, lon: 2 };
  const path = contextLine([from, { lat: 0, lon: 1e10 }, to]);
  assert.deepEqual(path.points(), [from, to]);

  const center = { lat: 0, lon: 0 };
  const start = performance.now();
  const point = linePointInRect(
    [path],
    { west: -1, east: 1, south: -1, north: 1 },
    center,
    true,
  );
  assert.ok(performance.now() - start < 250);
  assert.equal(point.lat, 0);
  assert.ok(Math.abs(point.lon) < 0.001);
});
