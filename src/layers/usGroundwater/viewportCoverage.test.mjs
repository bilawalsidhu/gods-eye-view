import test from 'node:test';
import assert from 'node:assert/strict';
import { coversViewport } from './viewportCoverage.js';
test('inward wheel zoom can use completed exact coverage; pans and outward zoom cannot', () => {
  assert.equal(coversViewport([-100, 20, -90, 40], [-98, 25, -94, 30]), true);
  assert.equal(coversViewport([-100, 20, -90, 40], [-98, 25, -89, 30]), false);
  assert.equal(coversViewport([-100, 20, -90, 40], [-110, 10, -80, 50]), false);
  assert.equal(coversViewport([170, -10, -170, 10], [175, -5, -175, 5]), true);
  assert.equal(coversViewport([170, -10, -170, 10], [-10, -5, 10, 5]), false);
  assert.equal(coversViewport([-180, -90, 180, 90], [175, -5, -175, 5]), true);
  assert.equal(coversViewport(null, [-10, -5, 10, 5]), false);
});
