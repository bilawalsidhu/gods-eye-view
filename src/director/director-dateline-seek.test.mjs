import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraAtProgress } from './timeline.js';
const camera = (lon) => ({
  lat: 10,
  lon,
  alt: 1000,
  heading: 0,
  pitch: -40,
  roll: 0,
});
test('director seek follows the short dateline arc in both directions', () => {
  for (const [a, b] of [
    [179, -179],
    [-179, 179],
  ]) {
    assert.equal(
      Math.abs(cameraAtProgress(camera(a), camera(b), 0.5).lon),
      180,
    );
    assert.equal(cameraAtProgress(camera(a), camera(b), 0).lon, a);
    assert.equal(cameraAtProgress(camera(a), camera(b), 1).lon, b);
    assert.ok(Math.abs(cameraAtProgress(camera(a), camera(b), 0.25).lon) > 179);
  }
  assert.equal(cameraAtProgress(camera(20), camera(24), 0.5).lon, 22);
});

test('director seek keeps exact ±180 endpoints and picks the short arc near the antipode', () => {
  for (const [a, b] of [
    [180, -180],
    [-180, 180],
  ]) {
    assert.equal(cameraAtProgress(camera(a), camera(b), 0).lon, a);
    assert.equal(cameraAtProgress(camera(a), camera(b), 1).lon, b);
    assert.equal(
      Math.abs(cameraAtProgress(camera(a), camera(b), 0.5).lon),
      180,
    );
  }
  // 10°E to 169.9°W is 179.9° westward through Greenwich, not 180.1° east.
  const mid = cameraAtProgress(camera(10), camera(-169.9), 0.5).lon;
  assert.ok(mid > -81 && mid < -79, `short arc midpoint, got ${mid}`);
});

test('director seek turns heading and roll the short way for any authored angles', () => {
  const pose = (heading, roll) => ({ ...camera(0), heading, roll });
  const mid = cameraAtProgress(pose(350, 350), pose(-350, -350), 0.5);
  // 350° and -350° are 20° apart through 0°/360°, not 340° through 180°.
  for (const value of [mid.heading, mid.roll]) {
    const wrapped = ((value % 360) + 360) % 360;
    assert.ok(wrapped < 1e-9 || 360 - wrapped < 1e-9, `got ${value}`);
  }
});
