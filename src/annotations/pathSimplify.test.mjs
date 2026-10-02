// Track simplification: a long recording comes under the ceiling by losing the
// points that lie on the line anyway, not the corners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simplifyPath } from './pathSimplify.js';

test('a path already under the ceiling is returned as the same array', () => {
  const points = [
    [0, 0],
    [1, 1],
    [2, 0],
  ];
  assert.equal(simplifyPath(points, 3), points);
  assert.equal(simplifyPath(points, 100), points);
});

test('collinear points are dropped and the corner is kept', () => {
  // 1,000 points east along the equator, then 1,000 north: an L.
  const points = [];
  for (let i = 0; i <= 1000; i += 1) points.push([i * 1e-4, 0]);
  for (let i = 1; i <= 1000; i += 1) points.push([0.1, i * 1e-4]);
  const out = simplifyPath(points, 10);
  assert.ok(out.length <= 10);
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out[out.length - 1], [0.1, 0.1]);
  assert.ok(
    out.some(([lon, lat]) => lon === 0.1 && lat === 0),
    'the corner of the L must survive',
  );
});

test('the ceiling holds for a noisy path and the ends are preserved', () => {
  const points = [];
  for (let i = 0; i < 20000; i += 1)
    points.push([8 + i * 1e-5, 46 + Math.sin(i / 7) * 1e-4]);
  const out = simplifyPath(points, 500);
  assert.ok(out.length <= 500, `kept ${out.length}`);
  assert.ok(out.length > 50, 'a wiggly path keeps real detail');
  assert.deepEqual(out[0], points[0]);
  assert.deepEqual(out[out.length - 1], points[points.length - 1]);
});

test('kept points are a subsequence of the input, in order', () => {
  const points = [];
  for (let i = 0; i < 5000; i += 1)
    points.push([i * 1e-4, Math.cos(i / 40) * 0.01]);
  const out = simplifyPath(points, 200);
  let cursor = 0;
  for (const point of out) {
    cursor = points.indexOf(point, cursor);
    assert.ok(cursor >= 0, 'every output point is an input point, in order');
  }
});

test('a track across the antimeridian is not treated as 360° wide', () => {
  // A straight eastward line through 180°: every interior point is collinear.
  const points = [];
  for (let i = 0; i <= 2000; i += 1) {
    const lon = 179.9 + i * 1e-4;
    points.push([lon > 180 ? lon - 360 : lon, 10]);
  }
  const out = simplifyPath(points, 50);
  assert.equal(out.length, 2, 'a straight line needs only its ends');
});

test('a closed ring keeps its closing point', () => {
  const ring = [];
  for (let i = 0; i < 3600; i += 1) {
    const a = (i / 3600) * 2 * Math.PI;
    ring.push([Math.cos(a) * 0.01, Math.sin(a) * 0.01]);
  }
  ring.push(ring[0]);
  const out = simplifyPath(ring, 100);
  assert.ok(out.length <= 100 && out.length >= 8);
  assert.deepEqual(out[0], out[out.length - 1]);
});

test('a path far over its ceiling is still bounded and quick', () => {
  const points = [];
  for (let i = 0; i < 300000; i += 1) points.push([i * 1e-6, (i % 2) * 1e-3]);
  const started = Date.now();
  const out = simplifyPath(points, 100);
  assert.ok(out.length <= 100);
  assert.ok(Date.now() - started < 5000, 'pathological input stays bounded');
});

test('a ceiling below two is treated as two', () => {
  const points = [
    [0, 0],
    [1, 5],
    [2, 0],
  ];
  assert.deepEqual(simplifyPath(points, 0), [
    [0, 0],
    [2, 0],
  ]);
});
