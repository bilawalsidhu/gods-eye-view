import test from 'node:test';
import assert from 'node:assert/strict';
import { imageryTilePlan } from './imagery.js';

const r = Math.PI / 180;

test('a view across the antimeridian plans the tiles it shows, not the whole source', () => {
  // A view over Fiji, one degree wide across 180°.
  const view = {
    west: 179.5 * r,
    east: -179.5 * r,
    south: -17 * r,
    north: -16 * r,
  };
  const global = { west: -180, east: 180, south: -85, north: 85 };
  const plan = imageryTilePlan(global, view, 10);
  // The same view one degree west (not crossing) plans level 10.
  assert.ok(
    plan.z >= 9,
    `planned level ${plan.z}, a ${plan.width}×${plan.height} mosaic`,
  );
});

test('antimeridian plans intersect each side of the source in both tilings', () => {
  const view = {
    west: 179.5 * r,
    east: -179.5 * r,
    south: -17 * r,
    north: -16 * r,
  };
  for (const scheme of ['webMercator', 'geographic']) {
    const columns = 2 ** (10 + (scheme === 'geographic' ? 1 : 0));
    const global = { west: -180, east: 180, south: -85, north: 85 };
    const plan = imageryTilePlan(global, view, 10, scheme);
    assert.equal(plan.z, 10);
    assert.ok(plan.x < columns && plan.x + plan.width > columns);
    const west = imageryTilePlan({ ...global, west: 179 }, view, 10, scheme);
    assert.ok(west.x + west.width <= columns);
    const east = imageryTilePlan({ ...global, east: -179 }, view, 10, scheme);
    assert.ok(east.x >= columns);
    assert.equal(
      imageryTilePlan({ ...global, west: 0, east: 10 }, view, 10, scheme),
      null,
    );
  }
});
